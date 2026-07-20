import { describe, expect, it, vi } from "vitest";
import { deleteAnthropicAccountTransaction } from "../proxy/account-deletion.js";
import { SessionRouter } from "../proxy/session-router.js";
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

describe("deleteAnthropicAccountTransaction", () => {
  it("leaves the exact runtime state untouched when prospective persistence fails", () => {
    let now = 0;
    const first = makeAccount("a");
    const second = makeAccount("b");
    const pool = new TokenPool([first, second], { now: () => now });
    const router = new SessionRouter(pool, { now: () => now });
    const openLease = router.acquire("session-a");
    expect(openLease.account).toBe(first);
    pool.setCooldownForAccount(first, 60_000);
    const persist = vi.fn(() => { throw new Error("disk full"); });

    expect(() => deleteAnthropicAccountTransaction({
      id: "a",
      pool,
      sessionRouter: router,
      persist,
    })).toThrow("disk full");

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toEqual([second]);
    expect(pool.getAll()).toEqual([first, second]);
    expect(pool.findById("a")).toBe(first);
    expect(pool.getInFlight("a")).toBe(1);
    expect(pool.isCoolingDown("a")).toBe(true);
    expect(router.getActiveSessionCount("a")).toBe(1);
    now = 60_000;
    const sticky = router.acquire("session-a");
    expect(sticky.account).toBe(first);
    expect(sticky.reason).toBe("sticky");
    expect(sticky.bindingGeneration).toBe(openLease.bindingGeneration);
    sticky.release();
    openLease.release();
  });

  it("persists prospective state before removing runtime state and bindings", () => {
    const first = makeAccount("a");
    const second = makeAccount("b");
    const pool = new TokenPool([first, second]);
    const router = new SessionRouter(pool);
    router.acquire("session-a").release();
    const persist = vi.fn((prospective: Account[]) => {
      expect(prospective).toEqual([second]);
      expect(pool.findById("a")).toBe(first);
      expect(router.getBindingCount()).toBe(1);
    });

    const removed = deleteAnthropicAccountTransaction({
      id: "a",
      pool,
      sessionRouter: router,
      persist,
    });

    expect(removed).toBe(first);
    expect(pool.getAll()).toEqual([second]);
    expect(router.getBindingCount()).toBe(0);
  });
});
