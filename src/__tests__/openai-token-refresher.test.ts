import { afterEach, describe, expect, it, vi } from "vitest";
import { needsOpenAIRefresh, prepareOpenAIAccountForRequest, refreshOpenAISubscriptionToken, startOpenAIRefreshLoop } from "../providers/openai/token-refresher.js";
import { createOpenAIAccount } from "../providers/openai/account-state.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { NoEligibleAccountError } from "../proxy/account-pool.js";

describe("OpenAI subscription token refresher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes expiring OpenAI subscription tokens and stores rotated refresh token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);

    const account = {
      id: "openai-victor",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };

    expect(needsOpenAIRefresh(account)).toBe(true);
    const ok = await refreshOpenAISubscriptionToken(account);

    expect(ok).toBe(true);
    expect(account.accessToken).toBe("new-access");
    expect(account.refreshToken).toBe("new-refresh");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("refreshes and persists an expiring account before request forwarding", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);

    const accounts = [
      {
        id: "openai-victor",
        provider: "openai_subscription" as const,
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      },
    ];
    const save = vi.fn();

    const ok = await prepareOpenAIAccountForRequest(accounts[0], accounts, save);

    expect(ok).toBe(true);
    expect(save).toHaveBeenCalledWith(accounts);
    expect(accounts[0].accessToken).toBe("new-access");
  });

  it("does not persist when the account is still fresh", async () => {
    const account = {
      id: "openai-victor",
      provider: "openai_subscription" as const,
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      enabled: true,
    };
    const save = vi.fn();

    const ok = await prepareOpenAIAccountForRequest(account, [account], save);

    expect(ok).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("starts a background refresh loop and returns a stopper", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);
    const account = {
      id: "openai-victor",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };
    const save = vi.fn();

    const stop = startOpenAIRefreshLoop([account], save);
    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(save).toHaveBeenCalled();
    expect(account.accessToken).toBe("new-access");
    vi.useRealTimers();
  });

  it("recovers a previously-unhealthy account's routability after a successful refresh", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);

    const account = createOpenAIAccount({
      id: "openai-recovering",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    });
    // Simulate an account that starts out unhealthy (e.g. from some prior,
    // unrelated failure) — the pool hard-blocks it from selection until it
    // recovers. A successful refresh below is what should restore that.
    account.healthy = false;
    account.consecutiveErrors = 2;

    const pool = new OpenAITokenPool([account]);
    expect(() => pool.acquireBest(new Map())).toThrow(NoEligibleAccountError);

    const save = vi.fn();
    const ok = await prepareOpenAIAccountForRequest(account, [account], save);

    expect(ok).toBe(true);
    expect(account.healthy).toBe(true);
    expect(account.consecutiveErrors).toBe(0);

    const lease = pool.acquireBest(new Map());
    expect(lease.account.id).toBe("openai-recovering");
  });

  it("continues refreshing remaining accounts in a tick after one account's refresh throws", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const first = {
      id: "openai-first",
      provider: "openai_subscription" as const,
      accessToken: "old-access-first",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };
    const second = {
      id: "openai-second",
      provider: "openai_subscription" as const,
      accessToken: "old-access-second",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };

    // Every persist call throws (e.g. a disk-full error). Without a
    // per-account try/catch around `await prepareOpenAIAccountForRequest(...)`,
    // the first account's rejection would break out of the loop and `second`
    // would never even attempt a refresh.
    const save = vi.fn(() => {
      throw new Error("disk full");
    });

    const stop = startOpenAIRefreshLoop([first, second], save);
    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(first.accessToken).toBe("new-access");
    expect(second.accessToken).toBe("new-access");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
