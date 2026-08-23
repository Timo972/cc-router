import {
  EmptyPoolError,
  NoEligibleAccountError,
  type AccountLease,
  type AccountPool,
} from "../../proxy/account-pool.js";
import type { RouteContext } from "../../proxy/types.js";
import { bucketForModel, bucketIdForModel, sweepCodexRateLimits, type CodexCooldownCause, type OpenAIAccount } from "./account-state.js";
import { DEFAULT_CODEX_LIMIT_ID, type CodexLimitBucket, type CodexRateWindow } from "./usage.js";

const MAX_TRUSTED_RATE_LIMIT_RESET_MS = 8 * 24 * 60 * 60 * 1_000;
/** Matches the bucket-snapshot cap in account-state.ts: a real account has the
 *  default bucket plus a handful of metered ones, never dozens. */
const MAX_BUCKET_COOLDOWN_ENTRIES = 16;

interface OpenAICooldowns {
  /** When the account becomes routable again, whatever the reason. */
  globalUntil: number;
  /** How much of that is attributable to a spent quota. Tracked apart from
   *  the total because the two causes overlap freely: a 120s overload and a
   *  30s rate limit both apply, and folding them into one horizon would keep
   *  answering 429 for 90 seconds after the quota itself had cleared. */
  rateLimitedUntil: number;
  bucketUntil: Map<string, number>;
}

interface HardBlock {
  reason: "rate_limited" | "unavailable";
  retryAtMs?: number;
}

export interface OpenAICooldownView {
  globalUntilMs: number;
  bucketCooldowns: Array<{ limitId: string; untilMs: number }>;
}

export class OpenAITokenPool implements AccountPool<OpenAIAccount> {
  private readonly inFlight = new Map<string, number>();
  private readonly cooldowns = new Map<OpenAIAccount, OpenAICooldowns>();
  private readonly now: () => number;
  private currentIndex = 0;

  public onCapBypass?: (account: OpenAIAccount) => void;
  public onCooldownExpired?: (account: OpenAIAccount) => void;

  constructor(
    private readonly accounts: OpenAIAccount[],
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  acquireBest(
    activeSessions: ReadonlyMap<string, number>,
    context?: RouteContext,
  ): AccountLease<OpenAIAccount> {
    if (this.accounts.length === 0) {
      throw new EmptyPoolError("OpenAI token pool is empty — add an account first");
    }

    this.sweepExpiredCooldowns();
    const hardBlocks = new Map<OpenAIAccount, HardBlock>();
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
    throw new NoEligibleAccountError(
      rateLimited.length > 0 ? "rate_limited" : "unavailable",
      this.accounts.length,
      retryTimes.length > 0 ? Math.min(...retryTimes) : undefined,
    );
  }

  tryAcquire(accountId: string, context?: RouteContext): AccountLease<OpenAIAccount> | null {
    const account = this.findById(accountId);
    if (!account) return null;
    const now = this.now();
    sweepCodexRateLimits(account, now, { isRetained: limitId => this.isBucketCoolingDown(account, limitId, now) });
    this.clearExpiredCooldownState(account);
    if (this.hardBlock(account, context) || this.overUserCap(account)) return null;
    return this.createLease(account, false);
  }

  getInFlight(accountId: string): number {
    return this.inFlight.get(accountId) ?? 0;
  }

  setGlobalCooldownForAccount(
    account: OpenAIAccount,
    durationMs: number,
    cause: CodexCooldownCause,
  ): void {
    const expiry = this.proposedExpiry(account, durationMs);
    if (expiry === undefined) return;
    const state = this.cooldownsFor(account);
    // Each cause extends its own horizon, so neither can misrepresent the
    // other's duration in either direction.
    state.globalUntil = Math.max(state.globalUntil, expiry);
    if (cause === "rate_limit") state.rateLimitedUntil = Math.max(state.rateLimitedUntil, expiry);
  }

  setBucketCooldownForAccount(account: OpenAIAccount, limitId: string, durationMs: number): void {
    const expiry = this.proposedExpiry(account, durationMs);
    if (expiry === undefined) return;
    const state = this.cooldownsFor(account);
    if (!state.bucketUntil.has(limitId)) this.makeRoomForBucketCooldown(state);
    state.bucketUntil.set(limitId, Math.max(state.bucketUntil.get(limitId) ?? 0, expiry));
  }

  /**
   * Keep `bucketUntil` bounded before a new limit id is added. Every distinct
   * `x-codex-active-limit` value an upstream 429 reports creates an entry that
   * can live for up to the trust horizon, so without a cap a buggy (or
   * hostile) upstream cycling fresh ids would grow this map with request
   * volume — the bucket snapshots and model mappings are already capped, this
   * was the one unbounded piece of per-account state.
   *
   * Expired entries go first since they no longer block anything. If that is
   * not enough, the soonest-to-expire entry is dropped: it is the one with the
   * least protection left to lose.
   */
  private makeRoomForBucketCooldown(state: OpenAICooldowns): void {
    if (state.bucketUntil.size < MAX_BUCKET_COOLDOWN_ENTRIES) return;

    const now = this.now();
    for (const [limitId, until] of state.bucketUntil) {
      if (until <= now) state.bucketUntil.delete(limitId);
    }
    if (state.bucketUntil.size < MAX_BUCKET_COOLDOWN_ENTRIES) return;

    let soonestId: string | undefined;
    let soonestUntil = Number.POSITIVE_INFINITY;
    for (const [limitId, until] of state.bucketUntil) {
      if (until < soonestUntil) {
        soonestId = limitId;
        soonestUntil = until;
      }
    }
    if (soonestId !== undefined) state.bucketUntil.delete(soonestId);
  }

  getCooldownView(accountId: string): OpenAICooldownView {
    const account = this.findById(accountId);
    if (!account) return { globalUntilMs: 0, bucketCooldowns: [] };
    this.clearExpiredCooldownState(account);
    const state = this.cooldowns.get(account);
    if (!state) return { globalUntilMs: 0, bucketCooldowns: [] };
    return {
      globalUntilMs: state.globalUntil,
      bucketCooldowns: [...state.bucketUntil]
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, 12)
        .map(([limitId, untilMs]) => ({ limitId, untilMs })),
    };
  }

  /**
   * The account-wide (global-scope) cooldown expiry only — never a
   * bucket-scoped one. A niche model bucket's cooldown must not make the
   * whole account appear busy, and a long global cooldown must not be
   * reported as "recovering soon" just because some unrelated bucket
   * cooldown happens to expire sooner. Per-bucket cooldowns remain visible
   * individually via `getCooldownView`.
   */
  getGlobalCooldownUntil(accountId: string): number {
    return this.getCooldownView(accountId).globalUntilMs;
  }

  isCoolingDown(accountId: string): boolean {
    return this.getGlobalCooldownUntil(accountId) > 0;
  }

  sweepExpiredCooldowns(): void {
    const now = this.now();
    for (const account of this.accounts) {
      // Read cooldown retention before clearExpiredCooldownState (below)
      // deletes any bucketUntil entry that just expired — a bucket must stay
      // retained through this exact sweep for as long as its cooldown is
      // still live at `now`, not react to the expiry the same call is about
      // to perform.
      const windowRecovered = sweepCodexRateLimits(account, now, {
        isRetained: limitId => this.isBucketCoolingDown(account, limitId, now),
      });
      const cooldownRecovered = this.clearExpiredCooldownState(account);

      // Read the account's global cooldown directly: the account object is
      // already in hand here, so going through isCoolingDown() would re-scan
      // the pool by id and rebuild the sorted public cooldown view once per
      // account, making this sweep quadratic for no gain.
      const globalUntil = this.cooldowns.get(account)?.globalUntil ?? 0;
      if (account.rateLimits.status === "rate_limited" && globalUntil <= 0) {
        const defaultBucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID);
        const exhausted = [defaultBucket?.primary, defaultBucket?.secondary]
          .some(window => window !== undefined && window.utilization >= 1);
        if (!exhausted) account.rateLimits.status = "ok";
      }
      if (windowRecovered || cooldownRecovered) this.onCooldownExpired?.(account);
    }
  }

  findById(id: string): OpenAIAccount | null {
    return this.accounts.find(account => account.id === id) ?? null;
  }

  /**
   * Change an account's id in place. The in-flight counter is keyed by id and
   * must move with it — an open lease's release() re-reads `account.id`, so
   * after a rename it decrements the NEW key, which would otherwise never
   * have been incremented. Cooldowns are keyed by the account object and
   * follow the rename untouched. Returns the renamed account, or null if the
   * id was not found. Callers are responsible for id-uniqueness and for
   * session-binding migration. Mirrors `TokenPool.renameAccount`.
   */
  renameAccount(oldId: string, newId: string): OpenAIAccount | null {
    const account = this.findById(oldId);
    if (!account) return null;
    if (newId !== oldId) {
      const load = this.inFlight.get(oldId);
      this.inFlight.delete(oldId);
      if (load !== undefined) this.inFlight.set(newId, load);
      account.id = newId;
    }
    return account;
  }

  /**
   * Drop every piece of per-account routing state after the account has been
   * removed from the shared `accounts` array. The array splice itself is owned
   * by the deletion transaction (it persists a prospective state first), so
   * this only clears what the pool holds on the side.
   *
   * Without this, `createLease`'s release guard (`findById(id) !== account`)
   * means an in-flight request on a deleted account never decrements its
   * counter, and re-adding the same id inherits a phantom in-flight count that
   * permanently deprioritizes it in `selectEligible`. Mirrors the cleanup in
   * the Anthropic `TokenPool.removeAccount`.
   */
  forgetAccount(account: OpenAIAccount): void {
    this.cooldowns.delete(account);
    this.inFlight.delete(account.id);
    this.currentIndex = this.accounts.length === 0
      ? 0
      : this.currentIndex % this.accounts.length;
  }

  getAll(): OpenAIAccount[] {
    return this.accounts;
  }

  private hardBlock(account: OpenAIAccount, context?: RouteContext): HardBlock | null {
    if (!account.enabled || !account.healthy) return { reason: "unavailable" };

    const nowMs = this.now();
    const timedBlockers: number[] = [];
    let hasIndefiniteBlocker = false;
    // Two separate questions. `blocked` decides whether this account can take
    // the request at all; `rateLimited` decides what a caller is told when no
    // account can. Every blocker answers the first — only a spent quota
    // answers the second, because only that is something the caller can wait
    // out, and only that carries a `Retry-After` worth honouring.
    let blocked = false;
    let rateLimited = false;

    const state = this.cooldowns.get(account);
    if (state !== undefined && state.globalUntil > nowMs) {
      blocked = true;
      // A 401, a 503/529 overload, or a local refresh failure blocks just as
      // hard, but answering 429 for quota the caller never spent sends it
      // looking in entirely the wrong place. The retry hint follows the quota
      // horizon rather than the whole block: it is only ever emitted with a
      // rate-limit answer, and it should say when the quota frees up.
      if (state.rateLimitedUntil > nowMs) {
        rateLimited = true;
        timedBlockers.push(state.rateLimitedUntil);
      }
    }

    const blockingWindows: CodexRateWindow[] = [];
    const defaultBucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID);
    for (const window of [defaultBucket?.primary, defaultBucket?.secondary]) {
      if (window !== undefined && window.utilization >= 1) blockingWindows.push(window);
    }

    // A bucket cooldown can be learned from a header-only 429 that carried no
    // rate-limit snapshot for that bucket (`setBucketCooldownForAccount` was
    // called, but `account.rateLimits.buckets` has no entry for it yet).
    // Resolve the model's mapped limitId independently of whether a bucket
    // snapshot exists so that cooldown is still enforced; the window-based
    // exhaustion check below still only applies when a snapshot is present.
    const modelLimitId = bucketIdForModel(account, context?.requestedModel);
    if (modelLimitId !== undefined) {
      const bucketCooldown = state?.bucketUntil.get(modelLimitId) ?? 0;
      if (bucketCooldown > nowMs) {
        // Bucket cooldowns come only from a 429 naming an active limit.
        blocked = true;
        rateLimited = true;
        timedBlockers.push(bucketCooldown);
      }
    }
    const modelBucket = this.modelBucket(account, context);
    if (modelBucket !== undefined) {
      for (const window of [modelBucket.primary, modelBucket.secondary]) {
        if (window !== undefined && window.utilization >= 1) blockingWindows.push(window);
      }
    }

    for (const window of blockingWindows) {
      // An exhausted usage window is a spent quota by definition.
      blocked = true;
      rateLimited = true;
      const resetMs = trustworthyResetMs(window.resetAt, nowMs);
      if (resetMs !== undefined) timedBlockers.push(resetMs);
      else hasIndefiniteBlocker = true;
    }

    if (!blocked) return null;
    if (!rateLimited) return { reason: "unavailable" };
    const retryAtMs = !hasIndefiniteBlocker && timedBlockers.length > 0
      ? Math.max(...timedBlockers)
      : undefined;
    return retryAtMs === undefined
      ? { reason: "rate_limited" }
      : { reason: "rate_limited", retryAtMs };
  }

  private modelBucket(account: OpenAIAccount, context?: RouteContext): CodexLimitBucket | undefined {
    return bucketForModel(account, context?.requestedModel);
  }

  /** True while `limitId` has an active bucket-scoped cooldown on `account`. */
  private isBucketCoolingDown(account: OpenAIAccount, limitId: string, nowMs: number): boolean {
    return (this.cooldowns.get(account)?.bucketUntil.get(limitId) ?? 0) > nowMs;
  }

  private overUserCap(account: OpenAIAccount): boolean {
    const defaultBucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID);
    const primaryUtil = defaultBucket?.primary?.utilization ?? 0;
    const secondaryUtil = defaultBucket?.secondary?.utilization ?? 0;
    return (account.sessionLimitPercent < 100 && primaryUtil * 100 >= account.sessionLimitPercent) ||
      (account.weeklyLimitPercent < 100 && secondaryUtil * 100 >= account.weeklyLimitPercent);
  }

  private headroomScore(account: OpenAIAccount, context?: RouteContext): number {
    const defaultBucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID);
    const modelBucket = this.modelBucket(account, context);
    return Math.max(
      capNormalizedUtilization(defaultBucket?.primary?.utilization ?? 0, account.sessionLimitPercent),
      capNormalizedUtilization(defaultBucket?.secondary?.utilization ?? 0, account.weeklyLimitPercent),
      modelBucket?.primary?.utilization ?? 0,
      modelBucket?.secondary?.utilization ?? 0,
    );
  }

  private selectEligible(
    candidates: OpenAIAccount[],
    activeSessions: ReadonlyMap<string, number>,
    context?: RouteContext,
  ): OpenAIAccount {
    return candidates.reduce((best, account) => {
      const comparison = compareTuple(
        [
          this.getInFlight(account.id),
          activeSessions.get(account.id) ?? 0,
          this.headroomScore(account, context),
          this.circularDistance(account),
        ],
        [
          this.getInFlight(best.id),
          activeSessions.get(best.id) ?? 0,
          this.headroomScore(best, context),
          this.circularDistance(best),
        ],
      );
      return comparison < 0 ? account : best;
    });
  }

  private circularDistance(account: OpenAIAccount): number {
    const index = this.accounts.indexOf(account);
    return (index - this.currentIndex + this.accounts.length) % this.accounts.length;
  }

  private advanceCursor(account: OpenAIAccount): void {
    const index = this.accounts.indexOf(account);
    this.currentIndex = (index + 1) % this.accounts.length;
  }

  private proposedExpiry(account: OpenAIAccount, durationMs: number): number | undefined {
    if (this.findById(account.id) !== account) return undefined;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
    const expiry = this.now() + durationMs;
    return Number.isFinite(expiry) ? expiry : undefined;
  }

  private cooldownsFor(account: OpenAIAccount): OpenAICooldowns {
    let state = this.cooldowns.get(account);
    if (!state) {
      state = { globalUntil: 0, rateLimitedUntil: 0, bucketUntil: new Map() };
      this.cooldowns.set(account, state);
    }
    return state;
  }

  /** Returns true when an active cooldown scope just expired. */
  private clearExpiredCooldownState(account: OpenAIAccount): boolean {
    const state = this.cooldowns.get(account);
    if (!state) return false;
    const now = this.now();
    let recovered = false;
    if (state.rateLimitedUntil > 0 && state.rateLimitedUntil <= now) state.rateLimitedUntil = 0;
    if (state.globalUntil > 0 && state.globalUntil <= now) {
      state.globalUntil = 0;
      recovered = true;
    }
    for (const [limitId, until] of state.bucketUntil) {
      if (until <= now) {
        state.bucketUntil.delete(limitId);
        recovered = true;
      }
    }
    if (state.globalUntil === 0 && state.bucketUntil.size === 0) this.cooldowns.delete(account);
    return recovered;
  }

  private createLease(account: OpenAIAccount, fallback: boolean): AccountLease<OpenAIAccount> {
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
        if (this.findById(account.id) !== account) return;
        const remaining = Math.max(0, this.getInFlight(account.id) - 1);
        if (remaining === 0) this.inFlight.delete(account.id);
        else this.inFlight.set(account.id, remaining);
      },
    };
  }
}

function trustworthyResetMs(resetAtSeconds: number, nowMs: number): number | undefined {
  if (!Number.isFinite(resetAtSeconds) || resetAtSeconds <= 0) return undefined;
  const resetAtMs = Math.floor(resetAtSeconds) * 1_000;
  if (resetAtMs <= nowMs) return undefined;
  return resetAtMs - nowMs <= MAX_TRUSTED_RATE_LIMIT_RESET_MS ? resetAtMs : undefined;
}

function capNormalizedUtilization(utilization: number, capPercent: number): number {
  const cap = Number.isFinite(capPercent) ? Math.max(0, capPercent / 100) : 1;
  return cap === 0 ? Number.POSITIVE_INFINITY : utilization / cap;
}

function compareTuple(left: number[], right: number[]): number {
  for (let i = 0; i < left.length; i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}
