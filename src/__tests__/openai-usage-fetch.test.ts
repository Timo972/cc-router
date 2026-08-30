import { describe, expect, it, vi } from "vitest";
import { parseCodexUsagePayload, DEFAULT_CODEX_LIMIT_ID } from "../providers/openai/usage.js";
import {
  CODEX_USAGE_ENDPOINT,
  fetchCodexUsage,
  OpenAIUsageRefresher,
} from "../providers/openai/usage-fetch.js";
import { createOpenAIAccount } from "../providers/openai/account-state.js";
import type { OpenAIAccount } from "../providers/openai/account-state.js";

function makeAccount(id: string): OpenAIAccount {
  return createOpenAIAccount({
    id,
    provider: "openai_subscription",
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 3_600_000,
    enabled: true,
  });
}

function poolOf(...accounts: OpenAIAccount[]) {
  return {
    getAll: () => accounts,
    findById: (id: string) => accounts.find(a => a.id === id) ?? null,
  };
}

const NOW_MS = 1_787_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** Shape observed live from GET chatgpt.com/backend-api/wham/usage. */
function samplePayload(): unknown {
  return {
    user_id: "user-x",
    account_id: "acct-x",
    email: "user@example.com",
    plan_type: "team",
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: {
        used_percent: 100,
        limit_window_seconds: 604_800,
        reset_after_seconds: 418_291,
        reset_at: NOW_SEC + 418_291,
      },
      secondary_window: null,
    },
    code_review_rate_limit: null,
    additional_rate_limits: null,
    credits: {
      has_credits: false,
      unlimited: false,
      overage_limit_reached: false,
      balance: null,
      approx_local_messages: null,
      approx_cloud_messages: null,
    },
    rate_limit_reset_credits: { available_count: 2 },
  };
}

describe("parseCodexUsagePayload", () => {
  it("maps the default bucket from the live payload shape", () => {
    const update = parseCodexUsagePayload(samplePayload(), NOW_MS);

    expect(update).not.toBeNull();
    expect(update!.buckets).toHaveLength(1);
    const bucket = update!.buckets[0];
    expect(bucket.limitId).toBe("codex");
    expect(bucket.primary).toEqual({
      utilization: 1,
      resetAt: NOW_SEC + 418_291,
      windowMinutes: 10_080,
    });
    expect(bucket.secondary).toBeUndefined();
    expect(update!.credits).toEqual({ hasCredits: false, unlimited: false });
    expect(update!.resetCredits).toEqual({ available: 2 });
  });

  it("parses rate_limit_reset_credits.available_count including zero", () => {
    const payload = samplePayload() as Record<string, unknown>;
    payload["rate_limit_reset_credits"] = { available_count: 0 };
    expect(parseCodexUsagePayload(payload, NOW_MS)!.resetCredits).toEqual({ available: 0 });
  });

  it("omits resetCredits when the usage field is absent", () => {
    const payload = samplePayload() as Record<string, unknown>;
    delete payload["rate_limit_reset_credits"];
    expect(parseCodexUsagePayload(payload, NOW_MS)!.resetCredits).toBeUndefined();
  });

  it("clamps reset credit counts to 0..99", () => {
    const high = samplePayload() as Record<string, unknown>;
    high["rate_limit_reset_credits"] = { available_count: 150 };
    expect(parseCodexUsagePayload(high, NOW_MS)!.resetCredits).toEqual({ available: 99 });

    const low = samplePayload() as Record<string, unknown>;
    low["rate_limit_reset_credits"] = { available_count: -3 };
    expect(parseCodexUsagePayload(low, NOW_MS)!.resetCredits).toEqual({ available: 0 });
  });

  it("maps named additional rate limits into their own buckets", () => {
    const payload = samplePayload() as Record<string, unknown>;
    payload["additional_rate_limits"] = [{
      limit_name: "GPT-5.6 Spark",
      metered_feature: "spark",
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3_600,
          reset_at: NOW_SEC + 3_600,
        },
        secondary_window: null,
      },
    }];

    const update = parseCodexUsagePayload(payload, NOW_MS);

    const spark = update!.buckets.find(b => b.limitId === "spark");
    expect(spark).toBeDefined();
    expect(spark!.limitName).toBe("GPT-5.6 Spark");
    expect(spark!.primary).toEqual({
      utilization: 0.25,
      resetAt: NOW_SEC + 3_600,
      windowMinutes: 300,
    });
  });

  it("falls back to reset_after_seconds when reset_at is unusable, like the header parser", () => {
    const payload = samplePayload() as Record<string, unknown>;
    (payload["rate_limit"] as Record<string, unknown>)["primary_window"] = {
      used_percent: 50,
      limit_window_seconds: 18_000,
      reset_after_seconds: 3_600,
      reset_at: NOW_SEC - 10, // already past — untrustworthy
    };

    const update = parseCodexUsagePayload(payload, NOW_MS);
    expect(update!.buckets[0].primary!.resetAt).toBe(NOW_SEC + 3_600);
  });

  it("clamps utilization and rejects windows beyond the trust horizon", () => {
    const payload = samplePayload() as Record<string, unknown>;
    (payload["rate_limit"] as Record<string, unknown>)["primary_window"] = {
      used_percent: 250,
      limit_window_seconds: 60 * 60 * 24 * 365, // a year — beyond the 8-day horizon
      reset_after_seconds: 60 * 60 * 24 * 300,
      reset_at: NOW_SEC + 60 * 60 * 24 * 300,
    };

    const update = parseCodexUsagePayload(payload, NOW_MS);
    const primary = update!.buckets[0].primary!;
    expect(primary.utilization).toBe(1);
    expect(primary.resetAt).toBe(0);
    expect(primary.windowMinutes).toBe(8 * 24 * 60);
  });

  it("returns null for a body that is not a usage payload", () => {
    expect(parseCodexUsagePayload(null, NOW_MS)).toBeNull();
    expect(parseCodexUsagePayload("nope", NOW_MS)).toBeNull();
    expect(parseCodexUsagePayload({ error: "unauthorized" }, NOW_MS)).toBeNull();
  });

  it("returns an empty update when windows are absent but the shape is right", () => {
    const payload = samplePayload() as Record<string, unknown>;
    payload["rate_limit"] = { allowed: true, limit_reached: false, primary_window: null, secondary_window: null };
    const update = parseCodexUsagePayload(payload, NOW_MS);
    expect(update).not.toBeNull();
    expect(update!.buckets).toHaveLength(0);
  });
});

describe("fetchCodexUsage", () => {
  it("sends a bounded bearer-authenticated GET to the usage endpoint", async () => {
    const account = makeAccount("a");
    const fetch = vi.fn(async () => Response.json({
      rate_limit: {
        primary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_after_seconds: 60, reset_at: 0 },
        secondary_window: null,
      },
    }));

    const result = await fetchCodexUsage(account, { fetch, now: () => NOW_MS });

    expect(fetch).toHaveBeenCalledWith(CODEX_USAGE_ENDPOINT, expect.objectContaining({
      headers: { authorization: "Bearer access-a" },
      signal: expect.any(AbortSignal),
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.update.buckets[0].primary!.utilization).toBe(0.4);
    }
  });

  it("classifies auth, http, network, and malformed failures", async () => {
    const account = makeAccount("a");

    const unauthorized = await fetchCodexUsage(account, {
      fetch: vi.fn(async () => new Response("denied", { status: 401 })),
    });
    expect(unauthorized).toEqual({ ok: false, reason: "auth" });

    const overloaded = await fetchCodexUsage(account, {
      fetch: vi.fn(async () => new Response("busy", { status: 503 })),
    });
    expect(overloaded).toEqual({ ok: false, reason: "http" });

    const offline = await fetchCodexUsage(account, {
      fetch: vi.fn(async () => { throw new Error("ECONNREFUSED"); }),
    });
    expect(offline).toEqual({ ok: false, reason: "network" });

    const nonsense = await fetchCodexUsage(account, {
      fetch: vi.fn(async () => Response.json({ error: "not a usage payload" })),
    });
    expect(nonsense).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("OpenAIUsageRefresher", () => {
  it("applies a fetched usage update to the account's rate limits", async () => {
    const account = makeAccount("a");
    const refresher = new OpenAIUsageRefresher(poolOf(account), {
      fetchUsage: async () => ({
        ok: true,
        update: {
          buckets: [{
            limitId: DEFAULT_CODEX_LIMIT_ID,
            primary: { utilization: 0.7, resetAt: 1_000, windowMinutes: 300 },
          }],
        },
      }),
    });

    const result = await refresher.refreshNow(account);

    expect(result.ok).toBe(true);
    const bucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID);
    expect(bucket?.primary?.utilization).toBe(0.7);
    refresher.stop();
  });

  it("refreshes a failed token before fetching, and keeps prior data on failure", async () => {
    const account = makeAccount("a");
    account.rateLimits.buckets.set(DEFAULT_CODEX_LIMIT_ID, {
      limitId: DEFAULT_CODEX_LIMIT_ID,
      primary: { utilization: 0.5, resetAt: 0, windowMinutes: 300 },
    });
    const fetchUsage = vi.fn();
    const refresher = new OpenAIUsageRefresher(poolOf(account), {
      prepare: async () => false,
      fetchUsage,
    });

    const result = await refresher.refreshNow(account);

    expect(result).toEqual({ ok: false, reason: "auth" });
    // A failed token refresh must not reach the endpoint with a dead token...
    expect(fetchUsage).not.toHaveBeenCalled();
    // ...and must not erase what the account already knew.
    expect(account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID)?.primary?.utilization).toBe(0.5);
    refresher.stop();
  });

  it("fetches every account on start, so usage is visible without any traffic", async () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    const fetched: string[] = [];
    const refresher = new OpenAIUsageRefresher(poolOf(a, b), {
      startupStaggerMs: 0,
      fetchUsage: async account => {
        fetched.push(account.id);
        return { ok: true, update: { buckets: [] } };
      },
    });

    refresher.start();
    await vi.waitFor(() => expect(fetched.sort()).toEqual(["a", "b"]), { timeout: 1_000, interval: 5 });
    refresher.stop();
  });
});
