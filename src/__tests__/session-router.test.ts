import { describe, expect, it, vi } from "vitest";
import { SessionRouter, normalizeSessionId } from "../proxy/session-router.js";
import type { RoutedAccountLease } from "../proxy/session-router.js";
import { TokenPool } from "../proxy/token-pool.js";
import type { Account } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS, type RouteContext } from "../proxy/types.js";
import type { AccountLease as GenericAccountLease, AccountPool } from "../proxy/account-pool.js";

function makeAccount(id: string): Account {
  return {
    id,
    tokens: {
      accessToken: `sk-ant-oat01-${id}`,
      refreshToken: `sk-ant-ort01-${id}`,
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference", "user:profile"],
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

if (false) {
  // @ts-expect-error A scoped route cannot compile without a binding generation.
  const scopedRouteMissingGeneration: RoutedAccountLease = {
    account: makeAccount("compile-only"),
    fallback: false,
    release: () => undefined,
    reason: "sticky",
    sessionId: "session-a",
  };
  void scopedRouteMissingGeneration;
}

describe("session ID normalization", () => {
  it("normalizes one bounded string header", () => {
    expect(normalizeSessionId("  session-a  ")).toBe("session-a");
    expect(normalizeSessionId("   ")).toBeUndefined();
    expect(normalizeSessionId(["a", "b"])).toBeUndefined();
    expect(normalizeSessionId(42)).toBeUndefined();
    expect(normalizeSessionId(` ${"é".repeat(128)} `)).toBe("é".repeat(128));
    expect(normalizeSessionId("é".repeat(129))).toBeUndefined();
    expect(normalizeSessionId("a".repeat(257))).toBeUndefined();
  });
});

describe("SessionRouter", () => {
  it("keeps repeated requests from one session on its account", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    const router = new SessionRouter(pool);

    const first = router.acquire("session-a");
    const second = router.acquire("session-a");

    expect(first.account.id).toBe(second.account.id);
    expect(first.reason).toBe("new-session");
    expect(second.reason).toBe("sticky");
    first.release();
    second.release();
  });

  it("returns both identity fields on every scoped route and neither on unscoped routes", () => {
    const a = makeAccount("a");
    const pool = new TokenPool([a, makeAccount("b")]);
    const router = new SessionRouter(pool);
    const created = router.acquire("session-a");
    const sticky = router.acquire("session-a");
    a.enabled = false;
    const failover = router.acquire("session-a");
    const unscoped = router.acquire(undefined);

    for (const route of [created, sticky, failover]) {
      expect(route.sessionId).toBe("session-a");
      expect(typeof route.bindingGeneration).toBe("number");
    }
    expect(unscoped.reason).toBe("unscoped");
    expect("sessionId" in unscoped).toBe(false);
    expect("bindingGeneration" in unscoped).toBe(false);

    created.release();
    sticky.release();
    failover.release();
    unscoped.release();
  });

  it("binds simultaneous new sessions to separate idle accounts", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    const router = new SessionRouter(pool);

    const first = router.acquire("session-a");
    const second = router.acquire("session-b");

    expect(first.account.id).toBe("a");
    expect(second.account.id).toBe("b");
    expect(router.getActiveSessionCount("a")).toBe(1);
    expect(router.getActiveSessionCount("b")).toBe(1);
    expect(router.getBindingCount()).toBe(2);
    first.release();
    second.release();
  });

  it("load-balances unscoped requests without creating bindings", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    const router = new SessionRouter(pool);

    const first = router.acquire(undefined);
    const second = router.acquire(["invalid"]);

    expect(first.account.id).toBe("a");
    expect(second.account.id).toBe("b");
    expect(first.reason).toBe("unscoped");
    expect(second.reason).toBe("unscoped");
    expect(first.sessionId).toBeUndefined();
    expect(router.getBindingCount()).toBe(0);
    first.release();
    second.release();
  });

  it("keeps a valid sticky binding despite lower load elsewhere", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    const router = new SessionRouter(pool);
    const first = router.acquire("session-a");

    expect(pool.getInFlight("a")).toBe(1);
    expect(pool.getInFlight("b")).toBe(0);

    const sticky = router.acquire("session-a");
    expect(sticky.account.id).toBe("a");
    expect(sticky.reason).toBe("sticky");

    first.release();
    sticky.release();
  });

  it("keeps paid-extra sessions sticky when the default 100% setting is uncapped", () => {
    const now = 1_000_000;
    const a = makeAccount("a");
    const b = makeAccount("b");
    for (const account of [a, b]) {
      account.rateLimits.usage = {
        fiveHour: { utilization: 1, resetAt: 2_000 },
        modelLimits: [],
        extraUsage: { enabled: true, spendLimitReached: false },
        fetchedAt: 100,
        fetchStatus: "fresh",
      };
    }
    const pool = new TokenPool([a, b], { now: () => now });
    const capBypass = vi.fn();
    pool.onCapBypass = capBypass;
    const router = new SessionRouter(pool);

    const first = router.acquire("paid-session");
    first.release();
    const second = router.acquire("paid-session");

    expect(first.account).toBe(a);
    expect(first.fallback).toBe(false);
    expect(second.account).toBe(a);
    expect(second.reason).toBe("sticky");
    expect(second.fallback).toBe(false);
    expect(capBypass).not.toHaveBeenCalled();
    second.release();
  });

  it.each([
    ["disabled", (account: Account, pool: TokenPool) => { account.enabled = false; }],
    ["unhealthy", (account: Account, pool: TokenPool) => { account.healthy = false; }],
    ["capped", (account: Account, pool: TokenPool) => {
      account.sessionLimitPercent = 50;
      account.rateLimits.fiveHourUtil = 0.5;
    }],
    ["cooling down", (account: Account, pool: TokenPool) => { pool.setCooldown(account.id, 60_000); }],
    ["removed", (account: Account, pool: TokenPool) => { pool.removeAccount(account.id); }],
  ])("fails over when the bound account is %s", (_label, makeUnavailable) => {
    const a = makeAccount("a");
    const pool = new TokenPool([a, makeAccount("b")]);
    const router = new SessionRouter(pool);
    router.acquire("session-a").release();

    makeUnavailable(a, pool);
    const failover = router.acquire("session-a");

    expect(failover.account.id).toBe("b");
    expect(failover.reason).toBe("failover");
    expect(router.getActiveSessionCount("a")).toBe(0);
    expect(router.getActiveSessionCount("b")).toBe(1);
    failover.release();
  });

  it("does not let an old response invalidate a newer binding", () => {
    const a = makeAccount("a");
    const pool = new TokenPool([a, makeAccount("b")]);
    const router = new SessionRouter(pool);
    router.acquire("session-a").release();
    a.enabled = false;
    const rebound = router.acquire("session-a");
    rebound.release();

    expect(router.invalidate("session-a", "a")).toBe(false);
    expect(router.getActiveSessionCount("b")).toBe(1);

    const sticky = router.acquire("session-a");
    expect(sticky.account.id).toBe("b");
    expect(sticky.reason).toBe("sticky");
    sticky.release();

    expect(router.invalidate("session-a", "b")).toBe(true);
    expect(router.getBindingCount()).toBe(0);
  });

  it("does not let an old same-account response invalidate a rebound generation", () => {
    const pool = new TokenPool([makeAccount("a")]);
    const router = new SessionRouter(pool);
    const oldRoute = router.acquire("session-a");
    oldRoute.release();

    expect(router.invalidate(
      oldRoute.sessionId,
      oldRoute.account.id,
      oldRoute.bindingGeneration,
    )).toBe(true);
    const rebound = router.acquire("session-a");
    rebound.release();

    expect(rebound.account).toBe(oldRoute.account);
    expect(rebound.bindingGeneration).not.toBe(oldRoute.bindingGeneration);
    expect(router.invalidate(
      oldRoute.sessionId,
      oldRoute.account.id,
      oldRoute.bindingGeneration,
    )).toBe(false);

    const sticky = router.acquire("session-a");
    expect(sticky.reason).toBe("sticky");
    expect(sticky.bindingGeneration).toBe(rebound.bindingGeneration);
    sticky.release();
  });

  it("invalidates every binding for one account and repairs counts", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    const router = new SessionRouter(pool);
    router.acquire("session-1").release();
    router.acquire("session-2").release();
    router.acquire("session-3").release();

    expect(router.getActiveSessionCount("a")).toBe(2);
    expect(router.getActiveSessionCount("b")).toBe(1);
    expect(router.invalidateAccount("a")).toBe(2);
    expect(router.getActiveSessionCount("a")).toBe(0);
    expect(router.getActiveSessionCount("b")).toBe(1);
    expect(router.getBindingCount()).toBe(1);
  });

  it("refreshes last-seen on access and expires at one hour of inactivity", () => {
    const hour = 60 * 60 * 1000;
    let now = 100;
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")], { now: () => now });
    const router = new SessionRouter(pool, { now: () => now });
    router.acquire("session-a").release();

    now += hour - 1;
    const refreshed = router.acquire("session-a");
    expect(refreshed.reason).toBe("sticky");
    refreshed.release();

    now += hour - 1;
    const stillSticky = router.acquire("session-a");
    expect(stillSticky.reason).toBe("sticky");
    stillSticky.release();

    now += hour;
    const expired = router.acquire("session-a");
    expect(expired.reason).toBe("new-session");
    expect(router.getBindingCount()).toBe(1);
    expired.release();
  });

  it("sweeps expired bindings when reading the total binding count", () => {
    let now = 0;
    const pool = new TokenPool([makeAccount("a")], { now: () => now });
    const router = new SessionRouter(pool, { now: () => now, ttlMs: 10 });
    router.acquire("session-a").release();

    now = 10;

    expect(router.getBindingCount()).toBe(0);
  });

  it("sweeps expired bindings when reading an account's active session count", () => {
    let now = 0;
    const pool = new TokenPool([makeAccount("a")], { now: () => now });
    const router = new SessionRouter(pool, { now: () => now, ttlMs: 10 });
    router.acquire("session-a").release();

    now = 10;

    expect(router.getActiveSessionCount("a")).toBe(0);
  });

  it("returns one aggregate account snapshot after a single expiry sweep", () => {
    let now = 0;
    let clockReads = 0;
    const clock = () => {
      clockReads++;
      return now;
    };
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")], { now: clock });
    const router = new SessionRouter(pool, { now: clock, ttlMs: 10 });
    router.acquire("expired-session").release();
    now = 5;
    router.acquire("live-session").release();
    now = 10;
    clockReads = 0;

    const snapshot = router.getActiveSessionCountsSnapshot();

    expect(clockReads).toBe(1);
    expect([...snapshot]).toEqual([["b", 1]]);
    expect([...snapshot.keys()]).not.toContain("expired-session");
    expect([...snapshot.keys()]).not.toContain("live-session");
  });

  it("sweeps expired bindings before applying the capacity limit", () => {
    let now = 0;
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")], { now: () => now });
    const router = new SessionRouter(pool, { now: () => now, ttlMs: 10, maxEntries: 2 });
    router.acquire("expired").release();
    now = 5;
    router.acquire("live").release();

    now = 10;
    router.acquire("new").release();

    expect(router.getBindingCount()).toBe(2);
    expect(router.invalidate("expired")).toBe(false);
    expect(router.invalidate("live")).toBe(true);
    expect(router.invalidate("new")).toBe(true);
  });

  it("evicts the least recently used binding with insertion order as tie-break", () => {
    let now = 0;
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")], { now: () => now });
    const router = new SessionRouter(pool, { now: () => now, maxEntries: 2 });
    router.acquire("oldest-tie").release();
    router.acquire("newer-tie").release();

    router.acquire("third").release();

    expect(router.getBindingCount()).toBe(2);
    expect(router.invalidate("oldest-tie")).toBe(false);
    expect(router.invalidate("newer-tie")).toBe(true);
    expect(router.invalidate("third")).toBe(true);
  });

  it("updates recency so a recently used binding survives LRU eviction", () => {
    let now = 0;
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")], { now: () => now });
    const router = new SessionRouter(pool, { now: () => now, maxEntries: 2 });
    router.acquire("first").release();
    now = 1;
    router.acquire("second").release();
    now = 2;
    router.acquire("first").release();
    now = 3;
    router.acquire("third").release();

    expect(router.invalidate("first")).toBe(true);
    expect(router.invalidate("second")).toBe(false);
    expect(router.invalidate("third")).toBe(true);
  });

  it("does not log session IDs or expose bindings through its public results", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const router = new SessionRouter(new TokenPool([makeAccount("a")]));

    const lease = router.acquire("private-session-id");

    expect(lease.sessionId).toBe("private-session-id");
    expect(Object.keys(lease).sort()).toEqual(
      ["account", "bindingGeneration", "fallback", "reason", "release", "sessionId"].sort(),
    );
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    lease.release();
    log.mockRestore();
    warn.mockRestore();
  });

  it("keeps one binding when both requested model families are available", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    const router = new SessionRouter(pool);

    const first = router.acquire("session-a", { modelFamily: "sonnet" });
    const second = router.acquire("session-a", { modelFamily: "opus" });

    expect(first.account.id).toBe("a");
    expect(second.account.id).toBe("a");
    expect(second.reason).toBe("sticky");
    expect(second.modelFamily).toBe("opus");
    first.release();
    second.release();
  });

  it("rebinds only when the bound account is hard-ineligible for the requested model", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    const router = new SessionRouter(pool);
    const sonnet: RouteContext = { modelFamily: "sonnet" };
    const opus: RouteContext = { modelFamily: "opus" };
    const originalTryAcquire = pool.tryAcquire.bind(pool);
    const originalAcquireBest = pool.acquireBest.bind(pool);
    vi.spyOn(pool, "tryAcquire").mockImplementation((accountId, context) => (
      accountId === "a" && context?.modelFamily === "opus"
        ? null
        : originalTryAcquire(accountId, context)
    ));
    vi.spyOn(pool, "acquireBest").mockImplementation((activeSessions, context) => (
      context?.modelFamily === "opus"
        ? originalTryAcquire("b", context)!
        : originalAcquireBest(activeSessions, context)
    ));

    const first = router.acquire("session-a", sonnet);
    const rebound = router.acquire("session-a", opus);
    const returned = router.acquire("session-a", sonnet);

    expect(first.account.id).toBe("a");
    expect(rebound.account.id).toBe("b");
    expect(rebound.reason).toBe("failover");
    expect(returned.account.id).toBe("b");
    expect(returned.reason).toBe("sticky");
    expect(pool.tryAcquire).toHaveBeenCalledWith("a", opus);
    expect(pool.tryAcquire).toHaveBeenCalledWith("b", sonnet);
    first.release();
    rebound.release();
    returned.release();
  });

  it("uses model-aware unscoped selection without creating affinity", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    const router = new SessionRouter(pool);
    const acquireBest = vi.spyOn(pool, "acquireBest");
    const context: RouteContext = { modelFamily: "haiku" };

    const route = router.acquire(undefined, context);

    expect(acquireBest).toHaveBeenCalledWith(expect.any(Map), context);
    expect(route.reason).toBe("unscoped");
    expect(route.modelFamily).toBe("haiku");
    expect(router.getBindingCount()).toBe(0);
    route.release();
  });
});

interface FakePoolAccount {
  readonly id: string;
  readonly flavor: "codex";
}

class FakeAccountPool implements AccountPool<FakePoolAccount> {
  readonly acquired: string[] = [];
  constructor(private readonly accounts: FakePoolAccount[]) {}

  acquireBest(): GenericAccountLease<FakePoolAccount> {
    const account = this.accounts[0]!;
    this.acquired.push(account.id);
    return { account, fallback: false, release: () => undefined };
  }

  tryAcquire(accountId: string): GenericAccountLease<FakePoolAccount> | null {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) return null;
    this.acquired.push(`sticky:${account.id}`);
    return { account, fallback: false, release: () => undefined };
  }
}

describe("SessionRouter over a non-Anthropic AccountPool", () => {
  it("binds and reuses accounts from any pool implementing AccountPool", () => {
    const pool = new FakeAccountPool([{ id: "openai-a", flavor: "codex" }]);
    const router = new SessionRouter<FakePoolAccount>(pool);

    const first = router.acquire("session-1");
    expect(first.reason).toBe("new-session");
    expect(first.account.flavor).toBe("codex");

    const second = router.acquire("session-1");
    expect(second.reason).toBe("sticky");
    expect(pool.acquired).toEqual(["openai-a", "sticky:openai-a"]);
  });
});

describe("renameAccount", () => {
  it("keeps sticky bindings and session counts attached across a rename", () => {
    const pool = new TokenPool([makeAccount("old-name"), makeAccount("other")]);
    const router = new SessionRouter(pool);

    const first = router.acquire("session-a");
    expect(first.account.id).toBe("old-name");
    first.release();
    expect(router.getActiveSessionCount("old-name")).toBe(1);

    pool.renameAccount("old-name", "new-name");
    const moved = router.renameAccount("old-name", "new-name");

    expect(moved).toBe(1);
    // The binding must follow the id, or the sticky re-acquire would miss
    // (tryAcquire("old-name") finds nothing) and the session would silently
    // fail over to another account.
    const sticky = router.acquire("session-a");
    expect(sticky.account.id).toBe("new-name");
    expect(sticky.reason).toBe("sticky");
    sticky.release();
    expect(router.getActiveSessionCount("new-name")).toBe(1);
    expect(router.getActiveSessionCount("old-name")).toBe(0);
  });
});
