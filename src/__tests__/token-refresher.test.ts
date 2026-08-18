import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  needsRefresh,
  refreshAccountsOnce,
  refreshAccountIfCurrent,
  refreshAccountToken,
  reserveAccountForDeletion,
} from "../proxy/token-refresher.js";
import { TokenPool } from "../proxy/token-pool.js";
import type { Account } from "../proxy/types.js";

function makeAccount(expiresAt: number): Account {
  return {
    id: "test-account",
    tokens: {
      accessToken: "sk-ant-oat01-old",
      refreshToken: "sk-ant-ort01-old",
      expiresAt,
      scopes: ["user:inference", "user:profile"],
    },
    healthy: true,
    busy: false,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function successfulRefreshResponse(suffix: string): Response {
  return {
    ok: true,
    json: async () => ({
      access_token: `sk-ant-oat01-${suffix}`,
      refresh_token: `sk-ant-ort01-${suffix}`,
      expires_in: 28800,
      scope: "user:inference user:profile",
      token_type: "Bearer",
    }),
  } as Response;
}

// ─── needsRefresh ─────────────────────────────────────────────────────────────

describe("needsRefresh", () => {
  it("returns false when token expires in 2 hours", () => {
    expect(needsRefresh(makeAccount(Date.now() + 2 * 60 * 60 * 1000))).toBe(false);
  });

  it("returns false when token expires in exactly 11 minutes", () => {
    expect(needsRefresh(makeAccount(Date.now() + 11 * 60 * 1000))).toBe(false);
  });

  it("returns true when token expires in 9 minutes (within 10-min buffer)", () => {
    expect(needsRefresh(makeAccount(Date.now() + 9 * 60 * 1000))).toBe(true);
  });

  it("returns true when token expires in 5 minutes", () => {
    expect(needsRefresh(makeAccount(Date.now() + 5 * 60 * 1000))).toBe(true);
  });

  it("returns true when token already expired", () => {
    expect(needsRefresh(makeAccount(Date.now() - 1_000))).toBe(true);
  });

  it("returns true when token expired an hour ago", () => {
    expect(needsRefresh(makeAccount(Date.now() - 60 * 60 * 1000))).toBe(true);
  });
});

// ─── refreshAccountToken ─────────────────────────────────────────────────────

describe("refreshAccountToken", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("updates tokens on successful refresh response", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "sk-ant-oat01-NEW",
        refresh_token: "sk-ant-ort01-NEW",
        expires_in: 28800,
        scope: "user:inference user:profile",
        token_type: "Bearer",
      }),
    } as Response);

    const result = await refreshAccountToken(account);

    expect(result).toBe(true);
    expect(account.tokens.accessToken).toBe("sk-ant-oat01-NEW");
    expect(account.tokens.refreshToken).toBe("sk-ant-ort01-NEW");
    expect(account.tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(account.healthy).toBe(true);
    expect(account.consecutiveErrors).toBe(0);
  });

  it("parses scope string into scopes array", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "sk-ant-oat01-NEW",
        refresh_token: "sk-ant-ort01-NEW",
        expires_in: 28800,
        scope: "user:inference user:profile",
        token_type: "Bearer",
      }),
    } as Response);

    await refreshAccountToken(account);
    expect(account.tokens.scopes).toEqual(["user:inference", "user:profile"]);
  });

  it("increments consecutiveErrors on HTTP error response", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Bad request",
    } as Response);

    const result = await refreshAccountToken(account);

    expect(result).toBe(false);
    expect(account.consecutiveErrors).toBe(1);
  });

  it("marks account unhealthy immediately when OAuth refresh is rejected", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    } as Response);

    const result = await refreshAccountToken(account);

    expect(result).toBe(false);
    expect(account.healthy).toBe(false);
  });

  it("stops retrying a token the server rejected as invalid_grant", async () => {
    // An already-expired token the refresh loop would keep picking up.
    const account = makeAccount(Date.now() - 60 * 60 * 1000);
    expect(needsRefresh(account)).toBe(true);

    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","error_description":"Refresh token expired"}',
    } as Response);

    await refreshAccountToken(account);

    // A terminal rejection takes the account out of the refresh loop, so the
    // dead token is never POSTed to the OAuth endpoint again.
    expect(account.authExpired).toBe(true);
    expect(account.healthy).toBe(false);
    expect(needsRefresh(account)).toBe(false);
  });

  it("keeps retrying a transient server error (not terminal)", async () => {
    const account = makeAccount(Date.now() - 60 * 60 * 1000);

    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    } as Response);

    await refreshAccountToken(account);

    // A 5xx is transient: the account stays unhealthy but eligible for retry.
    expect(account.authExpired).toBeFalsy();
    expect(needsRefresh(account)).toBe(true);
  });

  it("treats a different 400 error as transient, not terminal", async () => {
    const account = makeAccount(Date.now() - 60 * 60 * 1000);

    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_request","error_description":"missing parameter"}',
    } as Response);

    await refreshAccountToken(account);

    // Only invalid_grant is terminal; other 400s stay eligible for retry.
    expect(account.authExpired).toBeFalsy();
    expect(needsRefresh(account)).toBe(true);
  });

  it("marks account unhealthy after 3 consecutive errors", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);

    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as Response);

    await refreshAccountToken(account);
    await refreshAccountToken(account);
    await refreshAccountToken(account);

    expect(account.consecutiveErrors).toBe(3);
    expect(account.healthy).toBe(false);
  });

  it("returns false and increments errors on network failure", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);

    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await refreshAccountToken(account);

    expect(result).toBe(false);
    expect(account.consecutiveErrors).toBe(1);
  });

  it("deduplicates concurrent refresh calls for the same account", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);
    const response = deferred<Response>();
    vi.mocked(fetch).mockImplementation(() => response.promise);

    // Fire 3 concurrent refreshes for the same account
    const pending = [
      refreshAccountToken(account),
      refreshAccountToken(account),
      refreshAccountToken(account),
    ];
    expect(fetch).toHaveBeenCalledTimes(1);
    response.resolve(successfulRefreshResponse("NEW"));
    const [r1, r2, r3] = await Promise.all(pending);

    // All return the same result but fetch was only called once
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce different account objects that reuse the same ID", async () => {
    const oldAccount = makeAccount(Date.now() + 5 * 60 * 1000);
    const replacement = makeAccount(Date.now() + 5 * 60 * 1000);
    const oldResponse = deferred<Response>();
    const replacementResponse = deferred<Response>();
    vi.mocked(fetch)
      .mockImplementationOnce(() => oldResponse.promise)
      .mockImplementationOnce(() => replacementResponse.promise);

    const oldRefresh = refreshAccountToken(oldAccount);
    const replacementRefresh = refreshAccountToken(replacement);
    oldResponse.resolve(successfulRefreshResponse("OLD"));
    replacementResponse.resolve(successfulRefreshResponse("REPLACEMENT"));
    const results = await Promise.all([oldRefresh, replacementRefresh]);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(results).toEqual([true, true]);
    expect(oldAccount.tokens.refreshToken).toBe("sk-ant-ort01-OLD");
    expect(replacement.tokens.refreshToken).toBe("sk-ant-ort01-REPLACEMENT");
  });

  it("does not start a stale 401 refresh after the account ID is reused", async () => {
    const oldAccount = makeAccount(Date.now() + 5 * 60 * 1000);
    const pool = new TokenPool([oldAccount]);
    pool.removeAccount(oldAccount.id);
    const replacement = pool.addAccount({
      id: oldAccount.id,
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
      expiresAt: Date.now() + 60_000,
      scopes: ["user:inference"],
    });
    const refresh = vi.fn(async () => true);
    const persist = vi.fn();

    const result = await refreshAccountIfCurrent(oldAccount, pool, { refresh, persist });

    expect(result).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(replacement.tokens).toMatchObject({
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
    });
  });

  it("does not persist a refresh that loses exact account ownership while pending", async () => {
    const oldAccount = makeAccount(Date.now() + 5 * 60 * 1000);
    const pool = new TokenPool([oldAccount]);
    const refreshResult = deferred<boolean>();
    const refresh = vi.fn(() => refreshResult.promise);
    const persist = vi.fn();

    const pending = refreshAccountIfCurrent(oldAccount, pool, { refresh, persist });
    expect(refresh).toHaveBeenCalledWith(oldAccount);
    pool.removeAccount(oldAccount.id);
    const replacement = pool.addAccount({
      id: oldAccount.id,
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
      expiresAt: Date.now() + 60_000,
      scopes: ["user:inference"],
    });
    refreshResult.resolve(true);

    expect(await pending).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(replacement.tokens.refreshToken).toBe("replacement-refresh");
  });

  it("retries durability without another upstream refresh after persistence fails", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);
    const pool = new TokenPool([account]);
    vi.mocked(fetch).mockResolvedValue(successfulRefreshResponse("ROTATED"));
    const persist = vi.fn()
      .mockImplementationOnce(() => { throw new Error("disk full"); })
      .mockImplementationOnce(() => undefined);

    await expect(refreshAccountIfCurrent(account, pool, { persist }))
      .rejects.toThrow("disk full");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(account.tokens.refreshToken).toBe("sk-ant-ort01-ROTATED");
    expect(needsRefresh(account)).toBe(true);

    expect(await refreshAccountIfCurrent(account, pool, { persist })).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(account.tokens.refreshToken).toBe("sk-ant-ort01-ROTATED");
    expect(needsRefresh(account)).toBe(false);
  });

  it("scheduled and foreground refresh share ownership and refuse stale persistence", async () => {
    const oldAccount = makeAccount(Date.now() + 5 * 60 * 1000);
    const accounts = [oldAccount];
    const pool = new TokenPool(accounts);
    const response = deferred<Response>();
    vi.mocked(fetch).mockImplementation(() => response.promise);
    const persist = vi.fn();

    const scheduled = refreshAccountsOnce(accounts, { persist });
    const foreground = refreshAccountIfCurrent(oldAccount, pool, { persist });
    expect(fetch).toHaveBeenCalledTimes(1);
    pool.removeAccount(oldAccount.id);
    const replacement = pool.addAccount({
      id: oldAccount.id,
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
      expiresAt: Date.now() + 60_000,
      scopes: ["user:inference"],
    });
    response.resolve(successfulRefreshResponse("STALE"));

    await scheduled;
    expect(await foreground).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
    expect(replacement.tokens.refreshToken).toBe("replacement-refresh");
  });

  it("keeps an exact account blocked until every deletion reservation releases", async () => {
    const account = makeAccount(Date.now() + 5 * 60 * 1000);
    const pool = new TokenPool([account]);
    vi.mocked(fetch).mockResolvedValue(successfulRefreshResponse("AFTER"));
    const persist = vi.fn();

    const [releaseFirst, releaseSecond] = await Promise.all([
      reserveAccountForDeletion(account),
      reserveAccountForDeletion(account),
    ]);

    expect(await refreshAccountToken(account)).toBe(false);
    expect(await refreshAccountIfCurrent(account, pool, { persist })).toBe(false);
    releaseFirst();
    releaseFirst();
    expect(await refreshAccountToken(account)).toBe(false);
    releaseSecond();
    expect(await refreshAccountToken(account)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
