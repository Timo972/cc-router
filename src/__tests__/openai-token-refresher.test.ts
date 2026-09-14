import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasPendingCredentialWrite,
  needsOpenAIRefresh,
  OPENAI_REFRESH_TIMEOUT_MS,
  prepareOpenAIAccountForRequest,
  refreshOpenAISubscriptionToken,
  startOpenAIRefreshLoop,
} from "../providers/openai/token-refresher.js";
import { createOpenAIAccount } from "../providers/openai/account-state.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { NoEligibleAccountError } from "../proxy/account-pool.js";

/** Matches the JWT-building helper used in openai-usage.test.ts. */
function jwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${body}.signature`;
}

describe("OpenAI subscription token refresher", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("fails the refresh when a 200 carries an unusable lifetime", async () => {
    let lifetime = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: lifetime,
        token_type: "Bearer",
      }),
    } as Response));

    // Zero and negative lifetimes leave the token due for another refresh the
    // moment it is written; MAX_VALUE overflows to an Infinity expiry that
    // `needsOpenAIRefresh` can never reach, stranding the account on a token
    // that does expire.
    for (lifetime of [0, -60, Number.MAX_VALUE]) {
      const account = {
        id: "openai-victor",
        provider: "openai_subscription" as const,
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      };
      const expiresAt = account.expiresAt;

      expect(await refreshOpenAISubscriptionToken(account)).toBe(false);
      expect(account.accessToken).toBe("old-access");
      expect(account.expiresAt).toBe(expiresAt);
      expect(needsOpenAIRefresh(account)).toBe(true);
    }
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

  it("quarantines a permanently rejected refresh past ordinary cooldowns and restores it after reauth", async () => {
    const account = createOpenAIAccount({
      id: "openai-revoked", provider: "openai_subscription", accessToken: "still-unexpired",
      refreshToken: "revoked", expiresAt: Date.now() + 60_000, enabled: true,
    });
    const pool = new OpenAITokenPool([account]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

    expect(await prepareOpenAIAccountForRequest(account, [account], vi.fn())).toBe(false);
    expect(account.authState).toBe("quarantined");
    expect(() => pool.acquireBest(new Map())).toThrow(NoEligibleAccountError);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: "replacement", refresh_token: "replacement-refresh", expires_in: 3600,
    }), { status: 200 }));
    expect(await prepareOpenAIAccountForRequest(account, [account], vi.fn())).toBe(true);
    expect(account.authState).toBe("ok");
    expect(pool.acquireBest(new Map()).account.id).toBe("openai-revoked");
  });

  it("keeps transient refresh failures routable once their normal cooldown ends", async () => {
    const account = createOpenAIAccount({
      id: "openai-temporary", provider: "openai_subscription", accessToken: "access",
      refreshToken: "refresh", expiresAt: Date.now() + 60_000, enabled: true,
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network unavailable"));
    expect(await prepareOpenAIAccountForRequest(account, [account], vi.fn())).toBe(false);
    expect(account.authState).toBe("ok");
    expect(new OpenAITokenPool([account]).acquireBest(new Map()).account.id).toBe("openai-temporary");
  });

  it("recognizes a nested permanent OAuth rejection and preserves quarantine across transient failures", async () => {
    const account = createOpenAIAccount({
      id: "openai-nested", provider: "openai_subscription", accessToken: "access",
      refreshToken: "revoked", expiresAt: Date.now() + 60_000, enabled: true,
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ error: { type: "invalid_grant" } }, { status: 401 }))
      .mockRejectedValueOnce(new Error("temporary network failure"));

    expect(await refreshOpenAISubscriptionToken(account)).toBe(false);
    expect(account.authState).toBe("quarantined");
    expect(account.authFailure).toBe("permanent");

    expect(await refreshOpenAISubscriptionToken(account)).toBe(false);
    expect(account.authState).toBe("quarantined");
    expect(account.authFailure).toBe("permanent");
  });

  it("sends the OAuth client_id so the token endpoint accepts the refresh", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ access_token: "fresh", refresh_token: "fresh-refresh", expires_in: 3600 }, { status: 200 }),
    );
    const account = createOpenAIAccount({
      id: "openai-clientid", provider: "openai_subscription", accessToken: "old",
      refreshToken: "old-refresh", expiresAt: Date.now() + 60_000, enabled: true,
    });

    expect(await refreshOpenAISubscriptionToken(account)).toBe(true);

    const params = new URLSearchParams(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(params.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("old-refresh");
  });

  it("quarantines on the endpoint's real token_expired rejection code", async () => {
    const account = createOpenAIAccount({
      id: "openai-expired", provider: "openai_subscription", accessToken: "access",
      refreshToken: "expired", expiresAt: Date.now() + 60_000, enabled: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ error: { type: "invalid_request_error", code: "token_expired" } }, { status: 401 }),
    );

    expect(await refreshOpenAISubscriptionToken(account)).toBe(false);
    expect(account.authState).toBe("quarantined");
    expect(account.authFailure).toBe("permanent");
  });

  it("bounds the whole OAuth response body and releases the shared refresh lock", async () => {
    vi.useFakeTimers();
    const account = createOpenAIAccount({
      id: "openai-stalled-body", provider: "openai_subscription", accessToken: "access",
      refreshToken: "refresh", expiresAt: Date.now() + 60_000, enabled: true,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_input, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    }) as Response);

    const first = refreshOpenAISubscriptionToken(account);
    const concurrent = refreshOpenAISubscriptionToken(account);
    await vi.advanceTimersByTimeAsync(OPENAI_REFRESH_TIMEOUT_MS);
    await expect(first).resolves.toBe(false);
    await expect(concurrent).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(Response.json({
      access_token: "recovered", refresh_token: "recovered-refresh", expires_in: 3600,
    }));
    await expect(refreshOpenAISubscriptionToken(account)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keys refresh single-flight by account identity across rename and re-add", async () => {
    let resolveOriginal!: (value: unknown) => void;
    const originalBody = new Promise<unknown>(resolve => { resolveOriginal = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: () => originalBody } as Response)
      .mockResolvedValueOnce(Response.json({ access_token: "replacement-access", expires_in: 3600 }));
    const original = createOpenAIAccount({
      id: "openai-old", provider: "openai_subscription", accessToken: "old",
      refreshToken: "refresh", expiresAt: Date.now() + 60_000, enabled: true,
    });

    const first = refreshOpenAISubscriptionToken(original);
    original.id = "openai-renamed";
    const sameIdentity = refreshOpenAISubscriptionToken(original);
    const replacement = createOpenAIAccount({
      id: "openai-renamed", provider: "openai_subscription", accessToken: "replacement-old",
      refreshToken: "replacement-refresh", expiresAt: Date.now() + 60_000, enabled: true,
    });
    await expect(refreshOpenAISubscriptionToken(replacement)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveOriginal({ access_token: "original-access", expires_in: 3600 });
    await expect(first).resolves.toBe(true);
    await expect(sameIdentity).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("logs only a safe refresh correlation and network cause code", async () => {
    const account = createOpenAIAccount({
      id: "openai-redaction", provider: "openai_subscription", accessToken: "access-secret",
      refreshToken: "refresh-secret", expiresAt: Date.now() + 60_000, enabled: true,
    });
    const error = new Error("fetch failed with refresh-secret", { cause: { code: "ECONNRESET" } });
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(error);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await refreshOpenAISubscriptionToken(account)).toBe(false);
    const line = logSpy.mock.calls.map(call => String(call[0])).join("\n");
    expect(line).toContain("operation=refresh");
    expect(line).toContain("cause=ECONNRESET");
    expect(line).not.toContain("refresh-secret");
    expect(line).not.toContain("access-secret");
    expect(line).not.toContain("fetch failed");
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
    // `runOnlyPendingTimersAsync` fires the loop's immediate queued check plus
    // one interval tick. The first check refreshes both accounts and each
    // throwing persist logs once (2 calls) and marks the account pending; the
    // second check finds neither account due for refresh but retries their
    // still-pending write, which throws again and logs again (2 more calls).
    expect(consoleErrorSpy).toHaveBeenCalledTimes(4);
    expect(hasPendingCredentialWrite(first)).toBe(true);
    expect(hasPendingCredentialWrite(second)).toBe(true);
    vi.useRealTimers();
  });

  it("leaves nothing pending after a successful persist", async () => {
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

    const ok = await prepareOpenAIAccountForRequest(account, [account], save);

    expect(ok).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(hasPendingCredentialWrite(account)).toBe(false);
  });

  it("retries a rotated credential write on a later, otherwise-idle request until it succeeds", async () => {
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

    const account = {
      id: "openai-victor",
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };
    const accounts = [account];

    // First request: the refresh succeeds, but persisting it (e.g. a
    // transient disk-full) throws. This must not fail the request that
    // triggered the refresh — the caller already has a usable token in memory.
    const failingSave = vi.fn(() => {
      throw new Error("disk full");
    });
    const firstOk = await prepareOpenAIAccountForRequest(account, accounts, failingSave);

    expect(firstOk).toBe(true);
    expect(account.accessToken).toBe("new-access");
    expect(hasPendingCredentialWrite(account)).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    // Second request: no refresh is due (expiresAt was just rotated far into
    // the future), but the account is still dirty from the first request, so
    // this otherwise-idle call must retry — and clear — the pending write.
    account.expiresAt = Date.now() + 60 * 60 * 1000;
    const workingSave = vi.fn();
    const secondOk = await prepareOpenAIAccountForRequest(account, accounts, workingSave);

    expect(secondOk).toBe(true);
    expect(workingSave).toHaveBeenCalledWith(accounts);
    expect(hasPendingCredentialWrite(account)).toBe(false);
  });

  it("clears every account's pending write when a later whole-pool save succeeds", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const makeAccount = (id: string) => ({
      id,
      provider: "openai_subscription" as const,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    });
    const first = makeAccount("openai-victor");
    const second = makeAccount("openai-wanda");
    const accounts = [first, second];

    await prepareOpenAIAccountForRequest(first, accounts, () => {
      throw new Error("disk full");
    });
    expect(hasPendingCredentialWrite(first)).toBe(true);

    // The save is whole-pool and synchronous, so the second account's
    // refresh writes the first account's rotated credentials to disk too.
    // Leaving its marker set would report an account as unsaved when it is
    // already durable, and keep retrying a write that has landed.
    const workingSave = vi.fn();
    await prepareOpenAIAccountForRequest(second, accounts, workingSave);

    expect(workingSave).toHaveBeenCalledWith(accounts);
    expect(hasPendingCredentialWrite(second)).toBe(false);
    expect(hasPendingCredentialWrite(first)).toBe(false);
  });

  it("recomputes the account's plan from the rotated access token after a refresh", async () => {
    const oldToken = jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "Plus" } });
    const newToken = jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "Pro" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: newToken,
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);

    const account = createOpenAIAccount({
      id: "openai-plan-change",
      provider: "openai_subscription" as const,
      accessToken: oldToken,
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    });
    expect(account.rateLimits.plan).toBe("plus");

    const save = vi.fn();
    const ok = await prepareOpenAIAccountForRequest(account, [account], save);

    expect(ok).toBe(true);
    expect(account.rateLimits.plan).toBe("pro");
  });
});
