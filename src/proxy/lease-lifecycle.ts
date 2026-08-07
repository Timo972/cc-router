import type { AccountUsageSnapshot, RouteContext } from "./types.js";
import { canUseExtraUsage, normalizeModelFamily } from "../providers/anthropic/usage.js";

export interface ResponseLifecycle {
  once(event: "finish" | "close", listener: () => void): unknown;
}

export interface Releasable {
  release(): void;
}

export interface RouteSummary {
  readonly reason: "sticky" | "new-session" | "unscoped" | "failover";
  readonly fallback?: boolean;
  readonly sessionId?: string;
  readonly bindingGeneration?: number;
}

export interface FailureRoute<TAccount extends { readonly id: string } = { readonly id: string }> {
  readonly account: TAccount;
  readonly modelFamily?: string;
  readonly sessionId?: string;
  readonly bindingGeneration?: number;
}

export interface BindingInvalidator {
  invalidate(
    sessionHeader: unknown,
    expectedAccountId?: string,
    expectedGeneration?: number,
  ): boolean;
}

export interface CooldownSetter<TAccount extends { readonly id: string }> {
  setCooldownForAccount(account: TAccount, durationMs: number): void;
  setGlobalCooldownForAccount?(account: TAccount, durationMs: number): void;
  setModelCooldownForAccount?(account: TAccount, modelFamily: string, durationMs: number): void;
  setAmbiguousGlobalCooldownForAccount?(
    account: TAccount,
    durationMs: number,
    modelFamily?: string,
  ): number | undefined;
  reconcileAmbiguousGlobalCooldownForAccount?(
    account: TAccount,
    token: number,
    modelFamily: string,
    durationMs: number,
  ): boolean;
}

export interface RoutedRequestLease extends Releasable, RouteSummary, FailureRoute {}

export interface RouteAcquirer<T extends RoutedRequestLease> {
  acquire(sessionHeader: unknown, context?: RouteContext): T;
}

/**
 * Tie an account lease to every terminal HTTP response path while retaining
 * one explicit cleanup callback for failures that happen before forwarding.
 */
export function attachLeaseLifecycle(
  response: ResponseLifecycle,
  lease: Releasable,
): () => void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.release();
  };

  response.once("finish", release);
  response.once("close", release);
  return release;
}

/** Keep route diagnostics useful without ever copying a session ID to logs. */
export function routeReasonDetails(route: RouteSummary): string {
  return route.fallback ? `${route.reason}:fallback` : route.reason;
}

export type RouteFailureReason =
  | "token-invalid"
  | "rate-limited"
  | "service-overloaded"
  | "proxy-error";

/** Retain bounded routing context when a later failure updates the log. */
export function routeFailureDetails(
  route: RouteSummary,
  failure: RouteFailureReason,
  limitingScope?: "global" | `model:${string}` | `bucket:${string}`,
): string {
  return `${routeReasonDetails(route)}:${failure}${limitingScope ? `:${limitingScope}` : ""}`;
}

/** Acquire and immediately bind a routed lease to its response lifecycle. */
export function acquireRequestRoute<T extends RoutedRequestLease>(
  sessionHeader: unknown,
  response: ResponseLifecycle,
  router: RouteAcquirer<T>,
  context?: RouteContext,
): { route: T; release: () => void; details: string } {
  const route = context === undefined ? router.acquire(sessionHeader) : router.acquire(sessionHeader, context);
  return {
    route,
    release: attachLeaseLifecycle(response, route),
    details: routeReasonDetails(route),
  };
}

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const OVERLOAD_COOLDOWN_MS = 30_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1_000;

type FailureHeaders = Record<string, unknown>;

interface FailureAccount {
  readonly id: string;
  readonly rateLimits?: { readonly usage?: AccountUsageSnapshot };
}

interface CooldownClassification {
  readonly kind: "global" | "model";
  readonly ambiguous: boolean;
  readonly modelFamily?: string;
  readonly usageResetAtMs?: number;
}

function asHeaders(value: unknown): FailureHeaders {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as FailureHeaders;
  }
  return { "retry-after": value };
}

function header(headers: FailureHeaders, name: string): string | number | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return typeof value === "string" || typeof value === "number" ? value : undefined;
  }
  return undefined;
}

export function futureExpiry(expiryMs: number, nowMs: number): number | undefined {
  if (!Number.isFinite(expiryMs) || expiryMs <= nowMs) return undefined;
  return expiryMs - nowMs <= MAX_RATE_LIMIT_COOLDOWN_MS ? expiryMs : undefined;
}

export function retryAfterExpiry(value: unknown, nowMs: number): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return undefined;
    return futureExpiry(nowMs + numeric * 1_000, nowMs);
  }
  if (typeof value !== "string") return undefined;
  return futureExpiry(Date.parse(value), nowMs);
}

export function resetHeaderExpiry(value: unknown, nowMs: number): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
    return futureExpiry(milliseconds, nowMs);
  }
  if (typeof value !== "string") return undefined;
  return futureExpiry(Date.parse(value), nowMs);
}

function matchingModelLimit(
  account: FailureAccount,
  modelFamily: string | undefined,
) {
  if (!modelFamily) return undefined;
  const usage = account.rateLimits?.usage;
  if (!usage || usage.fetchStatus === "unavailable") return undefined;
  return usage.modelLimits.find(limit =>
    normalizeModelFamily(limit.modelFamily) === modelFamily,
  );
}

function classifyCooldown(
  claimValue: unknown,
  route: FailureRoute<FailureAccount>,
): CooldownClassification {
  const claim = typeof claimValue === "string" ? claimValue.trim().toLowerCase() : "";
  const requestedFamily = normalizeModelFamily(route.modelFamily);
  const usage = route.account.rateLimits?.usage;

  if (claim === "five_hour" || claim === "seven_day" || claim === "seven_day_oauth_apps") {
    const usageWindow = claim === "five_hour" ? usage?.fiveHour : claim === "seven_day" ? usage?.sevenDay : undefined;
    return {
      kind: "global",
      ambiguous: false,
      ...(usageWindow ? { usageResetAtMs: usageWindow.resetAt * 1_000 } : {}),
    };
  }

  if (claim === "seven_day_overage_included") {
    const matching = matchingModelLimit(route.account, requestedFamily);
    if (requestedFamily && matching?.active === true && matching.utilization >= 1) {
      return {
        kind: "model",
        ambiguous: false,
        modelFamily: requestedFamily,
        usageResetAtMs: matching.resetAt * 1_000,
      };
    }
    return { kind: "global", ambiguous: true };
  }

  if (claim.startsWith("seven_day_")) {
    const family = normalizeModelFamily(claim.slice("seven_day_".length));
    if (family) {
      const matching = matchingModelLimit(route.account, family);
      return {
        kind: "model",
        ambiguous: false,
        modelFamily: family,
        ...(matching ? { usageResetAtMs: matching.resetAt * 1_000 } : {}),
      };
    }
  }

  return { kind: "global", ambiguous: true };
}

function cooldownDurationMs(
  headers: FailureHeaders,
  classification: CooldownClassification,
  nowMs: number,
): number {
  const expiries = [
    retryAfterExpiry(header(headers, "retry-after"), nowMs),
    resetHeaderExpiry(header(headers, "anthropic-ratelimit-unified-reset"), nowMs),
    classification.usageResetAtMs === undefined
      ? undefined
      : futureExpiry(classification.usageResetAtMs, nowMs),
  ].filter((expiry): expiry is number => expiry !== undefined);
  return expiries.length > 0
    ? Math.max(...expiries) - nowMs
    : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

function setGlobalCooldown<TAccount extends { readonly id: string }>(
  pool: CooldownSetter<TAccount>,
  account: TAccount,
  durationMs: number,
  ambiguous: boolean,
  modelFamily?: string,
): number | undefined {
  if (ambiguous && pool.setAmbiguousGlobalCooldownForAccount) {
    return pool.setAmbiguousGlobalCooldownForAccount(account, durationMs, modelFamily);
  } else if (pool.setGlobalCooldownForAccount) {
    pool.setGlobalCooldownForAccount(account, durationMs);
  } else {
    pool.setCooldownForAccount(account, durationMs);
  }
  return undefined;
}

/** Narrow an ambiguity-created 429 cooldown only from a fresh, conclusive snapshot. */
export function reconcileAmbiguousRateLimitCooldown<TAccount extends FailureAccount>(
  route: FailureRoute<TAccount>,
  pool: CooldownSetter<TAccount>,
  token: number | undefined,
  now: () => number = Date.now,
): boolean {
  const family = normalizeModelFamily(route.modelFamily);
  const usage = route.account.rateLimits?.usage;
  if (token === undefined || !family || !usage || usage.fetchStatus !== "fresh") return false;
  if (!usage.fiveHour || !usage.sevenDay) return false;
  if (!Number.isFinite(usage.fiveHour.utilization) ||
    !Number.isFinite(usage.sevenDay.utilization) ||
    usage.fiveHour.utilization < 0 ||
    usage.sevenDay.utilization < 0 ||
    usage.fiveHour.utilization >= 1 ||
    usage.sevenDay.utilization >= 1) return false;
  if (canUseExtraUsage(usage.extraUsage)) return false;
  const matching = matchingModelLimit(route.account, family);
  if (!matching || !matching.active || !Number.isFinite(matching.utilization) || matching.utilization < 1) {
    return false;
  }
  if (!pool.reconcileAmbiguousGlobalCooldownForAccount) return false;

  const nowMs = now();
  const resetExpiry = futureExpiry(matching.resetAt * 1_000, nowMs);
  return pool.reconcileAmbiguousGlobalCooldownForAccount(
    route.account,
    token,
    family,
    resetExpiry === undefined ? 0 : resetExpiry - nowMs,
  );
}

export interface AppliedFailureRouting {
  readonly cooldownSeconds?: number;
  readonly ambiguousCooldownToken?: number;
  /** Bounded scope suitable for a diagnostic log, never an upstream claim. */
  readonly limitingScope?: "global" | `model:${string}`;
}

/**
 * Apply only routing state changes implied by an upstream failure. The
 * current response remains owned by the proxy's native byte stream; callers
 * use the returned seconds solely for status logging.
 */
export function applyUpstreamFailureRoutingDetailed<TAccount extends FailureAccount>(
  status: number,
  failureHeaders: unknown,
  route: FailureRoute<TAccount>,
  router: BindingInvalidator,
  pool: CooldownSetter<TAccount>,
  now: () => number = Date.now,
): AppliedFailureRouting {
  if (status !== 401 && status !== 429 && status !== 529) return {};

  if (route.sessionId !== undefined && route.bindingGeneration !== undefined) {
    router.invalidate(route.sessionId, route.account.id, route.bindingGeneration);
  }
  if (status === 429) {
    const headers = asHeaders(failureHeaders);
    const classification = classifyCooldown(
      header(headers, "anthropic-ratelimit-unified-representative-claim"),
      route,
    );
    const durationMs = cooldownDurationMs(headers, classification, now());
    let ambiguousCooldownToken: number | undefined;
    if (classification.kind === "model" && classification.modelFamily) {
      if (pool.setModelCooldownForAccount) {
        pool.setModelCooldownForAccount(route.account, classification.modelFamily, durationMs);
      } else {
        pool.setCooldownForAccount(route.account, durationMs);
      }
    } else {
      ambiguousCooldownToken = setGlobalCooldown(
        pool,
        route.account,
        durationMs,
        classification.ambiguous,
        route.modelFamily,
      );
    }
    return {
      cooldownSeconds: durationMs / 1_000,
      ...(ambiguousCooldownToken === undefined ? {} : { ambiguousCooldownToken }),
      ...(classification.ambiguous
        ? {}
        : { limitingScope: classification.kind === "model" && classification.modelFamily
          ? `model:${classification.modelFamily}` as const
          : "global" as const }),
    };
  }
  if (status === 529) {
    setGlobalCooldown(pool, route.account, OVERLOAD_COOLDOWN_MS, false);
    return { cooldownSeconds: OVERLOAD_COOLDOWN_MS / 1_000 };
  }
  return {};
}

export function applyUpstreamFailureRouting<TAccount extends FailureAccount>(
  status: number,
  failureHeaders: unknown,
  route: FailureRoute<TAccount>,
  router: BindingInvalidator,
  pool: CooldownSetter<TAccount>,
  now: () => number = Date.now,
): number | undefined {
  return applyUpstreamFailureRoutingDetailed(
    status,
    failureHeaders,
    route,
    router,
    pool,
    now,
  ).cooldownSeconds;
}
