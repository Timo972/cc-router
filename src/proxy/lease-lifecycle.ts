export interface ResponseLifecycle {
  once(event: "finish" | "close", listener: () => void): unknown;
}

export interface Releasable {
  release(): void;
}

export interface RouteSummary {
  readonly reason: "sticky" | "new-session" | "unscoped" | "failover";
  readonly sessionId?: string;
}

export interface FailureRoute {
  readonly account: { readonly id: string };
  readonly sessionId?: string;
}

export interface BindingInvalidator {
  invalidate(sessionHeader: unknown, expectedAccountId?: string): boolean;
}

export interface CooldownSetter {
  setCooldown(accountId: string, durationMs: number): void;
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
  return route.reason;
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
  const candidate = Array.isArray(value)
    ? value.length === 1 ? Number(value[0]) : Number.NaN
    : Number(value);
  return Number.isFinite(candidate) && candidate >= 0 ? candidate : 60;
}

/**
 * Apply only routing state changes implied by an upstream failure. The
 * current response remains owned by the proxy's native byte stream; callers
 * use the returned seconds solely for status logging.
 */
export function applyUpstreamFailureRouting(
  status: number,
  retryAfterHeader: unknown,
  route: FailureRoute,
  router: BindingInvalidator,
  pool: CooldownSetter,
): number | undefined {
  if (status !== 401 && status !== 429 && status !== 529) return undefined;

  router.invalidate(route.sessionId, route.account.id);
  if (status === 429) {
    const seconds = retryAfterSeconds(retryAfterHeader);
    pool.setCooldown(route.account.id, seconds * 1_000);
    return seconds;
  }
  if (status === 529) {
    pool.setCooldown(route.account.id, 30_000);
    return 30;
  }
  return undefined;
}
