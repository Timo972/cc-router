import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentVersion } from "../utils/self-update.js";
import { renderDashboard } from "./helpers/dashboard-harness.js";

vi.mock("../utils/cli-routing.js", () => ({
  readClaudeRouting: () => ({ target: "claude", enabled: true, path: "/tmp/settings.json" }),
  readCodexRouting: () => ({ target: "codex", enabled: false, path: "/tmp/config.toml" }),
  setClaudeRouting: vi.fn(),
  setCodexRouting: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function health() {
  return {
    status: "ok",
    version: getCurrentVersion(),
    mode: "standalone",
    target: "api.anthropic.com",
    uptime: 60,
    totalRequests: 0,
    totalErrors: 0,
    totalRefreshes: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    operational: {
      auth: { required: false },
      providers: {
        anthropic: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
        openai: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
      },
      endpoints: {
        health: "/cc-router/health",
        accounts: "/cc-router/accounts",
        refresh: "/cc-router/refresh",
        messages: "/v1/messages",
        responses: "/v1/responses",
        models: "/v1/models",
      },
      routing: { anthropicAliases: [], openAIAliases: [] },
      capabilities: {
        anthropicMessages: true,
        openAIResponses: true,
        crossProviderMessages: true,
        dynamicModels: true,
        accountManagement: true,
      },
    },
    accounts: [{
      id: "max-account-1",
      provider: "anthropic_subscription",
      healthy: true,
      busy: false,
      inFlightRequests: 0,
      activeSessions: 0,
      requestCount: 0,
      errorCount: 0,
      expiresInMs: 3_600_000,
      lastUsedMs: 0,
      lastRefreshMs: 0,
      enabled: true,
    }],
    recentLogs: [],
  };
}

/** Route the harness's global fetch stub: health polls keep working, the
 *  reload POST is answered by `refresh`. */
function routeFetch(refresh: (init: RequestInit | undefined) => Promise<Response>) {
  const fetchMock = vi.mocked(globalThis.fetch);
  fetchMock.mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith("/cc-router/refresh")) return refresh(init);
    return Promise.resolve(Response.json(health()));
  });
  return fetchMock;
}

describe("dashboard reload key", () => {
  it("posts /cc-router/refresh on R and shows the summary banner", async () => {
    const dash = renderDashboard(health(), {}, { rows: 40, columns: 220 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      const fetchMock = routeFetch(() => Promise.resolve(Response.json({
        refresh: { accounts: 3, usageRefreshed: 2, usageFailed: 1, tokenRefreshFailed: 0, durationMs: 40 },
      })));

      await dash.press("R");

      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("Reloaded 3 accounts — usage fresh for 2, 1 usage fetch failed");
      });
      const refreshCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/cc-router/refresh"));
      expect(refreshCalls).toHaveLength(1);
      expect(refreshCalls[0]?.[1]?.method).toBe("POST");
    } finally {
      await dash.cleanup();
    }
  });

  it("keeps the progress banner while a reload runs and refuses to stack a second one", async () => {
    const dash = renderDashboard(health(), {}, { rows: 40, columns: 220 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      let finish!: (response: Response) => void;
      const fetchMock = routeFetch(() => new Promise<Response>(resolve => { finish = resolve; }));

      await dash.press("R");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Reloading accounts, usage and models"));

      await dash.press("R");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Reload already running"));
      expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/cc-router/refresh"))).toHaveLength(1);

      finish(Response.json({ refresh: { accounts: 1, usageRefreshed: 1, usageFailed: 0, tokenRefreshFailed: 0, durationMs: 5 } }));
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Reloaded 1 accounts — usage fresh for 1"));
    } finally {
      await dash.cleanup();
    }
  });

  it("surfaces a failed reload as an error banner", async () => {
    const dash = renderDashboard(health(), {}, { rows: 40, columns: 220 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      routeFetch(() => Promise.resolve(new Response("nope", { status: 500 })));

      await dash.press("R");

      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Reload error: HTTP 500"));
    } finally {
      await dash.cleanup();
    }
  });
});
