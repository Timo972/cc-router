import { describe, expect, it } from "vitest";
import { createAllowanceView } from "../proxy/allowance.js";
import type { HealthAccountView, PublicAccountRateLimits, PublicCodexRateLimits } from "../proxy/server.js";

const NOW = 1_735_600_000_000;
const NOW_S = NOW / 1000;

function baseAnthropicRateLimits(overrides: Partial<PublicAccountRateLimits> = {}): PublicAccountRateLimits {
  return {
    status: "allowed",
    fiveHourUtil: 0.1,
    fiveHourReset: 0,
    sevenDayUtil: 0.1,
    sevenDayReset: 0,
    claim: "",
    plan: "",
    requestsLimit: 0,
    lastUpdated: 0,
    ...overrides,
  };
}

function baseCodexRateLimits(overrides: Partial<PublicCodexRateLimits> = {}): PublicCodexRateLimits {
  return {
    status: "ok",
    plan: "",
    buckets: [{
      limitId: "default",
      label: "default",
      primary: { utilization: 0.1, resetAt: 0, windowMinutes: 300 },
      secondary: { utilization: 0.1, resetAt: 0, windowMinutes: 10080 },
      cooldownUntilMs: 0,
    }],
    lastUpdated: 0,
    ...overrides,
  };
}

function anthropicView(overrides: Partial<HealthAccountView> = {}): HealthAccountView {
  return {
    id: "anthropic-1",
    provider: "anthropic_subscription",
    enabled: true,
    healthy: true,
    busy: false,
    inFlightRequests: 0,
    activeSessions: 0,
    requestCount: 0,
    errorCount: 0,
    expiresInMs: 1_000_000,
    lastUsedMs: 0,
    lastRefreshMs: 0,
    cooldownUntilMs: 0,
    globalCooldownUntilMs: 0,
    rateLimits: baseAnthropicRateLimits(),
    ...overrides,
  };
}

function openAIView(overrides: Partial<HealthAccountView> = {}): HealthAccountView {
  return {
    id: "openai-1",
    provider: "openai_subscription",
    enabled: true,
    healthy: true,
    busy: false,
    inFlightRequests: 0,
    activeSessions: 0,
    requestCount: 0,
    errorCount: 0,
    expiresInMs: 1_000_000,
    lastUsedMs: 0,
    lastRefreshMs: 0,
    cooldownUntilMs: 0,
    globalCooldownUntilMs: 0,
    codexRateLimits: baseCodexRateLimits(),
    ...overrides,
  };
}

describe("createAllowanceView", () => {
  it("anthropic: reports worst/best/spread across available accounts, status ok", () => {
    const views = [
      anthropicView({ id: "a1", rateLimits: baseAnthropicRateLimits({ sevenDayUtil: 0.4 }) }),
      anthropicView({ id: "a2", rateLimits: baseAnthropicRateLimits({ sevenDayUtil: 0.6 }) }),
      anthropicView({ id: "a3", rateLimits: baseAnthropicRateLimits({ sevenDayUtil: 0.5 }) }),
    ];

    const result = createAllowanceView(views, NOW);
    const anthropic = result.providers.anthropic;

    expect(result.ts).toBe(NOW);
    expect(anthropic.status).toBe("ok");
    expect(anthropic.accountsTotal).toBe(3);
    expect(anthropic.accountsAvailable).toBe(3);
    expect(anthropic.sevenDayUtil).toBe(0.6);
    expect(anthropic.sevenDayHeadroom).toBeCloseTo(0.6, 10);
    expect(anthropic.sevenDaySpread).toBeCloseTo(0.2, 10);
    expect(anthropic.earliestResetAt).toBeNull();
  });

  it("anthropic: best account at 0.90 seven-day util -> constrained, earliestResetAt is the earliest reset", () => {
    const views = [
      anthropicView({
        id: "a1",
        rateLimits: baseAnthropicRateLimits({ sevenDayUtil: 0.90, sevenDayReset: NOW_S + 3600 }),
      }),
      anthropicView({
        id: "a2",
        rateLimits: baseAnthropicRateLimits({ sevenDayUtil: 0.95, sevenDayReset: NOW_S + 7200 }),
      }),
      anthropicView({
        id: "a3",
        rateLimits: baseAnthropicRateLimits({ sevenDayUtil: 0.99, sevenDayReset: NOW_S + 1800 }),
      }),
    ];

    const result = createAllowanceView(views, NOW);
    const anthropic = result.providers.anthropic;

    expect(anthropic.status).toBe("constrained");
    expect(anthropic.accountsAvailable).toBe(3);
    expect(anthropic.sevenDayUtil).toBeCloseTo(0.99, 10);
    expect(anthropic.sevenDayHeadroom).toBeCloseTo(0.10, 10);
    expect(anthropic.earliestResetAt).toBe(NOW + 1_800_000);
  });

  it("anthropic: all accounts cooling -> exhausted, utils null, earliestResetAt is the earliest cooldown", () => {
    const views = [
      anthropicView({ id: "a1", globalCooldownUntilMs: NOW + 5000 }),
      anthropicView({ id: "a2", globalCooldownUntilMs: NOW + 9000 }),
    ];

    const result = createAllowanceView(views, NOW);
    const anthropic = result.providers.anthropic;

    expect(anthropic.status).toBe("exhausted");
    expect(anthropic.accountsTotal).toBe(2);
    expect(anthropic.accountsAvailable).toBe(0);
    expect(anthropic.sevenDayUtil).toBeNull();
    expect(anthropic.sevenDayHeadroom).toBeNull();
    expect(anthropic.sevenDaySpread).toBeNull();
    expect(anthropic.fiveHourUtil).toBeNull();
    expect(anthropic.earliestResetAt).toBe(NOW + 5000);
  });

  it("openai: picks the larger-windowMinutes bucket window as the weekly (7d) signal", () => {
    const views = [
      openAIView({
        codexRateLimits: baseCodexRateLimits({
          buckets: [{
            limitId: "default",
            label: "default",
            primary: { utilization: 0.3, resetAt: 0, windowMinutes: 300 },
            secondary: { utilization: 0.7, resetAt: 0, windowMinutes: 10080 },
            cooldownUntilMs: 0,
          }],
        }),
      }),
    ];

    const result = createAllowanceView(views, NOW);
    const openai = result.providers.openai;

    expect(openai.status).toBe("ok");
    expect(openai.sevenDayUtil).toBe(0.7);
    expect(openai.fiveHourUtil).toBe(0.3);
  });

  it("excludes a disabled account from accountsTotal and availability", () => {
    const views = [
      openAIView({ id: "enabled-1", enabled: true }),
      openAIView({ id: "disabled-1", enabled: false }),
    ];

    const result = createAllowanceView(views, NOW);
    const openai = result.providers.openai;

    expect(openai.accountsTotal).toBe(1);
    expect(openai.accountsAvailable).toBe(1);
  });

  it("openai: bucket status rate_limited makes the account unavailable", () => {
    const views = [
      openAIView({ codexRateLimits: baseCodexRateLimits({ status: "rate_limited" }) }),
    ];

    const result = createAllowanceView(views, NOW);
    const openai = result.providers.openai;

    expect(openai.accountsTotal).toBe(1);
    expect(openai.accountsAvailable).toBe(0);
    expect(openai.status).toBe("exhausted");
  });

  it("excludes xai accounts entirely and keeps anthropic/openai independent", () => {
    const views: HealthAccountView[] = [
      anthropicView({ id: "a1" }),
      openAIView({ id: "o1" }),
      {
        id: "x1",
        provider: "xai_subscription",
        enabled: true,
        healthy: true,
        busy: false,
        inFlightRequests: 0,
        activeSessions: 0,
        requestCount: 0,
        errorCount: 0,
        expiresInMs: 1_000_000,
        lastUsedMs: 0,
        lastRefreshMs: 0,
      },
    ];

    const result = createAllowanceView(views, NOW);

    expect(Object.keys(result.providers)).toEqual(["anthropic", "openai"]);
    expect(result.providers.anthropic.accountsTotal).toBe(1);
    expect(result.providers.openai.accountsTotal).toBe(1);
  });

  it("reports cooling model families sorted and de-duplicated, across candidates", () => {
    const views = [
      anthropicView({
        id: "a1",
        modelCooldowns: [
          { modelFamily: "opus", untilMs: NOW + 1000 },
          { modelFamily: "sonnet", untilMs: NOW - 1000 },
        ],
      }),
      anthropicView({
        id: "a2",
        modelCooldowns: [{ modelFamily: "haiku", untilMs: NOW + 2000 }, { modelFamily: "opus", untilMs: NOW + 500 }],
      }),
    ];

    const result = createAllowanceView(views, NOW);

    expect(result.providers.anthropic.coolingModelFamilies).toEqual(["haiku", "opus"]);
  });
});
