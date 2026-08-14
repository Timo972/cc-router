import {
  futureExpiry,
  resetHeaderExpiry,
  retryAfterExpiry,
  type BindingInvalidator,
  type FailureRoute,
} from "../../proxy/lease-lifecycle.js";
import { boundResetlessExhaustedWindows, learnModelBucket, type OpenAIAccount } from "./account-state.js";
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

function headerNumber(headers: Record<string, unknown>, name: string): number | undefined {
  const raw = header(headers, name);
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A candidate window-reset expiry, tagged with whether that window is known
 *  to be fully exhausted (utilization/used-percent >= 100%). */
interface WindowResetCandidate {
  expiry: number;
  exhausted: boolean;
}

function headerWindowCandidates(
  headers: Record<string, unknown>,
  prefix: string,
  kind: "primary" | "secondary",
  nowMs: number,
): WindowResetCandidate[] {
  const usedPercent = headerNumber(headers, `${prefix}-${kind}-used-percent`);
  const exhausted = usedPercent !== undefined && usedPercent >= 100;
  return [
    resetHeaderExpiry(header(headers, `${prefix}-${kind}-reset-at`), nowMs),
    retryAfterExpiry(header(headers, `${prefix}-${kind}-reset-after-seconds`), nowMs),
  ]
    .filter((expiry): expiry is number => expiry !== undefined)
    .map(expiry => ({ expiry, exhausted }));
}

function bucketWindowCandidates(account: OpenAIAccount, limitId: string, nowMs: number): WindowResetCandidate[] {
  const bucket = account.rateLimits.buckets.get(limitId);
  return [bucket?.primary, bucket?.secondary]
    .filter((window): window is NonNullable<typeof window> => window !== undefined && window.resetAt > 0)
    .flatMap(window => {
      const expiry = futureExpiry(window.resetAt * 1_000, nowMs);
      return expiry === undefined ? [] : [{ expiry, exhausted: window.utilization >= 1 }];
    });
}

/**
 * A 429's cooldown must wait out every window that's actually exhausted
 * (both a 5h and a 7d/weekly window are usually reported together, but only
 * one may have actually run out) — never the furthest-out window merely
 * because it was mentioned. In priority order:
 *  1. Retry-After, when present, is always a candidate (a floor the server
 *     asked us to respect).
 *  2. Resets of windows known to be exhausted (used-percent/utilization
 *     >= 100%), from both the failure headers and the account's own bucket
 *     snapshot. If Retry-After or an exhausted-window reset exists, the
 *     cooldown is the max of these — every exhausted window must clear.
 *  3. Otherwise (nothing is known to be exhausted), fall back to the
 *     *soonest* known future window reset, header or snapshot — the
 *     shortest window is the likeliest limiter, and erring short just
 *     retries sooner rather than blocking for a week on a guess.
 *  4. Nothing known at all -> the default cooldown.
 */
function rateLimitCooldownMs(
  headers: Record<string, unknown>,
  account: OpenAIAccount,
  limitId: string,
  nowMs: number,
): number {
  const prefix = `x-${limitId.replace(/_/g, "-")}`;
  const retryAfter = retryAfterExpiry(header(headers, "retry-after"), nowMs);
  const windowCandidates = [
    ...headerWindowCandidates(headers, prefix, "primary", nowMs),
    ...headerWindowCandidates(headers, prefix, "secondary", nowMs),
    ...bucketWindowCandidates(account, limitId, nowMs),
  ];

  const exhaustedExpiries = windowCandidates.filter(candidate => candidate.exhausted).map(candidate => candidate.expiry);
  const knownExpiries = retryAfter !== undefined ? [retryAfter, ...exhaustedExpiries] : exhaustedExpiries;
  if (knownExpiries.length > 0) return Math.max(...knownExpiries) - nowMs;

  const allExpiries = windowCandidates.map(candidate => candidate.expiry);
  if (allExpiries.length > 0) return Math.min(...allExpiries) - nowMs;

  return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
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
  // Only 503/529 signal the *upstream service* is overloaded — worth cooling
  // the whole account down and rebinding elsewhere. Other 5xx (500, 502,
  // 504, ...) are far more often an isolated per-request hiccup; blacking
  // out the account as "rate limited" for them would take a healthy account
  // out of rotation for something that has nothing to do with its rate
  // limit. The ingress still counts them as errors for stats regardless.
  const isOverload = status === 503 || status === 529;
  if (status !== 401 && status !== 429 && !isOverload) return {};

  if (route.sessionId !== undefined && route.bindingGeneration !== undefined) {
    router.invalidate(route.sessionId, route.account.id, route.bindingGeneration);
  }

  const nowMs = now();
  if (status === 429) {
    const activeLimit = resolveActiveLimit(failureHeaders);
    if (activeLimit !== undefined && activeLimit !== DEFAULT_CODEX_LIMIT_ID) {
      learnModelBucket(route.account, requestedModel, activeLimit, nowMs);
      const durationMs = rateLimitCooldownMs(failureHeaders, route.account, activeLimit, nowMs);
      pool.setBucketCooldownForAccount(route.account, activeLimit, durationMs);
      boundResetlessExhaustedWindows(route.account, activeLimit, nowMs + durationMs);
      return { cooldownSeconds: durationMs / 1_000, limitingScope: `bucket:${activeLimit}` };
    }
    const durationMs = rateLimitCooldownMs(failureHeaders, route.account, DEFAULT_CODEX_LIMIT_ID, nowMs);
    pool.setGlobalCooldownForAccount(route.account, durationMs);
    boundResetlessExhaustedWindows(route.account, DEFAULT_CODEX_LIMIT_ID, nowMs + durationMs);
    route.account.rateLimits.status = "rate_limited";
    return { cooldownSeconds: durationMs / 1_000, limitingScope: "global" };
  }

  const durationMs = status === 401 ? AUTH_FAILURE_COOLDOWN_MS : OVERLOAD_COOLDOWN_MS;
  pool.setGlobalCooldownForAccount(route.account, durationMs);
  return { cooldownSeconds: durationMs / 1_000, limitingScope: "global" };
}
