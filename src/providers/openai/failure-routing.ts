import {
  futureExpiry,
  resetHeaderExpiry,
  retryAfterExpiry,
  type BindingInvalidator,
  type FailureRoute,
} from "../../proxy/lease-lifecycle.js";
import { learnModelBucket, type OpenAIAccount } from "./account-state.js";
import { DEFAULT_CODEX_LIMIT_ID, resolveActiveLimit } from "./usage.js";

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const AUTH_FAILURE_COOLDOWN_MS = 30_000;
const OVERLOAD_COOLDOWN_MS = 30_000;

export interface CodexCooldownSetter {
  setGlobalCooldownForAccount(account: OpenAIAccount, durationMs: number): void;
  setBucketCooldownForAccount(account: OpenAIAccount, limitId: string, durationMs: number): void;
}

export interface AppliedCodexFailureRouting {
  cooldownSeconds?: number;
  limitingScope?: "global" | `bucket:${string}`;
}

function header(headers: Record<string, unknown>, name: string): unknown {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function bucketResetExpiry(account: OpenAIAccount, limitId: string, nowMs: number): number | undefined {
  const bucket = account.rateLimits.buckets.get(limitId);
  const expiries = [bucket?.primary?.resetAt, bucket?.secondary?.resetAt]
    .filter((resetAt): resetAt is number => typeof resetAt === "number" && resetAt > 0)
    .map(resetAt => futureExpiry(resetAt * 1_000, nowMs))
    .filter((expiry): expiry is number => expiry !== undefined);
  return expiries.length > 0 ? Math.max(...expiries) : undefined;
}

function rateLimitCooldownMs(
  headers: Record<string, unknown>,
  account: OpenAIAccount,
  limitId: string,
  nowMs: number,
): number {
  const prefix = `x-${limitId.replace(/_/g, "-")}`;
  const expiries = [
    retryAfterExpiry(header(headers, "retry-after"), nowMs),
    resetHeaderExpiry(header(headers, `${prefix}-primary-reset-at`), nowMs),
    resetHeaderExpiry(header(headers, `${prefix}-secondary-reset-at`), nowMs),
    retryAfterExpiry(header(headers, `${prefix}-primary-reset-after-seconds`), nowMs),
    retryAfterExpiry(header(headers, `${prefix}-secondary-reset-after-seconds`), nowMs),
    bucketResetExpiry(account, limitId, nowMs),
  ].filter((expiry): expiry is number => expiry !== undefined);
  return expiries.length > 0
    ? Math.max(...expiries) - nowMs
    : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

/**
 * Apply only routing state changes implied by an upstream Codex failure. The
 * failed response itself is relayed byte-for-byte by the caller.
 */
export function applyCodexFailureRouting(
  status: number,
  failureHeaders: Record<string, unknown>,
  route: FailureRoute<OpenAIAccount>,
  requestedModel: string | undefined,
  router: BindingInvalidator,
  pool: CodexCooldownSetter,
  now: () => number = Date.now,
): AppliedCodexFailureRouting {
  if (status !== 401 && status !== 429 && status < 500) return {};

  if (route.sessionId !== undefined && route.bindingGeneration !== undefined) {
    router.invalidate(route.sessionId, route.account.id, route.bindingGeneration);
  }

  const nowMs = now();
  if (status === 429) {
    const activeLimit = resolveActiveLimit(failureHeaders);
    if (activeLimit !== undefined && activeLimit !== DEFAULT_CODEX_LIMIT_ID) {
      learnModelBucket(route.account, requestedModel, activeLimit);
      const durationMs = rateLimitCooldownMs(failureHeaders, route.account, activeLimit, nowMs);
      pool.setBucketCooldownForAccount(route.account, activeLimit, durationMs);
      return { cooldownSeconds: durationMs / 1_000, limitingScope: `bucket:${activeLimit}` };
    }
    const durationMs = rateLimitCooldownMs(failureHeaders, route.account, DEFAULT_CODEX_LIMIT_ID, nowMs);
    pool.setGlobalCooldownForAccount(route.account, durationMs);
    route.account.rateLimits.status = "rate_limited";
    return { cooldownSeconds: durationMs / 1_000, limitingScope: "global" };
  }

  const durationMs = status === 401 ? AUTH_FAILURE_COOLDOWN_MS : OVERLOAD_COOLDOWN_MS;
  pool.setGlobalCooldownForAccount(route.account, durationMs);
  return { cooldownSeconds: durationMs / 1_000, limitingScope: "global" };
}
