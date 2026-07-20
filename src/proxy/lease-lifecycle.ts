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
}

export interface RoutedRequestLease extends Releasable, RouteSummary, FailureRoute {}

export interface RouteAcquirer<T extends RoutedRequestLease> {
  acquire(sessionHeader: unknown): T;
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
): string {
  return `${routeReasonDetails(route)}:${failure}`;
}

/** Acquire and immediately bind a routed lease to its response lifecycle. */
export function acquireRequestRoute<T extends RoutedRequestLease>(
  sessionHeader: unknown,
  response: ResponseLifecycle,
  router: RouteAcquirer<T>,
): { route: T; release: () => void; details: string } {
  const route = router.acquire(sessionHeader);
  return {
    route,
    release: attachLeaseLifecycle(response, route),
    details: routeReasonDetails(route),
  };
}

function retryAfterSeconds(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") return 60;
  if (typeof value === "string" && value.trim().length === 0) return 60;

  const candidate = Number(value);
  const milliseconds = candidate * 1_000;
  return Number.isFinite(candidate) &&
    candidate >= 0 &&
    Number.isFinite(milliseconds)
    ? candidate
    : 60;
}

/**
 * Apply only routing state changes implied by an upstream failure. The
 * current response remains owned by the proxy's native byte stream; callers
 * use the returned seconds solely for status logging.
 */
export function applyUpstreamFailureRouting<TAccount extends { readonly id: string }>(
  status: number,
  retryAfterHeader: unknown,
  route: FailureRoute<TAccount>,
  router: BindingInvalidator,
  pool: CooldownSetter<TAccount>,
): number | undefined {
  if (status !== 401 && status !== 429 && status !== 529) return undefined;

  if (route.sessionId !== undefined && route.bindingGeneration !== undefined) {
    router.invalidate(route.sessionId, route.account.id, route.bindingGeneration);
  }
  if (status === 429) {
    const seconds = retryAfterSeconds(retryAfterHeader);
    pool.setCooldownForAccount(route.account, seconds * 1_000);
    return seconds;
  }
  if (status === 529) {
    pool.setCooldownForAccount(route.account, 30_000);
    return 30;
  }
  return undefined;
}
