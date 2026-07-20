import { describe, expect, it, vi } from "vitest";
import { SessionRouter, normalizeSessionId } from "../proxy/session-router.js";
import { TokenPool } from "../proxy/token-pool.js";
import type { Account } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";

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
      ["account", "fallback", "reason", "release", "sessionId"].sort(),
    );
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    lease.release();
    log.mockRestore();
    warn.mockRestore();
  });
});
