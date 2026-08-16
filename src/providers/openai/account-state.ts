import { ACCOUNT_USER_DEFAULTS, clampPercent } from "../../proxy/types.js";
import type { OpenAISubscriptionAccount } from "./token-refresher.js";
import {
  DEFAULT_CODEX_LIMIT_ID,
  MAX_TRUSTED_RATE_LIMIT_HORIZON_SEC,
  createEmptyCodexRateLimits,
  decodeOpenAIPlan,
  type CodexLimitBucket,
  type CodexRateLimits,
  type CodexRateLimitsUpdate,
  type CodexRateWindow,
} from "./usage.js";

const MAX_MODEL_BUCKET_ENTRIES = 32;
const DEFAULT_OPENAI_SCOPES = ["openid", "profile", "email", "offline_access"];

// Fallback staleness window used when a rate-limit window is fully exhausted
// (utilization >= 1) but its resetAt is untrustworthy (0 — past, absent, or
// malformed per usage.ts's parseResetAtSeconds). Without a reset to wait out,
// such a window would otherwise block the account forever. Once the snapshot
// backing it hasn't been refreshed for longer than its own reported window
// length (or this default when no window length was reported), we treat it as
// stale and self-heal by clearing it on the next sweep.
const STALE_DEFAULT_WINDOW_MINUTES = 300;

// Named buckets are entirely upstream-controlled: every distinct limitId the
// Codex backend ever mentions gets its own entry. A cap bounds memory growth
// from a buggy or malicious upstream minting unbounded distinct ids. 16 is
// generous for any real deployment (the default bucket plus a small handful
// of per-model metered buckets) while still being a hard ceiling.
const MAX_CODEX_BUCKETS = 16;

// How long a named bucket can go completely unmentioned by upstream before
// the sweep reaps it outright, independent of its last-known window state.
// Reuses the same 8-day header-trust horizon already enforced when parsing
// reset-at/window-minutes values (usage.ts) and when trusting a reset in
// token-pool.ts: any resetAt a bucket last reported is itself capped to that
// horizon, so once a bucket has gone unmentioned for longer than it, every
// window it reported has necessarily already expired via the per-window
// check below — this only catches the residual case where a window's
// resetAt was untrustworthy (0) and it never reached full exhaustion, so
// nothing else would ever clear it. Deliberately much larger than
// STALE_DEFAULT_WINDOW_MINUTES above, which self-heals a single exhausted
// window on the timescale of that window's own length (hours), not the
// timescale of "upstream stopped mentioning this bucket at all" (days).
const UNMENTIONED_BUCKET_STALE_MS = MAX_TRUSTED_RATE_LIMIT_HORIZON_SEC * 1_000;

export interface OpenAIAccount extends OpenAISubscriptionAccount {
  scopes: string[];
  sessionLimitPercent: number;
  weeklyLimitPercent: number;
  healthy: boolean;
  requestCount: number;
  errorCount: number;
  consecutiveErrors: number;
  lastUsed: number;
  lastRefresh: number;
  rateLimits: CodexRateLimits;
  modelBuckets: Map<string, ModelBucketMapping>;
}

/**
 * A model→bucket association and the timestamp of the evidence behind it —
 * either a 429's `x-codex-active-limit` or the `lastSeenAt` of a bucket
 * snapshot naming the model. Recency is what lets `bucketIdForModel` decide
 * between the two when they disagree.
 */
export interface ModelBucketMapping {
  limitId: string;
  learnedAt: number;
}

export function createOpenAIAccount(record: OpenAISubscriptionAccount): OpenAIAccount {
  const plan = decodeOpenAIPlan(record.accessToken);
  const rateLimits: CodexRateLimits = {
    ...createEmptyCodexRateLimits(),
    ...(plan ? { plan } : {}),
  };
  return {
    ...record,
    scopes: record.scopes ?? [...DEFAULT_OPENAI_SCOPES],
    sessionLimitPercent: record.sessionLimitPercent !== undefined
      ? clampPercent(record.sessionLimitPercent)
      : ACCOUNT_USER_DEFAULTS.sessionLimitPercent,
    weeklyLimitPercent: record.weeklyLimitPercent !== undefined
      ? clampPercent(record.weeklyLimitPercent)
      : ACCOUNT_USER_DEFAULTS.weeklyLimitPercent,
    healthy: true,
    requestCount: 0,
    errorCount: 0,
    consecutiveErrors: 0,
    lastUsed: 0,
    lastRefresh: 0,
    rateLimits,
    modelBuckets: new Map(),
  };
}

/**
 * Evict the least-recently-seen named bucket to make room for a new one at
 * the cap. Never touches the default bucket. Map insertion order does not
 * track `lastSeenAt` (an existing entry re-touched via `.set()` keeps its
 * original slot), so this scans for the minimum rather than relying on
 * iteration order — unlike `learnModelBucket`'s LRU below, which can rely on
 * insertion order because it never re-touches an existing key's position.
 */
function evictLeastRecentlySeenBucket(limits: CodexRateLimits): void {
  let oldestId: string | undefined;
  let oldestSeenAt = Infinity;
  for (const [limitId, bucket] of limits.buckets) {
    if (limitId === DEFAULT_CODEX_LIMIT_ID) continue;
    const seenAt = bucket.lastSeenAt ?? 0;
    if (seenAt < oldestSeenAt) {
      oldestSeenAt = seenAt;
      oldestId = limitId;
    }
  }
  if (oldestId === undefined) return;
  limits.buckets.delete(oldestId);
  // Deliberately leave `modelBuckets` mappings alone: this evicts a bucket
  // upstream is still actively mentioning (there just isn't room for its
  // snapshot), unlike the sweep's staleness reap below, which only fires once
  // a bucket is confirmed abandoned. The mapping is already bounded at
  // MAX_MODEL_BUCKET_ENTRIES, and `bucketIdForModel` resolves a cooldown from
  // it alone even with no bucket snapshot present, so dropping it here would
  // only lose a still-live cooldown mapping for no benefit.
}

/**
 * Pick the window to keep for one slot of a bucket, and record when it was
 * last actually reported. A freshly reported window is stamped `nowMs`; a
 * window this response said nothing about keeps both its values and its older
 * stamp, so its age reflects the last time upstream really mentioned it.
 */
function stampWindow(
  reported: CodexRateWindow | undefined,
  existing: CodexRateWindow | undefined,
  nowMs: number,
): CodexRateWindow | undefined {
  if (reported) return { ...reported, lastSeenAt: nowMs };
  return existing;
}

export function applyCodexRateLimits(
  account: Pick<OpenAIAccount, "rateLimits">,
  update: CodexRateLimitsUpdate,
  nowMs: number,
): void {
  const limits = account.rateLimits;
  for (const bucket of update.buckets) {
    const existing = limits.buckets.get(bucket.limitId);
    if (!existing && limits.buckets.size >= MAX_CODEX_BUCKETS) {
      evictLeastRecentlySeenBucket(limits);
    }
    // Built field by field rather than spread over `existing` on purpose: a
    // bucket upstream has just reported is live again, so any pending-reap
    // mark the sweep left on it has to be dropped here.
    const merged: CodexLimitBucket = { limitId: bucket.limitId };
    const limitName = bucket.limitName ?? existing?.limitName;
    if (limitName) merged.limitName = limitName;
    // Each window is stamped only when this response actually reported it. A
    // retained window has not been heard from, however recently the bucket as
    // a whole was: an upstream that keeps sending one window and not the other
    // would otherwise keep resetting the age of the silent one, and an
    // exhausted window with no reset time recovers *only* by ageing out — so
    // it would sit at 100% forever, blocking its model on this account with
    // nothing left to clear it.
    const primary = stampWindow(bucket.primary, existing?.primary, nowMs);
    if (primary) merged.primary = primary;
    const secondary = stampWindow(bucket.secondary, existing?.secondary, nowMs);
    if (secondary) merged.secondary = secondary;
    // The bucket's own timestamp still tracks the bucket: it answers "is
    // upstream still mentioning this bucket at all", which is what the
    // unmentioned-bucket reap needs.
    merged.lastSeenAt = nowMs;
    limits.buckets.set(bucket.limitId, merged);
  }
  if (update.credits) limits.credits = update.credits;
  if (update.buckets.length > 0 || update.credits) limits.lastUpdated = nowMs;
}

function normalizeModelSlug(model: string | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase();
  return normalized ? normalized.slice(0, 64) : undefined;
}

/**
 * Record that `modelSlug` belongs to `limitId`, as of `learnedAtMs` — the
 * moment the evidence was produced, not the moment this is called, so a
 * mapping refreshed for LRU purposes does not pass itself off as newer than
 * it is.
 */
export function learnModelBucket(
  account: Pick<OpenAIAccount, "modelBuckets">,
  modelSlug: string | undefined,
  limitId: string,
  learnedAtMs: number,
): void {
  const model = normalizeModelSlug(modelSlug);
  if (!model || limitId === DEFAULT_CODEX_LIMIT_ID) return;
  if (account.modelBuckets.has(model)) {
    // A `Map.set` on an existing key keeps its original insertion position, so
    // relearning a mapping would leave it first in line for eviction however
    // recently it was used. Delete before re-adding to move it to the end and
    // make the eviction below true LRU: otherwise a header-only 429 could
    // learn a mapping and then have it evicted while its bucket cooldown is
    // still live, which loses the model→bucket association `hardBlock` needs
    // to keep that model off the cooling account.
    account.modelBuckets.delete(model);
  } else if (account.modelBuckets.size >= MAX_MODEL_BUCKET_ENTRIES) {
    const oldest = account.modelBuckets.keys().next().value;
    if (oldest !== undefined) account.modelBuckets.delete(oldest);
  }
  account.modelBuckets.set(model, { limitId, learnedAt: learnedAtMs });
}

/**
 * Resolve the rate-limit bucket id a model is mapped to, without requiring a
 * bucket snapshot to exist. A header-only 429 (no accompanying rate-limit
 * snapshot for that bucket) still learns and keeps a model->limitId mapping
 * via `learnModelBucket`, and callers that only need the id to look up an
 * independently-tracked cooldown (e.g. `OpenAITokenPool.hardBlock`) must not
 * lose that mapping just because no bucket snapshot has arrived yet.
 */
export function bucketIdForModel(
  account: Pick<OpenAIAccount, "rateLimits" | "modelBuckets">,
  modelSlug: string | undefined,
): string | undefined {
  const model = normalizeModelSlug(modelSlug);
  if (!model) return undefined;

  // A live bucket that names this model wins over the cached mapping. Upstream
  // can move a model to a different limit id, and the freshly reported bucket
  // is the one carrying current exhaustion data — trusting the cache first
  // would keep consulting a superseded (or already-reaped) bucket, leaving an
  // exhausted replacement eligible until a 429 happened to relearn it. When
  // several buckets name the model, the most recently seen one is current.
  //
  // Recency cannot break every tie: one response stamps every bucket it
  // carries with the same `lastSeenAt`, so two buckets naming the same model
  // arrive indistinguishable. Falling back to Map insertion order there would
  // silently outrank the cached mapping — and the cache is where a 429's
  // `x-codex-active-limit` records which bucket upstream itself said was
  // limiting. Prefer it on a tie, or a bucket cooldown keyed on the active
  // limit stops being found and the rate-limited account goes back in rotation.
  const cached = account.modelBuckets.get(model);
  let live: CodexLimitBucket | undefined;
  for (const bucket of account.rateLimits.buckets.values()) {
    if (bucket.limitId === DEFAULT_CODEX_LIMIT_ID) continue;
    if (bucket.limitName?.trim().toLowerCase() !== model) continue;
    if (live === undefined) {
      live = bucket;
      continue;
    }
    const seenAt = bucket.lastSeenAt ?? 0;
    const bestSeenAt = live.lastSeenAt ?? 0;
    if (seenAt > bestSeenAt || (seenAt === bestSeenAt && bucket.limitId === cached?.limitId)) live = bucket;
  }
  if (live !== undefined) {
    const liveSeenAt = live.lastSeenAt ?? 0;
    // "Live wins" is really "the newer evidence wins", and a snapshot is not
    // automatically the newer one. A header-only 429 carries no snapshot at
    // all: it maps the model through `x-codex-active-limit` and leaves the
    // previous bucket sitting in `rateLimits.buckets`, still naming the model
    // from before the move. Relearning that older snapshot here would both
    // resolve to the wrong bucket — missing the cooldown the 429 just set,
    // sending the account straight back out for a model upstream told us to
    // back off — and overwrite the mapping, so no later lookup could recover
    // it either.
    //
    // Equal timestamps go to the mapping, for the same reason the loop above
    // breaks its own ties that way. A 429 that carries rate-limit headers
    // *and* `x-codex-active-limit` is applied and routed from one `now`, so
    // the snapshot it refreshes and the mapping it learns are stamped
    // identically — the common case, not a freak collision. Of the two, only
    // the active-limit header is upstream naming the bucket that limited this
    // request; the snapshot merely lists what exists.
    if (cached !== undefined && cached.learnedAt >= liveSeenAt) {
      // Re-learn at its own timestamp: this refreshes LRU recency without
      // letting the mapping claim to be newer evidence than it is.
      learnModelBucket(account, model, cached.limitId, cached.learnedAt);
      return cached.limitId;
    }
    // Re-learning also refreshes the mapping's LRU recency, so a model that
    // keeps routing stays mapped.
    learnModelBucket(account, model, live.limitId, liveSeenAt);
    return live.limitId;
  }

  // No live bucket names this model. The cached mapping is what keeps a
  // header-only 429's bucket cooldown enforceable — that path never carries a
  // bucket snapshot, so the cache is the only association available.
  if (cached === undefined) return undefined;
  // Re-insert before returning, at its own evidence timestamp. Reading a Map
  // does not move the key, so a mapping with no snapshot behind it would stay
  // frozen at its original insertion position no matter how often it is
  // consulted — and be evicted as "oldest" the moment a 33rd model is learned,
  // even while the cooldown it exists to resolve is still live. Every other
  // return path already relearns; this one has to as well.
  learnModelBucket(account, model, cached.limitId, cached.learnedAt);
  return cached.limitId;
}

export function bucketForModel(
  account: Pick<OpenAIAccount, "rateLimits" | "modelBuckets">,
  modelSlug: string | undefined,
): CodexLimitBucket | undefined {
  const limitId = bucketIdForModel(account, modelSlug);
  return limitId === undefined ? undefined : account.rateLimits.buckets.get(limitId);
}

/**
 * Give a reset-less exhausted window the retry time the upstream just
 * advertised. A 429 reporting 100% utilization with a `Retry-After` but no
 * reset header leaves `resetAt: 0`, which the pool can only read as "blocked
 * indefinitely": it suppresses the `retryAtMs` the client would otherwise be
 * told, and it outlives the cooldown derived from that very `Retry-After`,
 * keeping the account unroutable until the multi-hour staleness sweep.
 *
 * The cooldown expiry is the best reset available — it is literally when the
 * upstream said to come back — so recording it bounds recovery by what was
 * advertised rather than by a fallback measured in hours. A later response
 * carrying a real reset overwrites it.
 */
export function boundResetlessExhaustedWindows(
  account: Pick<OpenAIAccount, "rateLimits">,
  limitId: string,
  expiryMs: number,
): void {
  const bucket = account.rateLimits.buckets.get(limitId);
  if (!bucket) return;
  const resetAt = Math.ceil(expiryMs / 1000);
  if (!Number.isFinite(resetAt) || resetAt <= 0) return;
  for (const window of [bucket.primary, bucket.secondary]) {
    if (window !== undefined && window.utilization >= 1 && window.resetAt === 0) {
      window.resetAt = resetAt;
    }
  }
}

/**
 * A window reporting `resetAt === 0` (untrustworthy — past, absent, or
 * malformed, per parseResetAtSeconds) has no expiry to wait out, so the only
 * thing that can retire its number is age. Once it has gone unreported for
 * longer than its own window length, whatever utilization it claims describes
 * a window that has since rolled over, and acting on it means acting on
 * fiction.
 *
 * This deliberately does not require full exhaustion. A window stuck at, say,
 * 80% excludes the account just as durably wherever a user cap sits below
 * that — and worse, quietly: the account is skipped, so it receives no
 * response to refresh the snapshot, so the stale number never changes. The
 * traffic it would have taken goes to whichever accounts are left.
 */
function isStaleResetlessWindow(
  window: CodexRateWindow | undefined,
  lastSeenAtMs: number,
  nowMs: number,
): boolean {
  if (!window || window.resetAt !== 0 || window.utilization <= 0) return false;
  const staleAfterMs = (window.windowMinutes > 0 ? window.windowMinutes : STALE_DEFAULT_WINDOW_MINUTES) * 60_000;
  return nowMs - lastSeenAtMs > staleAfterMs;
}

export function sweepCodexRateLimits(
  account: Pick<OpenAIAccount, "rateLimits" | "modelBuckets">,
  nowMs: number,
  options?: { isRetained?: (limitId: string) => boolean },
): boolean {
  const isRetained = options?.isRetained ?? (() => false);
  const nowSec = Math.floor(nowMs / 1000);
  let recovered = false;

  for (const [limitId, bucket] of account.rateLimits.buckets) {
    // Buckets recorded before lastSeenAt existed fall back to the
    // account-wide timestamp.
    const bucketSeenAt = bucket.lastSeenAt ?? account.rateLimits.lastUpdated;
    const windows = [bucket.primary, bucket.secondary];
    const expired = windows.map(window =>
      window !== undefined
      && ((window.resetAt > 0 && nowSec >= window.resetAt)
        // Age each window by when it was last reported, not by when the bucket
        // was: a window upstream has stopped mentioning is exactly the one
        // this check exists to recover, and the bucket's timestamp keeps
        // moving as long as the *other* window is still being sent.
        || isStaleResetlessWindow(window, window.lastSeenAt ?? bucketSeenAt, nowMs)),
    );

    // Zero each individually-expired window in place — for both the default
    // bucket and named buckets alike. A named bucket reporting a 5h primary
    // window and a 6-day secondary window must recover the primary the
    // moment it resets, not sit on it until the secondary also clears.
    let anyWindowExpiredHere = false;
    windows.forEach((window, index) => {
      if (!window || !expired[index]) return;
      anyWindowExpiredHere = true;
      if (window.utilization >= 1) recovered = true;
      window.utilization = 0;
      window.resetAt = 0;
    });

    if (limitId === DEFAULT_CODEX_LIMIT_ID) continue;

    // Named buckets (and their model mappings) are cleaned up entirely once
    // every window the bucket still carries is at exactly zero utilization
    // and a window expired this sweep — not merely "below 100%". A bucket
    // reporting a zeroed 5h primary alongside a still-live 30% secondary is
    // still meaningfully tracking usage and must be kept, snapshot and
    // mapping intact, until the secondary clears too.
    const allZero = windows.every(window => window === undefined || window.utilization === 0);

    // Zeroing a window is a one-time observation: it leaves `utilization` and
    // `resetAt` at 0, which no later sweep can tell apart from a bucket that
    // has simply never been used, so `anyWindowExpiredHere` is false from here
    // on. Record the verdict now, or a bucket that had to be held back below
    // could never be reaped by this rule again.
    if (anyWindowExpiredHere && allZero) bucket.reapPending = true;

    // A bucket the pool is actively cooling down on (a bucket-scoped
    // cooldown learned independently of this snapshot, e.g. from a
    // header-only 429) must keep both its snapshot and its model mapping for
    // as long as that cooldown is live, even if every window it reports has
    // just been zeroed above. The mark set above is what carries the reap
    // across that wait: without it the bucket would linger, zeroed and
    // unmentioned, until the eight-day stale reap — still naming its model in
    // `bucketIdForModel`, where a live bucket outranks the cached mapping, so
    // a header-only 429 that moved the model to a new bucket would keep
    // resolving to this corpse and its long-expired cooldown.
    if (isRetained(limitId)) continue;

    // Independently, a bucket upstream has simply stopped mentioning at all
    // for longer than the header-trust horizon is reaped outright — see
    // UNMENTIONED_BUCKET_STALE_MS above for why this can't collide with the
    // zero-utilization check just above.
    const unmentionedTooLong = nowMs - bucketSeenAt > UNMENTIONED_BUCKET_STALE_MS;

    if (bucket.reapPending === true || unmentionedTooLong) {
      account.rateLimits.buckets.delete(limitId);
      for (const [model, mapping] of account.modelBuckets) {
        if (mapping.limitId === limitId) account.modelBuckets.delete(model);
      }
    }
  }
  return recovered;
}
