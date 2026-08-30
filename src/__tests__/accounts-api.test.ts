import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthAccountViews } from "../proxy/server.js";
import { DEFAULT_RATE_LIMITS, type Account, type ExtraUsageState } from "../proxy/types.js";
import { createAccountsApi } from "../ui/accountsApi.js";
import { getAccountCapacityRows } from "../ui/Dashboard.js";

function makeExtraUsageAccount(id: string, extraUsage: ExtraUsageState): Account {
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
    rateLimits: {
      ...DEFAULT_RATE_LIMITS,
      usage: {
        modelLimits: [{
          kind: "weekly_scoped",
          group: "weekly",
          modelFamily: "future",
          displayName: "Claude Future",
          utilization: 1,
          resetAt: 1_900_000_000,
          active: true,
          severity: "critical",
        }],
        extraUsage,
        fetchedAt: Date.now(),
        fetchStatus: "fresh",
      },
    },
    enabled: true,
    sessionLimitPercent: 100,
    weeklyLimitPercent: 100,
  };
}

describe("createAccountsApi", () => {
  afterEach(() => vi.restoreAllMocks());

  it("updates all accounts for a provider through the management endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      provider: "openai_subscription",
      enabled: false,
      changed: 2,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const api = createAccountsApi("http://router.local/", "secret");

    await api.setProviderEnabled("openai_subscription", false);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://router.local/cc-router/accounts/providers/openai_subscription",
      expect.objectContaining({
        method: "PATCH",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("reads the authenticated account safe view without retaining arbitrary response fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      accounts: [{
        id: "max-1",
        provider: "anthropic_subscription",
        rateLimits: { usage: { modelLimits: [] } },
        accessToken: "must-not-be-retained",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const api = createAccountsApi("http://router.local", "secret");
    const accounts = await api.list();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://router.local/cc-router/accounts",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer secret" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(accounts).toEqual([expect.objectContaining({
      id: "max-1",
      provider: "anthropic_subscription",
      rateLimits: expect.objectContaining({ usage: expect.objectContaining({ modelLimits: [] }) }),
      globalCooldownUntilMs: 0,
      modelCooldowns: [],
    })]);
    expect(JSON.stringify(accounts)).not.toContain("must-not-be-retained");
  });

  it("projects complete safe capacity data while normalizing adversarial values", async () => {
    const unsafeDisplay = `Claude\u0000 Future${"!".repeat(100)}`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      accounts: [{
        id: "max-1",
        provider: "anthropic_subscription",
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        sessionId: "session-secret",
        rateLimits: {
          status: "not-a-status",
          fiveHourUtil: 9,
          fiveHourReset: "bad",
          sevenDayUtil: 0.4,
          sevenDayReset: 1_900_000_000,
          claim: "seven_day_customer-data",
          plan: "private-plan",
          requestsLimit: -1,
          lastUpdated: 1_700_000_000_000,
          usage: {
            fiveHour: { utilization: -3, resetAt: 1_800_000_000 },
            sevenDay: { utilization: 0.5, resetAt: "bad" },
            modelLimits: [
              {
                modelFamily: "Future Model!",
                displayName: unsafeDisplay,
                utilization: 4,
                resetAt: -1,
                active: "yes",
                severity: "\u001b[2Jprivate-severity",
                modelId: "private-model-id",
              },
              ...Array.from({ length: 20 }, (_, index) => ({
                modelFamily: `model-${index}`,
                displayName: `Model ${index}`,
                utilization: 0.1,
                resetAt: 1_900_000_000,
                active: true,
                severity: "warning",
              })),
            ],
            extraUsage: { enabled: true, spendLimitReached: false, usable: "yes", currency: "USD", usedMinor: 999 },
            fetchedAt: -1,
            fetchStatus: "unexpected",
            rawClaim: "private-claim",
          },
        },
        globalCooldownUntilMs: "bad",
        modelCooldowns: [
          { modelFamily: "not safe!", untilMs: -1 },
          ...Array.from({ length: 20 }, (_, index) => ({ modelFamily: `model-${index}`, untilMs: 1_900_000_000 })),
        ],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const accounts = await createAccountsApi("http://router.local", "secret").list();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(accounts).toEqual([expect.objectContaining({
      id: "max-1",
      provider: "anthropic_subscription",
      rateLimits: expect.objectContaining({
        status: "unknown",
        fiveHourUtil: 1,
        fiveHourReset: 0,
        sevenDayUtil: 0.4,
        sevenDayReset: 1_900_000_000,
        claim: "seven_day_model",
        plan: "",
        requestsLimit: 0,
        usage: expect.objectContaining({
          fiveHour: { utilization: 0, resetAt: 1_800_000_000 },
          sevenDay: { utilization: 0.5, resetAt: 0 },
          fetchedAt: 0,
          fetchStatus: "unavailable",
          extraUsage: { enabled: true, spendLimitReached: false, usable: false },
        }),
      }),
      globalCooldownUntilMs: 0,
    })]);
    const [account] = accounts;
    expect(account.rateLimits?.usage?.modelLimits).toHaveLength(12);
    expect(account.rateLimits?.usage?.modelLimits[0]).toEqual({
      modelFamily: "unknown",
      displayName: `Claude Future${"!".repeat(67)}`,
      utilization: 1,
      resetAt: 0,
      active: false,
      severity: "unknown",
    });
    expect(account.modelCooldowns).toHaveLength(12);
    expect(JSON.stringify(accounts)).not.toMatch(/access-secret|refresh-secret|session-secret|private-model-id|private-claim|USD|999/);
  });

  it("uses only the server-computed effective extra-usage boolean end to end", async () => {
    const disabledByReason = makeExtraUsageAccount("disabled-extra", {
      enabled: true,
      spendLimitReached: false,
      disabledReason: "private-billing-reason",
    });
    const usable = makeExtraUsageAccount("usable-extra", {
      enabled: true,
      spendLimitReached: false,
    });
    const serverSafeViews = createHealthAccountViews([disabledByReason, usable], []);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      accounts: serverSafeViews,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const accounts = await createAccountsApi("http://router.local", "secret").list();

    expect(accounts[0].rateLimits?.usage?.extraUsage).toEqual({
      enabled: true,
      spendLimitReached: false,
      usable: false,
    });
    expect(getAccountCapacityRows(accounts[0])).toEqual([
      expect.objectContaining({ label: "Claude Future", state: "exhausted", color: "red" }),
    ]);
    expect(accounts[1].rateLimits?.usage?.extraUsage).toEqual({
      enabled: true,
      spendLimitReached: false,
      usable: true,
    });
    expect(getAccountCapacityRows(accounts[1])).toEqual([
      expect.objectContaining({ label: "Claude Future", state: "paid extra active", color: "yellow" }),
    ]);
    expect(JSON.stringify(accounts)).not.toContain("private-billing-reason");
  });
});
