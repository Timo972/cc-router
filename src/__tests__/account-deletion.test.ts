import { describe, expect, it, vi } from "vitest";
import {
  AccountDeletionConflictError,
  accountDeletionStatusCode,
  deleteAnthropicAccountTransaction,
  deleteOpenAIAccountTransaction,
  LastAccountDeletionError,
} from "../proxy/account-deletion.js";
import { SessionRouter } from "../proxy/session-router.js";
import { TokenPool } from "../proxy/token-pool.js";
import {
  refreshAccountIfCurrent,
  refreshAccountToken,
} from "../proxy/token-refresher.js";
import type { Account } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

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
  it("maps typed deletion conflicts to 409 and persistence failures to 500", () => {
    expect(accountDeletionStatusCode(new AccountDeletionConflictError("a"))).toBe(409);
    expect(accountDeletionStatusCode(new LastAccountDeletionError())).toBe(409);
    expect(accountDeletionStatusCode(new Error("disk full"))).toBe(500);
  });

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

    const refreshAfterFailure = vi.fn(async () => true);
    const persistAfterFailure = vi.fn();
    expect(await refreshAccountIfCurrent(first, pool, {
      refresh: refreshAfterFailure,
      persist: persistAfterFailure,
    })).toBe(true);
    expect(refreshAfterFailure).toHaveBeenCalledWith(first);
    expect(persistAfterFailure).toHaveBeenCalledWith([first, second]);

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

      await expect(deletion).rejects.toBeInstanceOf(AccountDeletionConflictError);
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

  it("blocks a P2 refresh reaction until P1 persistence and deletion complete", async () => {
    const first = makeAccount("a");
    const second = makeAccount("b");
    const pool = new TokenPool([first, second]);
    const router = new SessionRouter(pool);
    const p1Gate = deferred<boolean>();
    const p2Refresh = vi.fn(async () => true);
    const events: string[] = [];
    let persistedRotatedToken = "";

    const p1 = refreshAccountIfCurrent(first, pool, {
      refresh: async (account) => {
        await p1Gate.promise;
        account.tokens.refreshToken = "rotated-refresh";
        return true;
      },
      persist: (accounts) => {
        expect(pool.findById("a")).toBe(first);
        persistedRotatedToken = accounts[0].tokens.refreshToken;
        events.push("p1-persist");
      },
    });
    const p2 = p1.then(() => refreshAccountIfCurrent(first, pool, {
      refresh: p2Refresh,
      persist: () => events.push("p2-persist"),
    }));
    const deletion = deleteAnthropicAccountTransaction({
      id: "a",
      pool,
      sessionRouter: router,
      persist: () => events.push("delete-persist"),
    });
    await Promise.resolve();
    await Promise.resolve();
    const removedBeforeP1Completed = pool.findById("a") === null;

    p1Gate.resolve(true);
    const [p1Result, p2Result, removed] = await Promise.all([p1, p2, deletion]);

    expect(removedBeforeP1Completed).toBe(false);
    expect(p1Result).toBe(true);
    expect(p2Result).toBe(false);
    expect(p2Refresh).not.toHaveBeenCalled();
    expect(removed).toBe(first);
    expect(persistedRotatedToken).toBe("rotated-refresh");
    expect(events).toEqual(["p1-persist", "delete-persist"]);
    expect(pool.findById("a")).toBeNull();
  });
});

describe("deleteOpenAIAccountTransaction", () => {
  const openAIAccount = (id: string): OpenAISubscriptionAccount => ({
    id,
    provider: "openai_subscription",
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 60_000,
    enabled: true,
  });

  it("persists prospective state before removing the live account", () => {
    const first = openAIAccount("openai-a");
    const second = openAIAccount("openai-b");
    const accounts = [first, second];
    const persist = vi.fn((prospective: OpenAISubscriptionAccount[]) => {
      expect(prospective).toEqual([second]);
      expect(accounts).toEqual([first, second]);
    });

    expect(deleteOpenAIAccountTransaction({
      id: first.id,
      accounts,
      otherAccountCount: 0,
      persist,
    })).toBe(first);
    expect(accounts).toEqual([second]);
  });

  it("does not remove the final configured account", () => {
    const accounts = [openAIAccount("only")];
    expect(() => deleteOpenAIAccountTransaction({
      id: "only",
      accounts,
      otherAccountCount: 0,
      persist: vi.fn(),
    })).toThrow(LastAccountDeletionError);
    expect(accounts).toHaveLength(1);
  });
});
