import { afterEach, describe, expect, it, vi } from "vitest";
import { needsOpenAIRefresh, prepareOpenAIAccountForRequest, refreshOpenAISubscriptionToken, startOpenAIRefreshLoop } from "../providers/openai/token-refresher.js";

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

  it("drains a deferred startup refresh before the stopper resolves", async () => {
    let resolveJson!: (value: object) => void;
    const json = new Promise<object>(resolve => { resolveJson = resolve; });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: () => json,
    } as Response);
    const account = {
      id: "openai-deferred",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };
    const persistedRefreshTokens: string[] = [];
    const stop = startOpenAIRefreshLoop([account], accounts => {
      persistedRefreshTokens.push(accounts[0].refreshToken);
    });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stopping = Promise.resolve(stop(100)).then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveJson({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      token_type: "Bearer",
    });
    await stopping;

    expect(persistedRefreshTokens).toEqual(["new-refresh"]);
  });

  it("aborts a hung startup refresh within the stopper deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("PRIVATE_ABORT"), { name: "AbortError" }));
        }, { once: true });
      });
    });
    const account = {
      id: "openai-hung",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };
    const stop = startOpenAIRefreshLoop([account], vi.fn());
    await vi.waitFor(() => expect(observedSignal).toBeInstanceOf(AbortSignal));

    const startedAt = Date.now();
    await Promise.resolve(stop(10));

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("rejects a successful HTTP response with an invalid token schema without mutation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);
    const account = {
      id: "openai-invalid-schema",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 12345,
      enabled: true,
    };
    const stop = startOpenAIRefreshLoop([], vi.fn());

    await expect(refreshOpenAISubscriptionToken(account)).rejects.toBeInstanceOf(TypeError);
    expect(account).toEqual(expect.objectContaining({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 12345,
    }));
    await stop();
  });

  it("drains and persists a deferred request-triggered refresh before stopping", async () => {
    let resolveJson!: (value: object) => void;
    const json = new Promise<object>(resolve => { resolveJson = resolve; });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: () => json,
    } as Response);
    const account = {
      id: "openai-request-refresh",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };
    const persistedRefreshTokens: string[] = [];
    const save = (accounts: typeof account[]) => {
      persistedRefreshTokens.push(accounts[0].refreshToken);
    };
    const stop = startOpenAIRefreshLoop([], save);
    await new Promise(resolve => setTimeout(resolve, 0));
    const preparing = prepareOpenAIAccountForRequest(account, [account], save);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stopping = stop(100).then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveJson({
      access_token: "new-access",
      refresh_token: "request-rotated-refresh",
      expires_in: 3600,
      token_type: "Bearer",
    });
    await expect(preparing).resolves.toBe(true);
    await stopping;

    expect(persistedRefreshTokens).toEqual(["request-rotated-refresh"]);
    const later = { ...account, id: "openai-after-stop", expiresAt: Date.now() + 60_000 };
    await expect(prepareOpenAIAccountForRequest(later, [later], save)).resolves.toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts every request-owned refresh lock when the shutdown deadline expires", async () => {
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const account = {
      id: "openai-request-hung",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };
    const stop = startOpenAIRefreshLoop([], vi.fn());
    await new Promise(resolve => setTimeout(resolve, 0));
    void prepareOpenAIAccountForRequest(account, [account], vi.fn());
    await vi.waitFor(() => expect(observedSignal).toBeInstanceOf(AbortSignal));

    const startedAt = Date.now();
    await stop(10);

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("serializes same-ID account incarnations until the active loop persists rotation", async () => {
    let resolveJson!: (value: object) => void;
    const firstJson = new Promise<object>(resolve => { resolveJson = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: () => firstJson,
    } as Response);
    const account = {
      id: "openai-lifecycle-account",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };
    const replacement = { ...account };
    const save = vi.fn();
    const stopOlder = startOpenAIRefreshLoop([account], save);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(() => startOpenAIRefreshLoop([replacement], vi.fn())).toThrow("already running");

    resolveJson({
      access_token: "new-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      token_type: "Bearer",
    });
    await stopOlder();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith([account]);
    expect(account.refreshToken).toBe("rotated-refresh");

    const stopNewer = startOpenAIRefreshLoop([replacement], vi.fn());
    await stopNewer();
  });

  it("retries durability without refreshing a rotated OpenAI token twice", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);
    const account = {
      id: "openai-pending-durability",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };
    const stop = startOpenAIRefreshLoop([], vi.fn());
    await new Promise(resolve => setTimeout(resolve, 0));
    const save = vi.fn()
      .mockImplementationOnce(() => { throw new Error("PRIVATE_DISK_FAILURE"); })
      .mockImplementationOnce(() => undefined);

    await expect(prepareOpenAIAccountForRequest(account, [account], save)).rejects.toThrow("PRIVATE_DISK_FAILURE");
    expect(account.refreshToken).toBe("rotated-refresh");
    expect(needsOpenAIRefresh(account)).toBe(true);

    await expect(prepareOpenAIAccountForRequest(account, [account], save)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(needsOpenAIRefresh(account)).toBe(false);
    await stop();
  });
});
