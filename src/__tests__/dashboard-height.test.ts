import { afterEach, describe, expect, it, vi } from "vitest";
import { renderDashboard } from "./helpers/dashboard-harness.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeAccount(id: string) {
  return {
    id,
    provider: "anthropic_subscription",
    healthy: true,
    busy: false,
    inFlightRequests: 0,
    activeSessions: 0,
    requestCount: 3,
    errorCount: 0,
    expiresInMs: 3_600_000,
    lastUsedMs: 0,
    lastRefreshMs: 0,
    enabled: true,
    sessionLimitPercent: 100,
    weeklyLimitPercent: 100,
    modelCooldowns: [],
    rateLimits: {
      status: "allowed",
      fiveHourUtil: 0.4,
      fiveHourReset: 0,
      sevenDayUtil: 0.2,
      sevenDayReset: 0,
      claim: "",
      plan: "max",
      requestsLimit: 0,
      lastUpdated: 0,
      usage: {
        fiveHour: { utilization: 0.4, resetAt: 0 },
        sevenDay: { utilization: 0.2, resetAt: 0 },
        modelLimits: [{
          modelFamily: "fable",
          displayName: "Claude Fable",
          utilization: 0.3,
          resetAt: 0,
          active: true,
          severity: "",
        }],
        extraUsage: { enabled: false, spendLimitReached: false, usable: false },
        fetchedAt: 1,
        fetchStatus: "fresh",
      },
    },
  };
}

/** A payload shaped like the real deployment that surfaced the bug: many
 *  accounts and a full activity buffer, which renders far taller than a
 *  typical terminal pane. */
function tallHealth() {
  return {
    status: "ok",
    mode: "direct",
    target: "api.anthropic.com",
    uptime: 60_000,
    totalRequests: 86,
    totalErrors: 0,
    totalRefreshes: 0,
    totalCacheReadTokens: 1000,
    totalCacheCreationTokens: 10,
    totalInputTokens: 1200,
    totalOutputTokens: 50,
    operational: {
      auth: { required: false },
      providers: {
        anthropic: { configured: true, accounts: 9, healthy: 9, enabled: 9 },
        openai: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
      },
      endpoints: {
        health: "/cc-router/health",
        accounts: "/cc-router/accounts",
        messages: "/v1/messages",
        responses: "/v1/responses",
        models: "/v1/models",
      },
      routing: { anthropicAliases: [], openAIAliases: [] },
      capabilities: {
        anthropicMessages: true,
        openAIResponses: false,
        crossProviderMessages: false,
        dynamicModels: true,
        accountManagement: true,
      },
    },
    accounts: Array.from({ length: 9 }, (_, i) => makeAccount(`account-${String(i + 1).padStart(2, "0")}`)),
    recentLogs: Array.from({ length: 50 }, (_, i) => ({
      ts: 50_000 - i,
      accountId: `row${String(i + 1).padStart(2, "0")}`,
      model: "claude-fable-5",
      type: "route",
      statusCode: 200,
      durationMs: 5,
    })),
  };
}

function frameHeight(frame: string): number {
  return frame.split("\n").length;
}

describe("dashboard viewport fitting", () => {
  it("fits the frame into a short terminal and keeps the header visible", async () => {
    // Ink can only erase as many lines as the viewport holds. A frame taller
    // than the terminal makes every poll re-append it, scrolling the header
    // and OPERATIONS panel permanently out of view — the reported bug.
    const dash = renderDashboard(tallHealth(), {}, { rows: 45, columns: 220 });
    try {
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("ACCOUNTS");
        expect(frameHeight(dash.lastFrame())).toBeLessThanOrEqual(45);
      });
      const frame = dash.lastFrame();
      expect(frame).toContain("CC-Router");
      expect(frame).toContain("OPERATIONS");
    } finally {
      await dash.cleanup();
    }
  });

  it("shrinks the activity list before anything else on a mid-size terminal", async () => {
    // 60 rows: the chrome fits, so the activity list absorbs the deficit —
    // fewer rows visible, but the newest entries and the header both stay.
    const dash = renderDashboard(tallHealth(), {}, { rows: 60, columns: 220 });
    try {
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("RECENT ACTIVITY");
        expect(frameHeight(dash.lastFrame())).toBeLessThanOrEqual(60);
      });
      const frame = dash.lastFrame();
      expect(frame).toContain("CC-Router");
      expect(frame).toContain("row01"); // newest entry still listed
    } finally {
      await dash.cleanup();
    }
  });

  it("still shows the full 20 activity rows when the terminal is tall enough", async () => {
    const dash = renderDashboard(tallHealth(), {}, { rows: 120, columns: 220 });
    try {
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("row20");
      });
      expect(dash.lastFrame()).not.toContain("row21");
      expect(frameHeight(dash.lastFrame())).toBeLessThanOrEqual(120);
    } finally {
      await dash.cleanup();
    }
  });
});
