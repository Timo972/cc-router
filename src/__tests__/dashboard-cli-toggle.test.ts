import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentVersion } from "../utils/self-update.js";
import { renderDashboard } from "./helpers/dashboard-harness.js";

const routing = vi.hoisted(() => ({
  claude: { target: "claude" as const, enabled: true, path: "/tmp/settings.json" },
  codex: { target: "codex" as const, enabled: false, path: "/tmp/config.toml" },
  setClaude: vi.fn((enabled: boolean) => {
    routing.claude = { ...routing.claude, enabled };
    return { changed: true, enabled };
  }),
  setCodex: vi.fn((enabled: boolean) => {
    routing.codex = { ...routing.codex, enabled };
    return { changed: true, enabled };
  }),
}));

vi.mock("../utils/cli-routing.js", () => ({
  readClaudeRouting: () => routing.claude,
  readCodexRouting: () => routing.codex,
  setClaudeRouting: routing.setClaude,
  setCodexRouting: routing.setCodex,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  routing.claude = { target: "claude", enabled: true, path: "/tmp/settings.json" };
  routing.codex = { target: "codex", enabled: false, path: "/tmp/config.toml" };
  routing.setClaude.mockClear();
  routing.setCodex.mockClear();
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
        openai: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
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

describe("dashboard CLI toggles", () => {
  it("shows Claude/Codex routing and toggles them with c/x from logs focus", async () => {
    const dash = renderDashboard(health(), {}, { rows: 40, columns: 220 });
    try {
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("Claude on");
        expect(dash.lastFrame()).toContain("Codex off");
        expect(dash.lastFrame()).toContain("[c]/[x]");
      });
      await dash.press("c");
      await dash.waitUntil(() => {
        expect(routing.setClaude).toHaveBeenCalledWith(false);
        expect(dash.lastFrame()).toContain("Claude CLI → native");
      });
      await dash.press("x");
      await dash.waitUntil(() => {
        expect(routing.setCodex).toHaveBeenCalledWith(true);
        expect(dash.lastFrame()).toContain("Codex CLI → proxy");
      });
    } finally {
      await dash.cleanup();
    }
  });
});
