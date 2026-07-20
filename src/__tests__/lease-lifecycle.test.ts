import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  acquireRequestRoute,
  applyUpstreamFailureRouting,
  attachLeaseLifecycle,
  routeReasonDetails,
} from "../proxy/lease-lifecycle.js";
import { SessionRouter } from "../proxy/session-router.js";
import type { RoutedAccountLease } from "../proxy/session-router.js";
import { TokenPool } from "../proxy/token-pool.js";
import type { Account } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";

function makeAccount(id: string): Account {
  return {
    id,
    tokens: {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 60_000,
      scopes: ["user:inference"],
    },
    healthy: true,
    busy: false,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
    rateLimits: { ...DEFAULT_RATE_LIMITS },
    enabled: true,
    sessionLimitPercent: 100,
    weeklyLimitPercent: 100,
  };
}

describe("attachLeaseLifecycle", () => {
  it.each(["finish", "close"] as const)("releases once on downstream %s", (event) => {
    const response = new EventEmitter();
    const release = vi.fn();
    attachLeaseLifecycle(response, { release });

    response.emit(event);
    response.emit("finish");
    response.emit("close");

    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(["proxy error", "refresh/pre-forward failure"])(
    "shares one-shot release with explicit %s cleanup",
    () => {
      const response = new EventEmitter();
      const release = vi.fn();
      const cleanup = attachLeaseLifecycle(response, { release });

      cleanup();
      cleanup();
      response.emit("finish");
      response.emit("close");

      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps explicit proxy-error cleanup safe after downstream close", () => {
    const response = new EventEmitter();
    const release = vi.fn();
    const cleanup = attachLeaseLifecycle(response, { release });

    response.emit("close");
    cleanup();
    response.emit("finish");

    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("routeReasonDetails", () => {
  it("records only the bounded routing reason, never the session identifier", () => {
    const details = routeReasonDetails({
      reason: "sticky",
      sessionId: "private-session-value",
    });

    expect(details).toBe("sticky");
    expect(details).not.toContain("private-session-value");
  });

  it("acquires the session route, attaches cleanup, and returns only reason details", () => {
    const response = new EventEmitter();
    const route = {
      account: { id: "account-a" },
      reason: "new-session" as const,
      sessionId: "private-session-value",
      release: vi.fn(),
    };
    const acquire = vi.fn().mockReturnValue(route);

    const selected = acquireRequestRoute(
      "private-session-value",
      response,
      { acquire },
    );

    expect(acquire).toHaveBeenCalledWith("private-session-value");
    expect(selected.route).toBe(route);
    expect(selected.details).toBe("new-session");
    expect(selected.details).not.toContain("private-session-value");
    selected.release();
    response.emit("close");
    expect(route.release).toHaveBeenCalledTimes(1);
  });

  it("marks emergency fallback in bounded route details without exposing the session", () => {
    const account = makeAccount("account-a");
    account.enabled = false;
    const router = new SessionRouter(new TokenPool([account]));
    const route = router.acquire("private-fallback-session");

    const details = routeReasonDetails(route);

    expect(route.fallback).toBe(true);
    expect(details).toBe("new-session:fallback");
    expect(details).not.toContain("private-fallback-session");
    route.release();
  });
});

describe("applyUpstreamFailureRouting", () => {
  const route = {
    account: makeAccount("account-a"),
    sessionId: "session-a",
    bindingGeneration: 7,
  };

  it("invalidates the matching binding on 401 without applying a cooldown", () => {
    const invalidate = vi.fn();
    const setCooldownForAccount = vi.fn();

    expect(applyUpstreamFailureRouting(401, undefined, route, { invalidate }, { setCooldownForAccount }))
      .toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith("session-a", "account-a", 7);
    expect(setCooldownForAccount).not.toHaveBeenCalled();
  });

  it("invalidates and applies a numeric Retry-After cooldown on 429", () => {
    const invalidate = vi.fn();
    const setCooldownForAccount = vi.fn();

    expect(applyUpstreamFailureRouting(429, "12.5", route, { invalidate }, { setCooldownForAccount }))
      .toBe(12.5);
    expect(invalidate).toHaveBeenCalledWith("session-a", "account-a", 7);
    expect(setCooldownForAccount).toHaveBeenCalledWith(route.account, 12_500);
  });

  it.each([
    undefined,
    "",
    "   ",
    "not-a-number",
    "-1",
    "Infinity",
    "1e308",
    ["1"],
    ["1", "2"],
  ])(
    "uses the 60-second 429 fallback for an unsafe Retry-After value %j",
    (retryAfter) => {
      const invalidate = vi.fn();
      const setCooldownForAccount = vi.fn();

      expect(applyUpstreamFailureRouting(429, retryAfter, route, { invalidate }, { setCooldownForAccount }))
        .toBe(60);
      expect(setCooldownForAccount).toHaveBeenCalledWith(route.account, 60_000);
    },
  );

  it("accepts a finite zero-second Retry-After value", () => {
    const invalidate = vi.fn();
    const setCooldownForAccount = vi.fn();

    expect(applyUpstreamFailureRouting(429, "0", route, { invalidate }, { setCooldownForAccount }))
      .toBe(0);
    expect(setCooldownForAccount).toHaveBeenCalledWith(route.account, 0);
  });

  it("invalidates and applies the fixed 30-second cooldown on 529", () => {
    const invalidate = vi.fn();
    const setCooldownForAccount = vi.fn();

    expect(applyUpstreamFailureRouting(529, "900", route, { invalidate }, { setCooldownForAccount }))
      .toBe(30);
    expect(invalidate).toHaveBeenCalledWith("session-a", "account-a", 7);
    expect(setCooldownForAccount).toHaveBeenCalledWith(route.account, 30_000);
  });

  it("does not mutate routing for successful responses", () => {
    const invalidate = vi.fn();
    const setCooldownForAccount = vi.fn();

    expect(applyUpstreamFailureRouting(200, undefined, route, { invalidate }, { setCooldownForAccount }))
      .toBeUndefined();
    expect(invalidate).not.toHaveBeenCalled();
    expect(setCooldownForAccount).not.toHaveBeenCalled();
  });

  it("ignores an old same-account failure after the session was rebound", () => {
    const pool = new TokenPool([makeAccount("a")]);
    const router = new SessionRouter(pool);
    const oldRoute = router.acquire("session-a");
    oldRoute.release();
    router.invalidate(oldRoute.sessionId, oldRoute.account.id, oldRoute.bindingGeneration);
    const rebound = router.acquire("session-a");
    rebound.release();

    applyUpstreamFailureRouting(401, undefined, oldRoute, router, pool);

    const sticky = router.acquire("session-a");
    expect(sticky.reason).toBe("sticky");
    expect(sticky.bindingGeneration).toBe(rebound.bindingGeneration);
    sticky.release();
  });

  it("does not invalidate a binding when a malformed scoped route omits its generation", () => {
    const pool = new TokenPool([makeAccount("a")]);
    const router = new SessionRouter(pool);
    const current = router.acquire("session-a");
    current.release();
    const malformedRoute = {
      account: current.account,
      reason: "sticky",
      sessionId: current.sessionId,
      fallback: false,
      release: vi.fn(),
    } as unknown as RoutedAccountLease;

    applyUpstreamFailureRouting(401, undefined, malformedRoute, router, pool);

    const sticky = router.acquire("session-a");
    expect(sticky.reason).toBe("sticky");
    expect(sticky.bindingGeneration).toBe(current.bindingGeneration);
    sticky.release();
  });

  it("does not cool down a replacement account from an old incarnation's failure", () => {
    const oldAccount = makeAccount("a");
    const pool = new TokenPool([oldAccount]);
    const router = new SessionRouter(pool);
    const oldRoute = router.acquire("session-a");
    oldRoute.release();
    pool.removeAccount("a");
    pool.addAccount({
      id: "a",
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
      expiresAt: Date.now() + 60_000,
      scopes: ["user:inference"],
    });

    applyUpstreamFailureRouting(429, "60", oldRoute, router, pool);

    expect(pool.isCoolingDown("a")).toBe(false);
  });
});
