import { describe, expect, it } from "vitest";
import {
  applyRateLimitHeaders,
  createHealthAccountViews,
  createOperationalStatus,
} from "../proxy/server.js";
import { AnthropicUsageRefresher } from "../providers/anthropic/usage-refresher.js";
import { applyUpstreamFailureRouting } from "../proxy/lease-lifecycle.js";
import { TokenPool } from "../proxy/token-pool.js";
import type { Account } from "../proxy/types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import { applyCodexRateLimits, createOpenAIAccount } from "../providers/openai/account-state.js";
import { parseCodexRateLimits } from "../providers/openai/usage.js";

function makeAnthropicAccount(): Account {
  return {
    id: "max-account-1",
    tokens: {
      accessToken: "ant-access",
      refreshToken: "ant-refresh",
      expiresAt: Date.now() + 60_000,
      scopes: ["user:inference"],
    },
    healthy: true,
    busy: false,
    requestCount: 2,
    errorCount: 0,
    lastUsed: 123,
    lastRefresh: 456,
    consecutiveErrors: 0,
    rateLimits: {
      status: "allowed",
      fiveHourUtil: 0.1,
      fiveHourReset: 0,
      sevenDayUtil: 0.2,
      sevenDayReset: 0,
      claim: "",
      plan: "Max 5x",
      requestsLimit: 500,
      lastUpdated: 789,
    },
    enabled: true,
    sessionLimitPercent: 80,
    weeklyLimitPercent: 90,
  };
}

describe("createHealthAccountViews", () => {
  it("combines Anthropic pool stats with OpenAI subscription account status", () => {
    const openAIAccount: OpenAISubscriptionAccount = {
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "openai-access",
      refreshToken: "openai-refresh",
      expiresAt: Date.now() + 120_000,
      enabled: true,
    };

    const views = createHealthAccountViews([makeAnthropicAccount()], [createOpenAIAccount(openAIAccount)]);

    expect(views.map(view => [view.id, view.provider])).toEqual([
      ["max-account-1", "anthropic_subscription"],
      ["openai-primary", "openai_subscription"],
    ]);
    expect(views[1]).toMatchObject({
      healthy: true,
      busy: false,
      inFlightRequests: 0,
      activeSessions: 0,
      requestCount: 0,
      errorCount: 0,
      enabled: true,
    });
    expect(views[0]).toMatchObject({
      inFlightRequests: 0,
      activeSessions: 0,
    });
    expect(views[1].rateLimits).toBeUndefined();
  });

  it("includes safe routing counters without exposing session identifiers", () => {
    const openAIAccount: OpenAISubscriptionAccount = {
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "openai-access",
      refreshToken: "openai-refresh",
      expiresAt: Date.now() + 120_000,
      enabled: true,
    };

    const views = createHealthAccountViews(
      [makeAnthropicAccount()],
      [createOpenAIAccount(openAIAccount)],
      accountId => accountId === "max-account-1"
        ? { inFlightRequests: 2, activeSessions: 3, coolingDown: true }
        : { inFlightRequests: 0, activeSessions: 0, coolingDown: false },
    );

    expect(views[0]).toMatchObject({
      busy: true,
      inFlightRequests: 2,
      activeSessions: 3,
    });
    expect(views[1]).toMatchObject({
      inFlightRequests: 0,
      activeSessions: 0,
    });
    expect(JSON.stringify(views)).not.toContain("session-a");
  });

  it("does not count disabled Anthropic accounts as healthy", () => {
    const disabled = { ...makeAnthropicAccount(), enabled: false };

    const views = createHealthAccountViews([disabled], []);

    expect(views[0]).toMatchObject({
      enabled: false,
      healthy: false,
    });
  });

  it("redacts arbitrary representative claims to bounded public categories", () => {
    const account = makeAnthropicAccount();
    account.rateLimits.claim = "private-future-claim-with-customer-data";

    const [view] = createHealthAccountViews([account], []);

    expect(view.rateLimits?.claim).toBe("unknown");
    expect(account.rateLimits.claim).toBe("private-future-claim-with-customer-data");
    expect(JSON.stringify(view)).not.toContain("customer-data");
  });

  it("exposes bounded normalized usage and cooldown summaries without OAuth or raw claims", () => {
    const account = makeAnthropicAccount();
    account.rateLimits.claim = "seven_day_private-customer-claim";
    account.rateLimits.usage = {
      fiveHour: { utilization: 0.25, resetAt: 1_735_689_600 },
      sevenDay: { utilization: 0.4, resetAt: 1_735_776_000 },
      modelLimits: [{
        kind: "weekly_scoped",
        group: "weekly",
        modelId: "claude-future-private-model",
        modelFamily: "future-model",
        displayName: "Claude Future",
        utilization: 0.9,
        resetAt: 1_735_862_400,
        active: true,
        severity: "warning",
      }],
      extraUsage: {
        enabled: true,
        spendLimitReached: false,
        disabledReason: "internal-upstream-detail",
        usedMinor: 42,
        limitMinor: 100,
        currency: "USD",
      },
      fetchedAt: 1_735_600_000_000,
      fetchStatus: "fresh",
    };

    const [view] = createHealthAccountViews([account], [], () => ({
      inFlightRequests: 0,
      activeSessions: 0,
      coolingDown: true,
      cooldownUntilMs: 1_735_600_010_000,
      globalCooldownUntilMs: 1_735_600_010_000,
      modelCooldowns: [{ modelFamily: "future-model", untilMs: 1_735_600_020_000 }],
    }));

    expect(view.rateLimits).toMatchObject({
      claim: "seven_day_model",
      usage: {
        fiveHour: { utilization: 0.25, resetAt: 1_735_689_600 },
        sevenDay: { utilization: 0.4, resetAt: 1_735_776_000 },
        modelLimits: [{
          displayName: "Claude Future",
          modelFamily: "future-model",
          utilization: 0.9,
          resetAt: 1_735_862_400,
          active: true,
          severity: "warning",
        }],
        extraUsage: { enabled: true, spendLimitReached: false, usable: false },
        fetchedAt: 1_735_600_000_000,
        fetchStatus: "fresh",
      },
    });
    expect(view).toMatchObject({
      globalCooldownUntilMs: 1_735_600_010_000,
      modelCooldowns: [{ modelFamily: "future-model", untilMs: 1_735_600_020_000 }],
    });
    const serialized = JSON.stringify(view);
    for (const forbidden of [
      "ant-access", "ant-refresh", "claude-future-private-model",
      "internal-upstream-detail", "usedMinor", "currency",
    ]) expect(serialized).not.toContain(forbidden);
  });

  it("reports real OpenAI counters, buckets, credits, and cooldowns in the health view", () => {
    const account = createOpenAIAccount({ id: "openai-a", provider: "openai_subscription", accessToken: "header.e30.sig", refreshToken: "rt", expiresAt: Date.now() + 3_600_000, enabled: true });
    account.requestCount = 7;
    account.errorCount = 2;
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "42",
      "x-codex-secondary-used-percent": "5",
      "x-codex-bengalfox-primary-used-percent": "88",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-unlimited": "false",
    }, Date.now()), Date.now());

    const views = createHealthAccountViews([], [account], undefined, () => ({
      metrics: { inFlightRequests: 3, activeSessions: 2, coolingDown: false, cooldownUntilMs: 0 },
      cooldowns: { globalUntilMs: 0, bucketCooldowns: [] },
    }));

    const view = views[0]!;
    expect(view.requestCount).toBe(7);
    expect(view.errorCount).toBe(2);
    expect(view.inFlightRequests).toBe(3);
    expect(view.activeSessions).toBe(2);
    const codex = view.codexRateLimits!;
    expect(codex.buckets[0]?.limitId).toBe("codex");
    expect(codex.buckets[0]?.primary?.utilization).toBeCloseTo(0.42);
    expect(codex.buckets[1]).toMatchObject({ limitId: "codex_bengalfox", label: "gpt-5.6-sol" });
    expect(codex.credits).toEqual({ hasCredits: true, unlimited: false });
  });

  it("never exposes tokens or raw header values in the OpenAI health view", () => {
    const account = createOpenAIAccount({
      id: "openai-a",
      provider: "openai_subscription",
      accessToken: "header.e30.super-secret-access-token",
      refreshToken: "super-secret-refresh-token",
      expiresAt: Date.now() + 3_600_000,
      enabled: true,
    });
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "42",
      "x-codex-bengalfox-primary-used-percent": "88",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-balance": "raw-header-balance-value",
    }, Date.now()), Date.now());

    const [view] = createHealthAccountViews([], [account]);

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("header.e30.super-secret-access-token");
    expect(serialized).not.toContain("super-secret-refresh-token");
  });
});

describe("applyRateLimitHeaders", () => {
  it("keeps a good usage snapshot through a 429 header update so a failed refresh can mark it stale", async () => {
    const account = makeAnthropicAccount();
    account.rateLimits.usage = {
      fiveHour: { utilization: 0.25, resetAt: 1_700_000_000 },
      modelLimits: [],
      fetchedAt: 123,
      fetchStatus: "fresh",
    };
    const pool = new TokenPool([account]);

    applyUpstreamFailureRouting(429, "12", { account }, { invalidate: () => true }, pool);
    expect(applyRateLimitHeaders(account, {
      "anthropic-ratelimit-unified-status": "rate_limited",
      "anthropic-ratelimit-unified-5h-utilization": "0.8",
      "anthropic-ratelimit-unified-5h-reset": "1700001000",
      "anthropic-ratelimit-unified-7d-utilization": "0.4",
      "anthropic-ratelimit-unified-7d-reset": "1700100000",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
    })).toBe(true);

    const refresher = new AnthropicUsageRefresher(pool, {
      fetchUsage: async () => ({ ok: false, reason: "timeout" }),
    });
    await refresher.refreshNow(account);

    expect(account.rateLimits).toMatchObject({
      status: "rate_limited",
      fiveHourUtil: 0.8,
      claim: "five_hour",
      usage: {
        fiveHour: { utilization: 0.25, resetAt: 1_700_000_000 },
        fetchedAt: 123,
        fetchStatus: "stale",
      },
    });
    expect(pool.isCoolingDown(account.id)).toBe(true);
  });
});

describe("createOperationalStatus", () => {
  it("summarizes proxy capabilities without exposing secrets", () => {
    const anthropicAccount = makeAnthropicAccount();
    const openAIAccount: OpenAISubscriptionAccount = {
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "openai-access",
      refreshToken: "openai-refresh",
      expiresAt: Date.now() + 120_000,
      enabled: true,
    };

    const status = createOperationalStatus({
      mode: "standalone",
      target: "https://api.anthropic.com",
      authRequired: true,
      accounts: createHealthAccountViews([anthropicAccount], [createOpenAIAccount(openAIAccount)]),
      modelRouting: {
        anthropicDefaultModel: "claude-sonnet-4-6",
        openAIDefaultModel: "gpt-5-codex",
        anthropicAliases: { sonnet: "claude-sonnet-4-6" },
        openAIAliases: { codex: "gpt-5-codex" },
      },
    });

    expect(status).toEqual({
      mode: "standalone",
      target: "https://api.anthropic.com",
      auth: { required: true },
      providers: {
        anthropic: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
        openai: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
      },
      endpoints: {
        health: "/cc-router/health",
        accounts: "/cc-router/accounts",
        messages: "/v1/messages",
        responses: "/v1/responses",
        models: "/v1/models",
      },
      routing: {
        anthropicDefaultModel: "claude-sonnet-4-6",
        openAIDefaultModel: "gpt-5-codex",
        anthropicAliases: ["sonnet"],
        openAIAliases: ["codex"],
      },
      capabilities: {
        anthropicMessages: true,
        openAIResponses: true,
        crossProviderMessages: true,
        dynamicModels: true,
        accountManagement: true,
      },
    });

    expect(JSON.stringify(status)).not.toContain("openai-access");
    expect(JSON.stringify(status)).not.toContain("ant-access");
  });
});
