import type { Account, AccountRecord } from "./types.js";
import { DEFAULT_RATE_LIMITS, ACCOUNT_USER_DEFAULTS, clampPercent } from "./types.js";

export class EmptyPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyPoolError";
  }
}

/** Returns the earliest non-zero reset timestamp (seconds) for an account. */
function earliestReset(a: Account): number {
  const r = a.rateLimits;
  if (r.fiveHourReset && r.sevenDayReset) return Math.min(r.fiveHourReset, r.sevenDayReset);
  return r.fiveHourReset || r.sevenDayReset || Infinity;
}

/**
 * Returns the reset timestamp (seconds) that must pass before the account
 * stops being rate_limited. Prefers the `claim` window (the one Anthropic
 * said was actually limiting); falls back to the earliest non-zero reset.
 * Returns 0 when no reset is known.
 */
function limitingReset(a: Account): number {
  const r = a.rateLimits;
  if (r.claim === "five_hour" && r.fiveHourReset) return r.fiveHourReset;
  if (r.claim === "seven_day" && r.sevenDayReset) return r.sevenDayReset;
  const earliest = earliestReset(a);
  return Number.isFinite(earliest) ? earliest : 0;
}

/**
 * Roll over any rate-limit window whose reset timestamp has passed.
 *
 * `rateLimits` is a snapshot of Anthropic's response headers — utilization
 * values only refresh when a new response arrives. That creates a stuck
 * state in two scenarios:
 *
 *   1. `status: "rate_limited"` — the pool refuses to route to the account,
 *      so no new response ever updates the status.
 *   2. `fiveHourUtil` / `sevenDayUtil` at or above the user cap — `overUserCap`
 *      evicts the account from rotation, so the util stays stale at its last
 *      recorded value instead of dropping to ~0 when Anthropic's window resets.
 *
 * This sweep resolves both: when `now >= reset` for a window, the util is
 * zeroed and the window's reset timestamp is cleared. When the limiting
 * window expires, `status` flips back to `"allowed"`. The callback fires
 * once per recovery so the dashboard can surface it.
 */
function clearExpiredRateLimitWindows(
  a: Account,
  nowMs: number,
  onExpired?: (a: Account) => void,
): void {
  const nowSec = Math.floor(nowMs / 1000);
  const r = a.rateLimits;
  let changed = false;
  let recovered = false;

  if (r.fiveHourReset > 0 && nowSec >= r.fiveHourReset) {
    r.fiveHourUtil = 0;
    r.fiveHourReset = 0;
    changed = true;
  }
  if (r.sevenDayReset > 0 && nowSec >= r.sevenDayReset) {
    r.sevenDayUtil = 0;
    r.sevenDayReset = 0;
    changed = true;
  }

  // If the account was rate_limited and its claimed window just reset,
  // return it to rotation. If we can't tell which window was limiting
  // (empty claim) but all known windows have rolled over, clear the flag.
  if (r.status === "rate_limited") {
    const stillBlocked =
      (r.claim === "five_hour" && r.fiveHourReset > 0) ||
      (r.claim === "seven_day" && r.sevenDayReset > 0) ||
      (r.claim === "" && (r.fiveHourReset > 0 || r.sevenDayReset > 0));
    if (!stillBlocked) {
      r.status = "allowed";
      recovered = true;
      changed = true;
    }
  }

  if (changed) r.lastUpdated = nowMs;
  if (recovered && onExpired) onExpired(a);
}

/** True when the account's user-defined caps have been reached. */
function overUserCap(a: Account): boolean {
  return (
    a.rateLimits.fiveHourUtil * 100 >= a.sessionLimitPercent ||
    a.rateLimits.sevenDayUtil * 100 >= a.weeklyLimitPercent
  );
}

/** Filter out accounts the user has taken out of the rotation. */
function isUsable(a: Account): boolean {
  return a.enabled && !overUserCap(a);
}

export interface AccountPatch {
  enabled?: boolean;
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
}

export interface AccountLease {
  readonly account: Account;
  readonly fallback: boolean;
  release(): void;
}

export interface TokenPoolOptions {
  now?: () => number;
}

export class TokenPool {
  private readonly inFlight = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly now: () => number;
  private currentIndex = 0;

  constructor(private readonly accounts: Account[], options: TokenPoolOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Compatibility wrapper for request sites that do not yet retain leases.
   * Selection considers accounts that are:
   *   • healthy
   *   • not busy
   *   • not rate-limited by Anthropic
   *   • enabled (user toggle)
   *   • under the user-configured 5h/7d caps
   *
   * Fallback chain when nothing is available:
   *   1. Any healthy+usable (enabled & under caps) account — pick earliest reset.
   *   2. Any healthy account — pick earliest reset. This intentionally ignores
   *      user caps when every option is capped; limits are advisory, not a hard
   *      ban that would leave Claude Code with no working account. The fallback
   *      is logged via the optional onCapBypass callback so the dashboard can
   *      surface it instead of silently exceeding the cap.
   *   3. Any account as a last resort (only if every account is unhealthy).
   *
   * Fallback sets prefer the lowest in-flight load, then the earliest reset.
   *
   * Throws `EmptyPoolError` when there are no accounts at all — callers in
   * the request path should map this to a 503. The DELETE endpoint guards
   * against this state by refusing to remove the last account.
   */
  getNext(): Account {
    const lease = this.acquireBest(new Map());
    lease.release();
    return lease.account;
  }

  /**
   * Acquire the best eligible account using load, session affinity pressure,
   * rate-limit headroom, and a rotating tie-break, in that order.
   */
  acquireBest(activeSessions: ReadonlyMap<string, number>): AccountLease {
    if (this.accounts.length === 0) {
      throw new EmptyPoolError("token pool is empty — add an account first");
    }

    this.sweepExpiredCooldowns();
    const eligible = this.accounts.filter(account => this.isEligibleWithoutSweep(account));

    if (eligible.length > 0) {
      const account = this.selectEligible(eligible, activeSessions);
      this.advanceCursor(account);
      return this.createLease(account, false);
    }

    const healthyUsable = this.accounts.filter(account => account.healthy && isUsable(account));
    const healthy = this.accounts.filter(account => account.healthy);
    const fallbackCandidates = healthyUsable.length > 0
      ? healthyUsable
      : healthy.length > 0
        ? healthy
        : this.accounts;
    const account = this.selectFallback(fallbackCandidates);
    this.advanceCursor(account);
    if (overUserCap(account)) this.onCapBypass?.(account);
    return this.createLease(account, true);
  }

  /** Acquire a specific account for an existing sticky session. */
  tryAcquire(accountId: string): AccountLease | null {
    const account = this.findById(accountId);
    if (!account) return null;
    clearExpiredRateLimitWindows(account, this.now(), this.onCooldownExpired);
    if (!this.isEligibleWithoutSweep(account)) return null;
    return this.createLease(account, false);
  }

  isEligible(accountId: string): boolean {
    const account = this.findById(accountId);
    if (!account) return false;
    clearExpiredRateLimitWindows(account, this.now(), this.onCooldownExpired);
    return this.isEligibleWithoutSweep(account);
  }

  getInFlight(accountId: string): number {
    return this.inFlight.get(accountId) ?? 0;
  }

  setCooldown(accountId: string, durationMs: number): void {
    const account = this.findById(accountId);
    if (!account) return;
    this.setCooldownForAccount(account, durationMs);
  }

  /** Apply cooldown only to the exact account incarnation that was routed. */
  setCooldownForAccount(account: Account, durationMs: number): void {
    if (this.findById(account.id) !== account) return;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    const proposedExpiry = this.now() + durationMs;
    const existingExpiry = this.cooldownUntil.get(account.id) ?? 0;
    this.cooldownUntil.set(account.id, Math.max(existingExpiry, proposedExpiry));
  }

  isCoolingDown(accountId: string): boolean {
    const until = this.cooldownUntil.get(accountId);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.cooldownUntil.delete(accountId);
    return false;
  }

  private isEligibleWithoutSweep(account: Account): boolean {
    return account.healthy &&
      !account.busy &&
      !this.isCoolingDown(account.id) &&
      account.rateLimits.status !== "rate_limited" &&
      isUsable(account);
  }

  private selectEligible(
    candidates: Account[],
    activeSessions: ReadonlyMap<string, number>,
  ): Account {
    return candidates.reduce((best, account) => {
      const comparison = this.compareTuple(
        [
          this.getInFlight(account.id),
          activeSessions.get(account.id) ?? 0,
          this.headroomScore(account),
          this.circularDistance(account),
        ],
        [
          this.getInFlight(best.id),
          activeSessions.get(best.id) ?? 0,
          this.headroomScore(best),
          this.circularDistance(best),
        ],
      );
      return comparison < 0 ? account : best;
    });
  }

  private selectFallback(candidates: Account[]): Account {
    return candidates.reduce((best, account) => {
      const comparison = this.compareTuple(
        [this.getInFlight(account.id), earliestReset(account), this.circularDistance(account)],
        [this.getInFlight(best.id), earliestReset(best), this.circularDistance(best)],
      );
      return comparison < 0 ? account : best;
    });
  }

  private headroomScore(account: Account): number {
    const fiveHourCap = account.sessionLimitPercent / 100;
    const sevenDayCap = account.weeklyLimitPercent / 100;
    const fiveHourUtil = Number.isFinite(account.rateLimits.fiveHourUtil)
      ? Math.max(0, account.rateLimits.fiveHourUtil)
      : 0;
    const sevenDayUtil = Number.isFinite(account.rateLimits.sevenDayUtil)
      ? Math.max(0, account.rateLimits.sevenDayUtil)
      : 0;
    return Math.max(fiveHourUtil / fiveHourCap, sevenDayUtil / sevenDayCap);
  }

  private circularDistance(account: Account): number {
    const index = this.accounts.indexOf(account);
    return (index - this.currentIndex + this.accounts.length) % this.accounts.length;
  }

  private compareTuple(left: number[], right: number[]): number {
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return left[i] - right[i];
    }
    return 0;
  }

  private advanceCursor(account: Account): void {
    const index = this.accounts.indexOf(account);
    this.currentIndex = (index + 1) % this.accounts.length;
  }

  private createLease(account: Account, fallback: boolean): AccountLease {
    this.inFlight.set(account.id, this.getInFlight(account.id) + 1);
    account.requestCount++;
    account.lastUsed = this.now();
    let released = false;
    return {
      account,
      fallback,
      release: () => {
        if (released) return;
        released = true;
        // IDs may be reused after an account is removed. A lease belongs to
        // the exact Account instance it acquired and must never decrement a
        // replacement account's load counter.
        if (this.findById(account.id) !== account) return;
        const remaining = Math.max(0, this.getInFlight(account.id) - 1);
        if (remaining === 0) this.inFlight.delete(account.id);
        else this.inFlight.set(account.id, remaining);
      },
    };
  }

  /** Optional listener fired when a request is routed to a capped account
   *  because every account in the pool was over its user-configured cap. */
  public onCapBypass?: (account: Account) => void;

  /** Optional listener fired when a rate-limited account's cooldown expires
   *  and it is automatically returned to the rotation. */
  public onCooldownExpired?: (account: Account) => void;

  /**
   * Sweep the pool for accounts whose rate_limited cooldown has passed and
   * clear the flag in place. Intended for periodic calls from the dashboard
   * poll loop so the UI reflects recovery without waiting for a new request.
   */
  sweepExpiredCooldowns(): void {
    const now = this.now();
    for (const a of this.accounts) {
      clearExpiredRateLimitWindows(a, now, this.onCooldownExpired);
      this.isCoolingDown(a.id);
    }
  }

  getAll(): Account[] {
    return this.accounts;
  }

  getHealthy(): Account[] {
    return this.accounts.filter(a => a.healthy);
  }

  getStats() {
    return this.accounts.map(a => ({
      id: a.id,
      healthy: a.healthy,
      busy: a.busy,
      inFlightRequests: this.getInFlight(a.id),
      coolingDown: this.isCoolingDown(a.id),
      requestCount: a.requestCount,
      errorCount: a.errorCount,
      expiresInMs: a.tokens.expiresAt - Date.now(),
      lastUsedMs: a.lastUsed,
      lastRefreshMs: a.lastRefresh,
      rateLimits: a.rateLimits,
      enabled: a.enabled,
      sessionLimitPercent: a.sessionLimitPercent,
      weeklyLimitPercent: a.weeklyLimitPercent,
    }));
  }

  // ─── Mutation API (used by the authenticated HTTP endpoints) ───────────────

  findById(id: string): Account | null {
    return this.accounts.find(a => a.id === id) ?? null;
  }

  /**
   * Apply a partial update to an account's user-controlled fields.
   * Only `enabled`, `sessionLimitPercent`, and `weeklyLimitPercent` are
   * touched — token fields are never accepted via this API.
   * Returns the updated account, or null if the id was not found.
   */
  updateAccount(id: string, patch: AccountPatch): Account | null {
    const a = this.findById(id);
    if (!a) return null;
    if (patch.enabled !== undefined) a.enabled = !!patch.enabled;
    if (patch.sessionLimitPercent !== undefined) {
      a.sessionLimitPercent = clampPercent(patch.sessionLimitPercent);
    }
    if (patch.weeklyLimitPercent !== undefined) {
      a.weeklyLimitPercent = clampPercent(patch.weeklyLimitPercent);
    }
    return a;
  }

  /**
   * Append a new account built from a persisted AccountRecord.
   * Rejects duplicates by id — callers should pre-check with findById().
   */
  addAccount(record: AccountRecord): Account {
    if (this.findById(record.id)) {
      throw new Error(`Account "${record.id}" already exists`);
    }
    const account: Account = {
      id: record.id,
      tokens: {
        accessToken: record.accessToken,
        refreshToken: record.refreshToken,
        expiresAt: record.expiresAt,
        scopes: record.scopes ?? ["user:inference", "user:profile"],
      },
      healthy: true,
      busy: false,
      requestCount: 0,
      errorCount: 0,
      lastUsed: 0,
      lastRefresh: 0,
      consecutiveErrors: 0,
      rateLimits: { ...DEFAULT_RATE_LIMITS },
      enabled: record.enabled !== false,
      sessionLimitPercent: record.sessionLimitPercent !== undefined
        ? clampPercent(record.sessionLimitPercent)
        : ACCOUNT_USER_DEFAULTS.sessionLimitPercent,
      weeklyLimitPercent: record.weeklyLimitPercent !== undefined
        ? clampPercent(record.weeklyLimitPercent)
        : ACCOUNT_USER_DEFAULTS.weeklyLimitPercent,
    };
    this.accounts.push(account);
    return account;
  }

  /**
   * Remove an account by id. Returns true if something was removed.
   *
   * CRITICAL: mutates `this.accounts` IN PLACE via splice() rather than
   * reassigning it. The server passes the same array reference to
   * `startRefreshLoop()` at startup; reassigning would desynchronize the
   * refresh loop from the pool, and the loop's `saveAccounts(accounts)` call
   * would later resurrect the deleted account on disk.
   */
  removeAccount(id: string): boolean {
    const idx = this.accounts.findIndex(a => a.id === id);
    if (idx === -1) return false;
    this.accounts.splice(idx, 1);
    this.inFlight.delete(id);
    this.cooldownUntil.delete(id);
    if (this.accounts.length > 0) {
      this.currentIndex = this.currentIndex % this.accounts.length;
    } else {
      this.currentIndex = 0;
    }
    return true;
  }
}
