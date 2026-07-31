import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  acquireRequestRoute,
  applyUpstreamFailureRouting,
  applyUpstreamFailureRoutingDetailed,
  attachLeaseLifecycle,
  reconcileAmbiguousRateLimitCooldown,
  routeFailureDetails,
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

const SONNET_CONTEXT = { modelFamily: "sonnet" } as const;
const OPUS_CONTEXT = { modelFamily: "opus" } as const;

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

  it("marks user-cap fallback in bounded route details without exposing the session", () => {
    const account = makeAccount("account-a");
    account.sessionLimitPercent = 0;
    const router = new SessionRouter(new TokenPool([account]));
    const route = router.acquire("private-fallback-session");

    const details = routeReasonDetails(route);

    expect(route.fallback).toBe(true);
    expect(details).toBe("new-session:fallback");
    expect(details).not.toContain("private-fallback-session");
    route.release();
  });

  it.each(["rate-limited", "proxy-error"] as const)(
    "retains fallback routing details after a %s failure without exposing the session",
    (failure) => {
      const account = makeAccount("account-a");
      account.sessionLimitPercent = 0;
      const router = new SessionRouter(new TokenPool([account]));
      const route = router.acquire("private-fallback-session");

      const details = routeFailureDetails(route, failure);

      expect(details).toBe(`new-session:fallback:${failure}`);
      expect(details).not.toContain("private-fallback-session");
      route.release();
    },
  );
});

describe("applyUpstreamFailureRouting", () => {
  const route = {
    account: makeAccount("account-a"),
    sessionId: "session-a",
    bindingGeneration: 7,
    modelFamily: "sonnet",
  };

  function cooldowns() {
    return {
      setCooldownForAccount: vi.fn(),
      setGlobalCooldownForAccount: vi.fn(),
      setModelCooldownForAccount: vi.fn(),
      setAmbiguousGlobalCooldownForAccount: vi.fn().mockReturnValue(123),
    };
  }

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
    const pool = cooldowns();

    expect(applyUpstreamFailureRouting(429, { "retry-after": "12.5", "anthropic-ratelimit-unified-representative-claim": "five_hour" }, route, { invalidate }, pool, () => 1_000))
      .toBe(12.5);
    expect(invalidate).toHaveBeenCalledWith("session-a", "account-a", 7);
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(route.account, 12_500);
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
      const pool = cooldowns();

      expect(applyUpstreamFailureRouting(429, { "retry-after": retryAfter }, route, { invalidate }, pool, () => 1_000))
        .toBe(60);
      expect(pool.setAmbiguousGlobalCooldownForAccount)
        .toHaveBeenCalledWith(route.account, 60_000, "sonnet");
    },
  );

  it("rejects a zero-second Retry-After because it is not a future expiry", () => {
    const invalidate = vi.fn();
    const pool = cooldowns();

    expect(applyUpstreamFailureRouting(429, { "retry-after": "0" }, route, { invalidate }, pool, () => 1_000))
      .toBe(60);
    expect(pool.setAmbiguousGlobalCooldownForAccount)
      .toHaveBeenCalledWith(route.account, 60_000, "sonnet");
  });

  it.each(["five_hour", "seven_day", "seven_day_oauth_apps"])(
    "classifies the representative claim %s as account-global",
    (claim) => {
      const pool = cooldowns();
      applyUpstreamFailureRouting(
        429,
        {
          "retry-after": "10",
          "anthropic-ratelimit-unified-representative-claim": claim,
        },
        route,
        { invalidate: vi.fn() },
        pool,
        () => 1_000,
      );

      expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(route.account, 10_000);
      expect(pool.setModelCooldownForAccount).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["seven_day_sonnet", "sonnet"],
    ["seven_day_opus", "opus"],
    ["seven_day_custom_family", "custom-family"],
  ])("classifies representative claim %s as model family %s", (claim, family) => {
    const pool = cooldowns();
    applyUpstreamFailureRouting(
      429,
      {
        "retry-after": "10",
        "anthropic-ratelimit-unified-representative-claim": claim,
      },
      route,
      { invalidate: vi.fn() },
      pool,
      () => 1_000,
    );

    expect(pool.setModelCooldownForAccount).toHaveBeenCalledWith(route.account, family, 10_000);
    expect(pool.setGlobalCooldownForAccount).not.toHaveBeenCalled();
  });

  it("scopes overage-included to the requested model only with matching exhausted evidence", () => {
    const account = makeAccount("account-a");
    account.rateLimits.usage = {
      modelLimits: [{
        kind: "weekly_scoped",
        group: "weekly",
        modelFamily: "sonnet",
        displayName: "Sonnet",
        utilization: 1,
        resetAt: 120,
        active: true,
        severity: "",
      }],
      fetchedAt: 900,
      fetchStatus: "fresh",
    };
    const pool = cooldowns();

    applyUpstreamFailureRouting(
      429,
      {
        "retry-after": "10",
        "anthropic-ratelimit-unified-representative-claim": "seven_day_overage_included",
      },
      { ...route, account },
      { invalidate: vi.fn() },
      pool,
      () => 1_000,
    );

    expect(pool.setModelCooldownForAccount).toHaveBeenCalledWith(account, "sonnet", 119_000);
  });

  it("does not use an inactive exhausted model limit to narrow an overage claim", () => {
    const account = makeAccount("account-a");
    account.rateLimits.usage = {
      modelLimits: [{
        kind: "weekly_scoped",
        group: "weekly",
        modelFamily: "sonnet",
        displayName: "Sonnet",
        utilization: 1,
        resetAt: 120,
        active: false,
        severity: "",
      }],
      fetchedAt: 900,
      fetchStatus: "fresh",
    };
    const pool = cooldowns();

    applyUpstreamFailureRouting(
      429,
      {
        "retry-after": "10",
        "anthropic-ratelimit-unified-representative-claim": "seven_day_overage_included",
      },
      { ...route, account },
      { invalidate: vi.fn() },
      pool,
      () => 1_000,
    );

    expect(pool.setModelCooldownForAccount).not.toHaveBeenCalled();
    expect(pool.setAmbiguousGlobalCooldownForAccount)
      .toHaveBeenCalledWith(account, 10_000, "sonnet");
  });

  it.each(["seven_day_overage_included", "", "future_unknown_claim"])(
    "uses an ambiguity-marked global cooldown for claim %j without matching evidence",
    (claim) => {
      const pool = cooldowns();
      applyUpstreamFailureRouting(
        429,
        {
          "retry-after": "10",
          "anthropic-ratelimit-unified-representative-claim": claim,
        },
        route,
        { invalidate: vi.fn() },
        pool,
        () => 1_000,
      );

      expect(pool.setAmbiguousGlobalCooldownForAccount)
        .toHaveBeenCalledWith(route.account, 10_000, "sonnet");
      expect(pool.setModelCooldownForAccount).not.toHaveBeenCalled();
    },
  );

  it("uses the greatest trustworthy future expiry from retry, unified, and usage reset evidence", () => {
    const now = Date.parse("2026-07-31T12:00:00Z");
    const account = makeAccount("account-a");
    account.rateLimits.usage = {
      modelLimits: [{
        kind: "weekly_scoped",
        group: "weekly",
        modelFamily: "sonnet",
        displayName: "Sonnet",
        utilization: 1,
        resetAt: (now + 40_000) / 1_000,
        active: true,
        severity: "",
      }],
      fetchedAt: now,
      fetchStatus: "fresh",
    };
    const pool = cooldowns();

    expect(applyUpstreamFailureRouting(
      429,
      {
        "retry-after": new Date(now + 20_000).toUTCString(),
        "anthropic-ratelimit-unified-reset": String((now + 30_000) / 1_000),
        "anthropic-ratelimit-unified-representative-claim": "seven_day_sonnet",
      },
      { ...route, account },
      { invalidate: vi.fn() },
      pool,
      () => now,
    )).toBe(40);
    expect(pool.setModelCooldownForAccount).toHaveBeenCalledWith(account, "sonnet", 40_000);
  });

  it("rejects unreasonably distant reset timestamps", () => {
    const pool = cooldowns();
    expect(applyUpstreamFailureRouting(
      429,
      {
        "retry-after": "315360000",
        "anthropic-ratelimit-unified-reset": "253402300799",
      },
      route,
      { invalidate: vi.fn() },
      pool,
      () => 1_000,
    )).toBe(60);
  });

  it("narrows an ambiguous global cooldown after a conclusive fresh usage refresh", () => {
    const now = 1_000_000;
    const account = makeAccount("account-a");
    const pool = new TokenPool([account], { now: () => now });
    const refreshedRoute = { ...route, account };
    const applied = applyUpstreamFailureRoutingDetailed(
      429,
      { "retry-after": "60" },
      refreshedRoute,
      { invalidate: vi.fn() },
      pool,
      () => now,
    );
    account.rateLimits.usage = {
      fiveHour: { utilization: 0.5, resetAt: 1_100 },
      sevenDay: { utilization: 0.5, resetAt: 1_200 },
      modelLimits: [{
        kind: "weekly_scoped",
        group: "weekly",
        modelFamily: "sonnet",
        displayName: "Sonnet",
        utilization: 1,
        resetAt: 1_090,
        active: true,
        severity: "",
      }],
      extraUsage: { enabled: false, spendLimitReached: false },
      fetchedAt: now,
      fetchStatus: "fresh",
    };
    account.rateLimits.status = "rate_limited";
    account.rateLimits.claim = "";

    expect(reconcileAmbiguousRateLimitCooldown(
      refreshedRoute,
      pool,
      applied.ambiguousCooldownToken,
      () => now,
    )).toBe(true);
    expect(account.rateLimits.status).toBe("allowed");
    expect(pool.getApplicableCooldownUntil("account-a", OPUS_CONTEXT)).toBe(0);
    expect(pool.getApplicableCooldownUntil("account-a", SONNET_CONTEXT)).toBe(1_090_000);
  });

  it("does not broaden a model cooldown from an unavailable refresh snapshot", () => {
    const now = 1_000_000;
    const account = makeAccount("account-a");
    const pool = new TokenPool([account], { now: () => now });
    const refreshedRoute = { ...route, account };
    applyUpstreamFailureRouting(
      429,
      {
        "retry-after": "60",
        "anthropic-ratelimit-unified-representative-claim": "seven_day_sonnet",
      },
      refreshedRoute,
      { invalidate: vi.fn() },
      pool,
      () => now,
    );
    account.rateLimits.usage = {
      modelLimits: [],
      fetchedAt: now,
      fetchStatus: "unavailable",
    };

    expect(reconcileAmbiguousRateLimitCooldown(refreshedRoute, pool, undefined, () => now)).toBe(false);
    expect(pool.getApplicableCooldownUntil("account-a", OPUS_CONTEXT)).toBe(0);
    expect(pool.getApplicableCooldownUntil("account-a", SONNET_CONTEXT)).toBe(1_060_000);
  });

  it("bounds a malformed distant model reset during ambiguity reconciliation", () => {
    const now = 1_000_000;
    const account = makeAccount("account-a");
    const pool = new TokenPool([account], { now: () => now });
    const refreshedRoute = { ...route, account };
    const applied = applyUpstreamFailureRoutingDetailed(
      429,
      { "retry-after": "60" },
      refreshedRoute,
      { invalidate: vi.fn() },
      pool,
      () => now,
    );
    account.rateLimits.usage = {
      fiveHour: { utilization: 0.5, resetAt: 1_100 },
      sevenDay: { utilization: 0.5, resetAt: 1_200 },
      modelLimits: [{
        kind: "weekly_scoped",
        group: "weekly",
        modelFamily: "sonnet",
        displayName: "Sonnet",
        utilization: 1,
        resetAt: 253_402_300_799,
        active: true,
        severity: "",
      }],
      extraUsage: { enabled: false, spendLimitReached: false },
      fetchedAt: now,
      fetchStatus: "fresh",
    };

    expect(reconcileAmbiguousRateLimitCooldown(
      refreshedRoute,
      pool,
      applied.ambiguousCooldownToken,
      () => now,
    )).toBe(true);
    expect(pool.getApplicableCooldownUntil("account-a", SONNET_CONTEXT)).toBe(1_060_000);
    expect(pool.getEarliestCooldownUntil("account-a")).toBe(1_060_000);
  });

  it("keeps an ambiguous global cooldown when refreshed model evidence is inactive", () => {
    const now = 1_000_000;
    const account = makeAccount("account-a");
    const pool = new TokenPool([account], { now: () => now });
    const refreshedRoute = { ...route, account };
    const applied = applyUpstreamFailureRoutingDetailed(
      429,
      { "retry-after": "60" },
      refreshedRoute,
      { invalidate: vi.fn() },
      pool,
      () => now,
    );
    account.rateLimits.usage = {
      fiveHour: { utilization: 0.5, resetAt: 1_100 },
      sevenDay: { utilization: 0.5, resetAt: 1_200 },
      modelLimits: [{
        kind: "weekly_scoped",
        group: "weekly",
        modelFamily: "sonnet",
        displayName: "Sonnet",
        utilization: 1,
        resetAt: 1_060,
        active: false,
        severity: "",
      }],
      extraUsage: { enabled: false, spendLimitReached: false },
      fetchedAt: now,
      fetchStatus: "fresh",
    };

    expect(reconcileAmbiguousRateLimitCooldown(
      refreshedRoute,
      pool,
      applied.ambiguousCooldownToken,
      () => now,
    )).toBe(false);
    expect(pool.getApplicableCooldownUntil("account-a", OPUS_CONTEXT)).toBe(1_060_000);
  });

  it("keeps simultaneous ambiguous model failures independently reconcilable", () => {
    const now = 1_000_000;
    const account = makeAccount("account-a");
    const pool = new TokenPool([account], { now: () => now });
    const sonnetRoute = { ...route, account, modelFamily: "sonnet" };
    const opusRoute = { ...route, account, modelFamily: "opus" };
    const sonnetFailure = applyUpstreamFailureRoutingDetailed(
      429,
      { "retry-after": "60" },
      sonnetRoute,
      { invalidate: vi.fn() },
      pool,
      () => now,
    );
    const opusFailure = applyUpstreamFailureRoutingDetailed(
      429,
      { "retry-after": "90" },
      opusRoute,
      { invalidate: vi.fn() },
      pool,
      () => now,
    );
    expect(sonnetFailure.ambiguousCooldownToken)
      .not.toBe(opusFailure.ambiguousCooldownToken);
    account.rateLimits.usage = {
      fiveHour: { utilization: 0.5, resetAt: 1_100 },
      sevenDay: { utilization: 0.5, resetAt: 1_200 },
      modelLimits: [
        {
          kind: "weekly_scoped", group: "weekly", modelFamily: "sonnet",
          displayName: "Sonnet", utilization: 1, resetAt: 1_060, active: true, severity: "",
        },
        {
          kind: "weekly_scoped", group: "weekly", modelFamily: "opus",
          displayName: "Opus", utilization: 1, resetAt: 1_090, active: true, severity: "",
        },
      ],
      extraUsage: { enabled: false, spendLimitReached: false },
      fetchedAt: now,
      fetchStatus: "fresh",
    };

    expect(reconcileAmbiguousRateLimitCooldown(
      sonnetRoute,
      pool,
      sonnetFailure.ambiguousCooldownToken,
      () => now,
    )).toBe(true);
    expect(pool.getApplicableCooldownUntil("account-a", OPUS_CONTEXT)).toBe(1_090_000);

    expect(reconcileAmbiguousRateLimitCooldown(
      opusRoute,
      pool,
      opusFailure.ambiguousCooldownToken,
      () => now,
    )).toBe(true);
    expect(pool.getApplicableCooldownUntil("account-a", SONNET_CONTEXT)).toBe(1_060_000);
    expect(pool.getApplicableCooldownUntil("account-a", OPUS_CONTEXT)).toBe(1_090_000);
  });

  it("invalidates and applies the fixed 30-second cooldown on 529", () => {
    const invalidate = vi.fn();
    const pool = cooldowns();

    expect(applyUpstreamFailureRouting(529, { "retry-after": "900" }, route, { invalidate }, pool))
      .toBe(30);
    expect(invalidate).toHaveBeenCalledWith("session-a", "account-a", 7);
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(route.account, 30_000);
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
