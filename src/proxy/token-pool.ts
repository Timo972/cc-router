import type { Account, AccountRecord, RouteContext } from "./types.js";
import { DEFAULT_RATE_LIMITS, ACCOUNT_USER_DEFAULTS, clampPercent } from "./types.js";
import { canUseExtraUsage } from "../providers/anthropic/usage.js";

export class EmptyPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyPoolError";
  }
}

export class NoEligibleAccountError extends Error {
  readonly reason: "rate_limited" | "unavailable";
  readonly retryAtMs?: number;
  readonly blockedAccounts: number;

  constructor(
    reason: "rate_limited" | "unavailable",
    blockedAccounts: number,
    retryAtMs?: number,
  ) {
    super("no account is currently eligible for routing");
    this.name = "NoEligibleAccountError";
    this.reason = reason;
    this.blockedAccounts = blockedAccounts;
    if (retryAtMs !== undefined) this.retryAtMs = retryAtMs;
  }
}

interface CapacityWindow {
  utilization: number;
  resetAt: number;
}

interface HardBlock {
  reason: "rate_limited" | "unavailable";
  retryAtMs?: number;
}

/**
 * Returns the reset timestamp (seconds) that must pass before the account
 * stops being rate_limited. Prefers the `claim` window (the one Anthropic
 * said was actually limiting); when the claim is absent, all known windows
 * must reset, so the latest non-zero reset is the complete unblock time.
 * Returns 0 when no reset is known.
 */
function limitingReset(a: Account): number {
  const r = a.rateLimits;
  if (r.claim === "five_hour" && r.fiveHourReset) return r.fiveHourReset;
  if (r.claim === "seven_day" && r.sevenDayReset) return r.sevenDayReset;
  return Math.max(r.fiveHourReset, r.sevenDayReset, 0);
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
  let recovered = false;

  if (r.fiveHourReset > 0 && nowSec >= r.fiveHourReset) {
    r.fiveHourUtil = 0;
    r.fiveHourReset = 0;
  }
  if (r.sevenDayReset > 0 && nowSec >= r.sevenDayReset) {
    r.sevenDayUtil = 0;
    r.sevenDayReset = 0;
  }

  const usage = r.usage;
  if (usage) {
    for (const window of [usage.fiveHour, usage.sevenDay]) {
      if (window && window.resetAt > 0 && nowSec >= window.resetAt) {
        window.utilization = 0;
        window.resetAt = 0;
      }
    }
    for (const limit of usage.modelLimits) {
      if (limit.resetAt > 0 && nowSec >= limit.resetAt) {
        limit.utilization = 0;
        limit.resetAt = 0;
      }
    }
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
    }
  }

  if (recovered && onExpired) onExpired(a);
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
   * User caps are advisory and may be bypassed when every hard-eligible
   * account is capped. Upstream exhaustion, cooldown, disabled state, and
   * unhealthy state are hard blocks and are never bypassed.
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
  acquireBest(activeSessions: ReadonlyMap<string, number>, context?: RouteContext): AccountLease {
    if (this.accounts.length === 0) {
      throw new EmptyPoolError("token pool is empty — add an account first");
    }

    this.sweepExpiredCooldowns();
    const hardBlocks = new Map<Account, HardBlock>();
    const hardEligible = this.accounts.filter(account => {
      const block = this.hardBlock(account, context);
      if (block) hardBlocks.set(account, block);
      return block === null;
    });
    const withinUserCaps = hardEligible.filter(account => !this.overUserCap(account));

    if (withinUserCaps.length > 0) {
      const account = this.selectEligible(withinUserCaps, activeSessions, context);
      this.advanceCursor(account);
      return this.createLease(account, false);
    }

    if (hardEligible.length > 0) {
      const account = this.selectEligible(hardEligible, activeSessions, context);
      this.advanceCursor(account);
      this.onCapBypass?.(account);
      return this.createLease(account, true);
    }

    const rateLimited = [...hardBlocks.values()].filter(block => block.reason === "rate_limited");
    const retryTimes = rateLimited
      .map(block => block.retryAtMs)
      .filter((retryAtMs): retryAtMs is number => retryAtMs !== undefined);
    const retryAtMs = retryTimes.length > 0 ? Math.min(...retryTimes) : undefined;
    throw new NoEligibleAccountError(
      rateLimited.length > 0 ? "rate_limited" : "unavailable",
      this.accounts.length,
      retryAtMs,
    );
  }

  /** Acquire a specific account for an existing sticky session. */
  tryAcquire(accountId: string, context?: RouteContext): AccountLease | null {
    const account = this.findById(accountId);
    if (!account) return null;
    clearExpiredRateLimitWindows(account, this.now(), this.onCooldownExpired);
    if (this.hardBlock(account, context) || this.overUserCap(account)) return null;
    return this.createLease(account, false);
  }

  isEligible(accountId: string, context?: RouteContext): boolean {
    const account = this.findById(accountId);
    if (!account) return false;
    clearExpiredRateLimitWindows(account, this.now(), this.onCooldownExpired);
    return this.hardBlock(account, context) === null && !this.overUserCap(account);
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

  private hardBlock(account: Account, context?: RouteContext): HardBlock | null {
    if (!account.enabled || !account.healthy) return { reason: "unavailable" };

    const nowMs = this.now();
    const timedBlockers: number[] = [];
    let hasIndefiniteBlocker = false;
    let rateLimited = false;

    if (this.isCoolingDown(account.id)) {
      rateLimited = true;
      const cooldownExpiry = this.cooldownUntil.get(account.id);
      if (cooldownExpiry !== undefined) timedBlockers.push(cooldownExpiry);
      else hasIndefiniteBlocker = true;
    }

    if (account.rateLimits.status === "rate_limited") {
      rateLimited = true;
      const resetAt = limitingReset(account) * 1_000;
      if (resetAt > nowMs) timedBlockers.push(resetAt);
      else hasIndefiniteBlocker = true;
    }

    const exhausted = [
      ...this.globalWindows(account),
      ...this.matchingModelWindows(account, context),
    ].filter(window => window.utilization >= 1);
    if (exhausted.length > 0 && !this.canUsePaidExtra(account)) {
      rateLimited = true;
      for (const window of exhausted) {
        const resetAt = window.resetAt * 1_000;
        if (resetAt > nowMs) timedBlockers.push(resetAt);
        else hasIndefiniteBlocker = true;
      }
    }

    if (!rateLimited) return null;
    const retryAtMs = !hasIndefiniteBlocker && timedBlockers.length > 0
      ? Math.max(...timedBlockers)
      : undefined;
    return retryAtMs === undefined
      ? { reason: "rate_limited" }
      : { reason: "rate_limited", retryAtMs };
  }

  private overUserCap(account: Account): boolean {
    const [fiveHour, sevenDay] = this.globalWindows(account);
    return fiveHour.utilization * 100 >= account.sessionLimitPercent ||
      sevenDay.utilization * 100 >= account.weeklyLimitPercent;
  }

  private globalWindows(account: Account): [CapacityWindow, CapacityWindow] {
    const headers: [CapacityWindow, CapacityWindow] = [
      {
        utilization: this.safeUtilization(account.rateLimits.fiveHourUtil),
        resetAt: this.safeResetAt(account.rateLimits.fiveHourReset),
      },
      {
        utilization: this.safeUtilization(account.rateLimits.sevenDayUtil),
        resetAt: this.safeResetAt(account.rateLimits.sevenDayReset),
      },
    ];
    const usage = account.rateLimits.usage;
    if (!usage || usage.fetchStatus === "unavailable" || usage.fetchedAt < account.rateLimits.lastUpdated) {
      return headers;
    }
    return [
      usage.fiveHour
        ? {
            utilization: this.safeUtilization(usage.fiveHour.utilization),
            resetAt: this.safeResetAt(usage.fiveHour.resetAt),
          }
        : headers[0],
      usage.sevenDay
        ? {
            utilization: this.safeUtilization(usage.sevenDay.utilization),
            resetAt: this.safeResetAt(usage.sevenDay.resetAt),
          }
        : headers[1],
    ];
  }

  private matchingModelWindows(account: Account, context?: RouteContext): CapacityWindow[] {
    const usage = account.rateLimits.usage;
    if (!usage || usage.fetchStatus === "unavailable") return [];
    const requestedModel = context?.requestedModel;
    const modelFamily = context?.modelFamily;
    if (!requestedModel && !modelFamily) return [];

    return usage.modelLimits
      .filter(limit =>
        (modelFamily !== undefined && limit.modelFamily === modelFamily) ||
        (requestedModel !== undefined && limit.modelId === requestedModel),
      )
      .map(limit => ({
        utilization: this.safeUtilization(limit.utilization),
        resetAt: this.safeResetAt(limit.resetAt),
      }));
  }

  private canUsePaidExtra(account: Account): boolean {
    const usage = account.rateLimits.usage;
    return usage?.fetchStatus === "fresh" &&
      usage.fetchedAt >= account.rateLimits.lastUpdated &&
      canUseExtraUsage(usage.extraUsage);
  }

  private usesPaidExtra(account: Account, context?: RouteContext): boolean {
    if (!this.canUsePaidExtra(account)) return false;
    return [...this.globalWindows(account), ...this.matchingModelWindows(account, context)]
      .some(window => window.utilization >= 1);
  }

  private safeUtilization(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  private safeResetAt(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : 0;
  }

  private selectEligible(
    candidates: Account[],
    activeSessions: ReadonlyMap<string, number>,
    context?: RouteContext,
  ): Account {
    return candidates.reduce((best, account) => {
      const comparison = this.compareTuple(
        [
          this.getInFlight(account.id),
          activeSessions.get(account.id) ?? 0,
          this.usesPaidExtra(account, context) ? 1 : 0,
          this.headroomScore(account, context),
          this.circularDistance(account),
        ],
        [
          this.getInFlight(best.id),
          activeSessions.get(best.id) ?? 0,
          this.usesPaidExtra(best, context) ? 1 : 0,
          this.headroomScore(best, context),
          this.circularDistance(best),
        ],
      );
      return comparison < 0 ? account : best;
    });
  }

  private headroomScore(account: Account, context?: RouteContext): number {
    const windows = [...this.globalWindows(account), ...this.matchingModelWindows(account, context)];
    return Math.max(0, ...windows.map(window => window.utilization));
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
