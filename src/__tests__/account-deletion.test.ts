import { describe, expect, it, vi } from "vitest";
import {
  deleteAnthropicAccountTransaction,
  LastAccountDeletionError,
} from "../proxy/account-deletion.js";
import { SessionRouter } from "../proxy/session-router.js";
import { TokenPool } from "../proxy/token-pool.js";
import { refreshAccountToken } from "../proxy/token-refresher.js";
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function successfulRefreshResponse(): Response {
  return {
    ok: true,
    json: async () => ({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 28800,
      scope: "user:inference",
      token_type: "Bearer",
    }),
  } as Response;
}

describe("deleteAnthropicAccountTransaction", () => {
  it("leaves the exact runtime state untouched when prospective persistence fails", async () => {
    let now = 0;
    const first = makeAccount("a");
    const second = makeAccount("b");
    const pool = new TokenPool([first, second], { now: () => now });
    const router = new SessionRouter(pool, { now: () => now });
    const openLease = router.acquire("session-a");
    expect(openLease.account).toBe(first);
    pool.setCooldownForAccount(first, 60_000);
    const persist = vi.fn(() => { throw new Error("disk full"); });

    await expect(deleteAnthropicAccountTransaction({
      id: "a",
      pool,
      sessionRouter: router,
      persist,
    })).rejects.toThrow("disk full");

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

  it("persists prospective state before removing runtime state and bindings", async () => {
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

    const removed = await deleteAnthropicAccountTransaction({
      id: "a",
      pool,
      sessionRouter: router,
      persist,
    });

    expect(removed).toBe(first);
    expect(pool.getAll()).toEqual([second]);
    expect(router.getBindingCount()).toBe(0);
  });

  it("waits for an exact-account refresh before persisting and removing", async () => {
    const first = makeAccount("a");
    const second = makeAccount("b");
    const pool = new TokenPool([first, second]);
    const router = new SessionRouter(pool);
    const response = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => response.promise));
    const persist = vi.fn();

    try {
      const refresh = refreshAccountToken(first);
      const deletion = deleteAnthropicAccountTransaction({
        id: "a",
        pool,
        sessionRouter: router,
        persist,
      });
      await Promise.resolve();
      const persistedBeforeRefresh = persist.mock.calls.length;

      response.resolve(successfulRefreshResponse());
      expect(await refresh).toBe(true);
      const removed = await deletion;

      expect(persistedBeforeRefresh).toBe(0);
      expect(first.tokens.refreshToken).toBe("rotated-refresh");
      expect(persist).toHaveBeenCalledWith([second]);
      expect(removed).toBe(first);
      expect(pool.findById("a")).toBeNull();
    } finally {
      response.resolve(successfulRefreshResponse());
      vi.unstubAllGlobals();
    }
  });

  it("does not persist or delete a replacement that appears while refresh is pending", async () => {
    const oldAccount = makeAccount("a");
    const second = makeAccount("b");
    const pool = new TokenPool([oldAccount, second]);
    const router = new SessionRouter(pool);
    const response = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => response.promise));
    const persist = vi.fn();

    try {
      const refresh = refreshAccountToken(oldAccount);
      const deletion = deleteAnthropicAccountTransaction({
        id: "a",
        pool,
        sessionRouter: router,
        persist,
      });
      await Promise.resolve();
      pool.removeAccount("a");
      const replacement = pool.addAccount({
        id: "a",
        accessToken: "replacement-access",
        refreshToken: "replacement-refresh",
        expiresAt: Date.now() + 60_000,
        scopes: ["user:inference"],
      });
      response.resolve(successfulRefreshResponse());
      await refresh;

      await expect(deletion).rejects.toThrow(/changed during deletion/);
      expect(persist).not.toHaveBeenCalled();
      expect(pool.findById("a")).toBe(replacement);
      expect(replacement.tokens.refreshToken).toBe("replacement-refresh");
    } finally {
      response.resolve(successfulRefreshResponse());
      vi.unstubAllGlobals();
    }
  });

  it("does not let concurrent async deletions remove the final account", async () => {
    const first = makeAccount("a");
    const second = makeAccount("b");
    const pool = new TokenPool([first, second]);
    const router = new SessionRouter(pool);
    const persist = vi.fn();

    const results = await Promise.allSettled([
      deleteAnthropicAccountTransaction({
        id: "a",
        pool,
        sessionRouter: router,
        persist,
      }),
      deleteAnthropicAccountTransaction({
        id: "b",
        pool,
        sessionRouter: router,
        persist,
      }),
    ]);

    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined)
      .toBeInstanceOf(LastAccountDeletionError);
    expect(pool.getAll()).toHaveLength(1);
  });
});
