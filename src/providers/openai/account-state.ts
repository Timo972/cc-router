import { ACCOUNT_USER_DEFAULTS, clampPercent } from "../../proxy/types.js";
import type { OpenAISubscriptionAccount } from "./token-refresher.js";
import {
  DEFAULT_CODEX_LIMIT_ID,
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
  modelBuckets: Map<string, string>;
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

export function applyCodexRateLimits(
  account: Pick<OpenAIAccount, "rateLimits">,
  update: CodexRateLimitsUpdate,
  nowMs: number,
): void {
  const limits = account.rateLimits;
  for (const bucket of update.buckets) {
    const existing = limits.buckets.get(bucket.limitId);
    const merged: CodexLimitBucket = { limitId: bucket.limitId };
    const limitName = bucket.limitName ?? existing?.limitName;
    if (limitName) merged.limitName = limitName;
    const primary = bucket.primary ?? existing?.primary;
    if (primary) merged.primary = primary;
    const secondary = bucket.secondary ?? existing?.secondary;
    if (secondary) merged.secondary = secondary;
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

export function learnModelBucket(
  account: Pick<OpenAIAccount, "modelBuckets">,
  modelSlug: string | undefined,
  limitId: string,
): void {
  const model = normalizeModelSlug(modelSlug);
  if (!model || limitId === DEFAULT_CODEX_LIMIT_ID) return;
  if (!account.modelBuckets.has(model) && account.modelBuckets.size >= MAX_MODEL_BUCKET_ENTRIES) {
    const oldest = account.modelBuckets.keys().next().value;
    if (oldest !== undefined) account.modelBuckets.delete(oldest);
  }
  account.modelBuckets.set(model, limitId);
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

  const mapped = account.modelBuckets.get(model);
  if (mapped !== undefined) return mapped;

  for (const bucket of account.rateLimits.buckets.values()) {
    if (bucket.limitId === DEFAULT_CODEX_LIMIT_ID) continue;
    if (bucket.limitName?.trim().toLowerCase() === model) {
      learnModelBucket(account, model, bucket.limitId);
      return bucket.limitId;
    }
  }
  return undefined;
}

export function bucketForModel(
  account: Pick<OpenAIAccount, "rateLimits" | "modelBuckets">,
  modelSlug: string | undefined,
): CodexLimitBucket | undefined {
  const limitId = bucketIdForModel(account, modelSlug);
  return limitId === undefined ? undefined : account.rateLimits.buckets.get(limitId);
}

/**
 * A window that's fully exhausted (utilization >= 1) but reports resetAt === 0
 * (untrustworthy — past, absent, or malformed, per parseResetAtSeconds) has no
 * trustworthy expiry to wait out. Treat it as expired once the snapshot behind
 * it hasn't been refreshed for longer than its own window length, so the
 * account isn't excluded forever.
 */
function isStaleExhaustedWindow(
  window: CodexRateWindow | undefined,
  lastSeenAtMs: number,
  nowMs: number,
): boolean {
  if (!window || window.resetAt !== 0 || window.utilization < 1) return false;
  const staleAfterMs = (window.windowMinutes > 0 ? window.windowMinutes : STALE_DEFAULT_WINDOW_MINUTES) * 60_000;
  return nowMs - lastSeenAtMs > staleAfterMs;
}

export function sweepCodexRateLimits(
  account: Pick<OpenAIAccount, "rateLimits" | "modelBuckets">,
  nowMs: number,
): boolean {
  const nowSec = Math.floor(nowMs / 1000);
  let recovered = false;

  for (const [limitId, bucket] of account.rateLimits.buckets) {
    // Buckets recorded before lastSeenAt existed fall back to the
    // account-wide timestamp.
    const bucketSeenAt = bucket.lastSeenAt ?? account.rateLimits.lastUpdated;
    const windows = [bucket.primary, bucket.secondary];
    const expired = windows.map(window =>
      window !== undefined
      && ((window.resetAt > 0 && nowSec >= window.resetAt) || isStaleExhaustedWindow(window, bucketSeenAt, nowMs)),
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

    // Named buckets (and their model mappings) are only cleaned up entirely
    // once nothing they still report is exhausted — i.e. a window expired
    // this sweep and every window the bucket still carries is now below
    // 100% utilization. This is bounded cleanup: mappings are capped at 32
    // entries and are otherwise only ever evicted here.
    const stillExhausted = windows.some(window => window !== undefined && window.utilization >= 1);
    if (anyWindowExpiredHere && !stillExhausted) {
      account.rateLimits.buckets.delete(limitId);
      for (const [model, mappedLimitId] of account.modelBuckets) {
        if (mappedLimitId === limitId) account.modelBuckets.delete(model);
      }
    }
  }
  return recovered;
}
