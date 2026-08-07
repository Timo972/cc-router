import { ACCOUNT_USER_DEFAULTS, clampPercent } from "../../proxy/types.js";
import type { OpenAISubscriptionAccount } from "./token-refresher.js";
import {
  DEFAULT_CODEX_LIMIT_ID,
  createEmptyCodexRateLimits,
  decodeOpenAIPlan,
  type CodexLimitBucket,
  type CodexRateLimits,
  type CodexRateLimitsUpdate,
} from "./usage.js";

const MAX_MODEL_BUCKET_ENTRIES = 32;
const DEFAULT_OPENAI_SCOPES = ["openid", "profile", "email", "offline_access"];

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

export function bucketForModel(
  account: Pick<OpenAIAccount, "rateLimits" | "modelBuckets">,
  modelSlug: string | undefined,
): CodexLimitBucket | undefined {
  const model = normalizeModelSlug(modelSlug);
  if (!model) return undefined;

  const mapped = account.modelBuckets.get(model);
  if (mapped !== undefined) {
    const bucket = account.rateLimits.buckets.get(mapped);
    if (bucket) return bucket;
    account.modelBuckets.delete(model);
    return undefined;
  }

  for (const bucket of account.rateLimits.buckets.values()) {
    if (bucket.limitId === DEFAULT_CODEX_LIMIT_ID) continue;
    if (bucket.limitName?.trim().toLowerCase() === model) {
      learnModelBucket(account, model, bucket.limitId);
      return bucket;
    }
  }
  return undefined;
}

export function sweepCodexRateLimits(
  account: Pick<OpenAIAccount, "rateLimits" | "modelBuckets">,
  nowMs: number,
): boolean {
  const nowSec = Math.floor(nowMs / 1000);
  let recovered = false;

  for (const [limitId, bucket] of account.rateLimits.buckets) {
    const windows = [bucket.primary, bucket.secondary];
    const expired = windows.map(window =>
      window !== undefined && window.resetAt > 0 && nowSec >= window.resetAt,
    );

    if (limitId === DEFAULT_CODEX_LIMIT_ID) {
      windows.forEach((window, index) => {
        if (!window || !expired[index]) return;
        if (window.utilization >= 1) recovered = true;
        window.utilization = 0;
        window.resetAt = 0;
      });
      continue;
    }

    const stillBlocking = windows.some((window, index) => window !== undefined && !expired[index]);
    const anyExpired = expired.some(Boolean);
    if (!stillBlocking && anyExpired) {
      if (windows.some(window => window !== undefined && window.utilization >= 1)) recovered = true;
      account.rateLimits.buckets.delete(limitId);
      for (const [model, mappedLimitId] of account.modelBuckets) {
        if (mappedLimitId === limitId) account.modelBuckets.delete(model);
      }
    }
  }
  return recovered;
}
