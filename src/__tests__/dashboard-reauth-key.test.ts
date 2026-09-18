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

function health(account: Record<string, unknown> = {}) {
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
      healthy: false,
      busy: false,
      inFlightRequests: 0,
      activeSessions: 0,
      requestCount: 0,
      errorCount: 0,
      expiresInMs: 3_600_000,
      lastUsedMs: 0,
      lastRefreshMs: 0,
      enabled: true,
      authExpired: true,
      ...account,
    }],
    recentLogs: [],
  };
}

describe("dashboard re-auth key", () => {
  it("l with a Claude account focused emits the re-auth intent with the cached email and exits", async () => {
    const onIntent = vi.fn();
    const dash = renderDashboard(health(), { onIntent }, { rows: 40, columns: 220 });
    try {
      vi.mocked(globalThis.fetch).mockImplementation(input => {
        if (String(input).endsWith("/cc-router/accounts")) return Promise.resolve(Response.json({
          accounts: [{
            id: "max-account-1",
            provider: "anthropic_subscription",
            accountInfo: { accountType: "personal", email: "me@example.com", fetchStatus: "fresh", fetchedAt: Date.now() },
          }],
        }));
        return Promise.resolve(Response.json(health()));
      });
      // The accounts hint bar (and the identity detail line) only exist once
      // ACCOUNTS is focused, so wait for the logs-focus bar before tabbing.
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      await dash.press("\t");
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("[l] re-auth");
        expect(dash.lastFrame()).toContain("me@example.com");
      });
      await dash.press("l");
      await vi.waitFor(() => expect(onIntent).toHaveBeenCalledWith({
        kind: "reauth", id: "max-account-1", provider: "anthropic_subscription", email: "me@example.com",
      }));
    } finally {
      await dash.cleanup();
    }
  });

  it("l with logs focused does nothing", async () => {
    const onIntent = vi.fn();
    const dash = renderDashboard(health(), { onIntent }, { rows: 40, columns: 220 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      await dash.press("l");
      await new Promise(r => setTimeout(r, 150));
      expect(onIntent).not.toHaveBeenCalled();
    } finally {
      await dash.cleanup();
    }
  });

  it("l with a Grok account focused explains where Grok credentials live", async () => {
    const onIntent = vi.fn();
    const grok = health({ id: "grok-1", provider: "xai_subscription", authExpired: false, healthy: true });
    const dash = renderDashboard(grok, { onIntent }, { rows: 40, columns: 220 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      await dash.press("\t");
      await dash.press("l");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Grok credentials live in ~/.grok"));
      expect(onIntent).not.toHaveBeenCalled();
    } finally {
      await dash.cleanup();
    }
  });

  it("marks a selected account with no refresh token as token-only", async () => {
    const dash = renderDashboard(health({ tokenOnly: true }), {}, { rows: 40, columns: 220 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      await dash.press("\t");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("token-only"));
    } finally {
      await dash.cleanup();
    }
  });
});
