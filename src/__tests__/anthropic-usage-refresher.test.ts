import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAnthropicUsage,
  type UsageFetchResult,
} from "../providers/anthropic/usage.js";
import { AnthropicUsageRefresher } from "../providers/anthropic/usage-refresher.js";
import { TokenPool } from "../proxy/token-pool.js";
import { DEFAULT_RATE_LIMITS, type Account } from "../proxy/types.js";

function account(id: string): Account {
  return {
    id,
    tokens: {
      accessToken: `secret-access-${id}`,
      refreshToken: `secret-refresh-${id}`,
      expiresAt: 1_900_000_000_000,
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

function usageResult(fetchedAt = 0): UsageFetchResult {
  return {
    ok: true,
    snapshot: { modelLimits: [], fetchedAt, fetchStatus: "fresh" },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise(done => { resolve = done; }), resolve };
}

describe("fetchAnthropicUsage", () => {
  it("uses the fixed OAuth usage endpoint and a bounded OAuth request", async () => {
    const a = account("a");
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ five_hour: { utilization: 25 } }),
    }) as Response);

    await expect(fetchAnthropicUsage(a, { fetch, now: () => 123 })).resolves.toEqual({
      ok: true,
      snapshot: {
        fiveHour: { utilization: 0.25, resetAt: 0 },
        modelLimits: [],
        fetchedAt: 123,
        fetchStatus: "fresh",
      },
    });
    expect(fetch).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/usage", expect.objectContaining({
      method: "GET",
      headers: {
        Authorization: "Bearer secret-access-a",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([401, 429, 500])("returns a sanitized HTTP failure for %i", async status => {
    const result = await fetchAnthropicUsage(account("a"), {
      fetch: async () => ({ ok: false, status, text: async () => "secret response body" }) as Response,
    });
    expect(result).toEqual({ ok: false, reason: "http", status });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("returns sanitized timeout, invalid JSON, and schema failures", async () => {
    const a = account("a");
    const never = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("secret access token leaked")));
    }));
    await expect(fetchAnthropicUsage(a, { fetch: never, timeoutMs: 1 })).resolves.toEqual({
      ok: false,
      reason: "timeout",
    });
    await expect(fetchAnthropicUsage(a, {
      fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error("secret body"); } }) as Response,
    })).resolves.toEqual({ ok: false, reason: "invalid_json" });
    await expect(fetchAnthropicUsage(a, {
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ nope: "secret body" }) }) as Response,
    })).resolves.toEqual({ ok: false, reason: "invalid_schema" });
  });
});

describe("AnthropicUsageRefresher", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stages startup work, limits it to two requests, and refreshes successes every five minutes", async () => {
    vi.useFakeTimers();
    const accounts = [account("a"), account("b"), account("c")];
    const pool = new TokenPool(accounts);
    const requests = deferred<UsageFetchResult>();
    const fetchUsage = vi.fn(() => requests.promise);
    const refresher = new AnthropicUsageRefresher(pool, {
      fetchUsage,
      startupStaggerMs: 10,
      now: () => Date.now(),
    });

    refresher.start();
    await vi.advanceTimersByTimeAsync(30);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    requests.resolve(usageResult());
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchUsage).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchUsage.mock.calls.length).toBeGreaterThanOrEqual(4);
    refresher.stop();
  });

  it("backs off failures per account and retains the last good snapshot as stale", async () => {
    vi.useFakeTimers();
    const a = account("a");
    const pool = new TokenPool([a]);
    const fetchUsage = vi.fn()
      .mockResolvedValueOnce(usageResult(10))
      .mockResolvedValueOnce({ ok: false, reason: "http", status: 429 } satisfies UsageFetchResult)
      .mockResolvedValueOnce({ ok: false, reason: "http", status: 500 } satisfies UsageFetchResult)
      .mockResolvedValueOnce({ ok: false, reason: "timeout" } satisfies UsageFetchResult)
      .mockResolvedValueOnce({ ok: false, reason: "network" } satisfies UsageFetchResult);
    const refresher = new AnthropicUsageRefresher(pool, { fetchUsage, startupStaggerMs: 0 });

    refresher.start();
    await vi.runOnlyPendingTimersAsync();
    expect(a.rateLimits.usage).toMatchObject({ fetchedAt: 10, fetchStatus: "fresh" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(a.rateLimits.usage).toMatchObject({ fetchedAt: 10, fetchStatus: "stale" });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchUsage).toHaveBeenCalledTimes(5);
    refresher.stop();
  });

  it("marks accounts with no successful fetch unavailable", async () => {
    vi.useFakeTimers();
    const a = account("a");
    const refresher = new AnthropicUsageRefresher(new TokenPool([a]), {
      fetchUsage: async () => ({ ok: false, reason: "network" }),
      startupStaggerMs: 0,
      now: () => 99,
    });
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.rateLimits.usage).toEqual({ modelLimits: [], fetchedAt: 99, fetchStatus: "unavailable" });
    refresher.stop();
  });

  it("joins an exact-account in-flight request and discards a stale replacement result", async () => {
    const old = account("a");
    const accounts = [old];
    const pool = new TokenPool(accounts);
    const pending = deferred<UsageFetchResult>();
    const fetchUsage = vi.fn(() => pending.promise);
    const refresher = new AnthropicUsageRefresher(pool, { fetchUsage });

    const first = refresher.refreshNow(old);
    expect(refresher.refreshNow(old)).toBe(first);
    accounts.splice(0, 1, account("a"));
    pending.resolve(usageResult(100));
    await first;
    expect(old.rateLimits.usage).toBeUndefined();
    expect(accounts[0].rateLimits.usage).toBeUndefined();
  });

  it("reconciles additions and removals, and stop prevents future work", async () => {
    vi.useFakeTimers();
    const accounts = [account("a")];
    const pool = new TokenPool(accounts);
    const fetchUsage = vi.fn(async () => usageResult());
    const refresher = new AnthropicUsageRefresher(pool, { fetchUsage, startupStaggerMs: 0 });
    refresher.start();
    await vi.runOnlyPendingTimersAsync();
    accounts.splice(0, 1);
    accounts.push(account("b"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchUsage).toHaveBeenCalledWith(accounts[0]);
    const calls = fetchUsage.mock.calls.length;
    refresher.stop();
    refresher.stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fetchUsage).toHaveBeenCalledTimes(calls);
  });
});
