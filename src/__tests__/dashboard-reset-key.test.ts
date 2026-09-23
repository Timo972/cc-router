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
        anthropic: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
        openai: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
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
      id: "chatgpt-1",
      codexRateLimits: { buckets: [], resetCredits: { available: 2 } },
      provider: "openai_subscription",
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

const OK_RESETS = {
  eligible: true, available: 1, usableNow: true, requiresLimit: false,
  useBy: 1_792_684_800, clears: ["five_hour", "seven_day"],
};

function claudeHealth(limitResets: object = OK_RESETS) {
  const h = health();
  h.operational.providers.anthropic = { configured: true, accounts: 1, healthy: 1, enabled: 1 };
  h.operational.providers.openai = { configured: false, accounts: 0, healthy: 0, enabled: 0 };
  h.accounts = [{
    id: "claude-1",
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
    rateLimits: {
      status: "allowed",
      fiveHourUtil: 0,
      fiveHourReset: 0,
      sevenDayUtil: 0,
      sevenDayReset: 0,
      claim: "",
      plan: "max",
      requestsLimit: 0,
      lastUpdated: 1,
      usage: {
        modelLimits: [],
        fetchedAt: 1,
        fetchStatus: "fresh",
        limitResets,
      },
    },
  }] as unknown as typeof h.accounts;
  return h;
}

describe("dashboard Ctrl+R account reset", () => {
  it("requires account focus and confirmation, then spends once for the selected account", async () => {
    const dash = renderDashboard(health(), {}, { rows: 40, columns: 240 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      const requests: RequestInit[] = [];
      let finish!: (response: Response) => void;
      vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
        if (String(url).endsWith("/accounts/chatgpt-1/reset-usage")) {
          requests.push(init!);
          return new Promise(resolve => { finish = resolve; });
        }
        return Promise.resolve(Response.json(health()));
      });
      await dash.press("\u0012");
      expect(dash.lastFrame()).not.toContain("Redeem 1 reset");
      await dash.press("\t");
      await dash.press("r");
      await dash.press("\u001br");
      expect(dash.lastFrame()).not.toContain("Redeem 1 reset");
      await dash.press("\u0012");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain('Redeem 1 reset for "chatgpt-1"'));
      expect(requests).toHaveLength(0);
      await dash.press("n");
      expect(requests).toHaveLength(0);
      await dash.press("\u0012");
      await dash.press("y");
      await dash.waitUntil(() => expect(requests).toHaveLength(1));
      await dash.press("\u0012");
      await dash.press("y");
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe("POST");
      expect(JSON.parse(requests[0].body as string).redeemRequestId).toMatch(/^[a-f0-9-]{36}$/);
      finish(Response.json({ reset: { provider: "openai", code: "reset", usageRefreshed: true } }));
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Usage reset redeemed for chatgpt-1"));
    } finally { await dash.cleanup(); }
  });

  it("reuses the redemption ID after an uncertain failure and health reconnect", async () => {
    const dash = renderDashboard(health(), {}, { rows: 40, columns: 240 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      const ids: string[] = [];
      let offline = false;
      vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
        if (String(url).endsWith("/reset-usage")) {
          ids.push(JSON.parse(init!.body as string).redeemRequestId);
          return ids.length === 1 ? Promise.reject(new Error("connection lost"))
            : Promise.resolve(Response.json({ reset: { provider: "openai", code: "already_redeemed", usageRefreshed: true } }));
        }
        if (offline) return Promise.reject(new Error("offline"));
        return Promise.resolve(Response.json(health()));
      });
      await dash.press("\t");
      await dash.press("\u0012");
      await dash.press("y");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Reset outcome unknown"));
      offline = true;
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Retrying every"));
      offline = false;
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      await dash.press("\t");
      await dash.press("\u0012");
      await dash.press("y");
      await dash.waitUntil(() => expect(ids).toHaveLength(2));
      expect(ids[1]).toBe(ids[0]);
    } finally { await dash.cleanup(); }
  }, 10_000);

  it.each(["zero", "claude"])("does not offer redemption for %s", async kind => {
    const data = health();
    if (kind === "zero") data.accounts[0].codexRateLimits.resetCredits.available = 0;
    else data.accounts[0].provider = "anthropic_subscription";
    const dash = renderDashboard(data, {}, { rows: 40, columns: 240 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      await dash.press("\t");
      await dash.press("\u0012");
      expect(dash.lastFrame()).not.toContain("Redeem 1 reset");
      await dash.press("y");
      expect(vi.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    } finally { await dash.cleanup(); }
  });
});

it("keeps in-flight redemption ownership through a health reconnect", async () => {
  const dash = renderDashboard(health(), {}, { rows: 40, columns: 240 });
  let finish!: (response: Response) => void;
  try {
    await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
    let requests = 0;
    let offline = false;
    vi.mocked(globalThis.fetch).mockImplementation((url) => {
      if (String(url).endsWith("/reset-usage")) {
        requests++;
        return new Promise(resolve => { finish = resolve; });
      }
      return offline ? Promise.reject(new Error("offline")) : Promise.resolve(Response.json(health()));
    });
    await dash.press("\t");
    await dash.press("\u0012");
    await dash.press("y");
    await dash.waitUntil(() => expect(requests).toBe(1));
    offline = true;
    await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Retrying every"));
    offline = false;
    await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
    await dash.press("\t");
    await dash.press("\u0012");
    await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Reset already running"));
    await dash.press("y");
    expect(requests).toBe(1);
  } finally {
    finish?.(Response.json({ reset: { provider: "openai", code: "reset", usageRefreshed: true } }));
    await dash.cleanup();
  }
}, 10_000);

it("redeems the focused account rather than the first account", async () => {
  const data = health();
  data.accounts.push({ ...data.accounts[0], id: "chatgpt-2" });
  const dash = renderDashboard(data, {}, { rows: 50, columns: 240 });
  try {
    await dash.waitUntil(() => expect(dash.lastFrame()).toContain("chatgpt-2"));
    const targets: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
      if (init?.method === "POST") {
        targets.push(String(url));
        return Promise.resolve(Response.json({ reset: { provider: "openai", code: "reset", usageRefreshed: true } }));
      }
      return Promise.resolve(Response.json(data));
    });
    await dash.press("\t");
    await dash.press("\u001b[B");
    await dash.press("\u0012");
    await dash.waitUntil(() => expect(dash.lastFrame()).toContain('Redeem 1 reset for "chatgpt-2"'));
    await dash.press("y");
    await dash.waitUntil(() => expect(targets).toEqual(["http://localhost:3456/cc-router/accounts/chatgpt-2/reset-usage"]));
  } finally { await dash.cleanup(); }
});

describe("dashboard Ctrl+R Claude limit reset", () => {
  it("confirms the refilled windows and reports the remaining count", async () => {
    const dash = renderDashboard(claudeHealth(), {}, { rows: 40, columns: 240 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      const requests: RequestInit[] = [];
      vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
        if (String(url).endsWith("/accounts/claude-1/reset-usage")) {
          requests.push(init!);
          return Promise.resolve(Response.json({ reset: { provider: "anthropic", code: "reset", resetsLeft: 0, usageRefreshed: true } }));
        }
        return Promise.resolve(Response.json(claudeHealth()));
      });
      await dash.press("\t");
      await dash.press("\u0012");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Refills 5h + 7d limits"));
      expect(dash.lastFrame()).toContain('Redeem 1 reset for "claude-1"');
      expect(requests).toHaveLength(0);
      await dash.press("y");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Limits reset for claude-1 · 0 left"));
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe("POST");
    } finally { await dash.cleanup(); }
  });

  it("explains an outdated Claude Code surface and sends nothing", async () => {
    const data = claudeHealth({ ...OK_RESETS, eligible: false, ineligibleReason: "cli_version" });
    const dash = renderDashboard(data, {}, { rows: 40, columns: 240 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      await dash.press("\t");
      await dash.press("\u0012");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Claude Code version too old for resets"));
      expect(dash.lastFrame()).not.toContain("Redeem 1 reset");
      await dash.press("y");
      await new Promise(r => setTimeout(r, 50)); // let any stray POST land before asserting none did
      expect(vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url).endsWith("/reset-usage"))).toHaveLength(0);
    } finally { await dash.cleanup(); }
  });

  it("shows a not-submitted router refusal and keeps the redemption id for the retry", async () => {
    const dash = renderDashboard(claudeHealth(), {}, { rows: 40, columns: 240 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      const ids: string[] = [];
      vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
        if (String(url).endsWith("/reset-usage")) {
          ids.push(JSON.parse(init!.body as string).redeemRequestId);
          return Promise.resolve(ids.length === 1
            ? Response.json({ error: "No reset available for this account" }, { status: 409 })
            : Response.json({ reset: { provider: "anthropic", code: "already_used", usageRefreshed: true, replay: true } }));
        }
        return Promise.resolve(Response.json(claudeHealth()));
      });
      await dash.press("\t");
      await dash.press("\u0012");
      await dash.press("y");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("No reset available for this account (claude-1)"));
      expect(dash.lastFrame()).not.toContain("Reset outcome unknown");
      await dash.press("\u0012");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain('Redeem 1 reset for "claude-1"'));
      await dash.press("y");
      await dash.waitUntil(() => expect(ids).toHaveLength(2));
      expect(ids[1]).toBe(ids[0]);
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Reset already used for claude-1 · nothing more spent"));
    } finally { await dash.cleanup(); }
  });

  it.each([
    [{ code: "already_used", replay: false }, "Reset already used elsewhere for claude-1 · nothing spent now"],
    [{ code: "not_limited", replay: true }, "claude-1 is not at a limit · an earlier attempt may have used a reset — check rst"],
  ])("words %j by whether the router replayed the request id", async (reset, text) => {
    const dash = renderDashboard(claudeHealth(), {}, { rows: 40, columns: 240 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      vi.mocked(globalThis.fetch).mockImplementation((url) => Promise.resolve(String(url).endsWith("/reset-usage")
        ? Response.json({ reset: { provider: "anthropic", usageRefreshed: true, ...reset } })
        : Response.json(claudeHealth())));
      await dash.press("\t");
      await dash.press("\u0012");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain('Redeem 1 reset for "claude-1"'));
      await dash.press("y");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain(text));
    } finally { await dash.cleanup(); }
  });

  it("treats a 502 as an unknown outcome", async () => {
    const dash = renderDashboard(claudeHealth(), {}, { rows: 40, columns: 240 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      vi.mocked(globalThis.fetch).mockImplementation((url) => Promise.resolve(String(url).endsWith("/reset-usage")
        ? Response.json({ error: "upstream detail" }, { status: 502 })
        : Response.json(claudeHealth())));
      await dash.press("\t");
      await dash.press("\u0012");
      await dash.press("y");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Reset outcome unknown for claude-1"));
      expect(dash.lastFrame()).not.toContain("upstream detail");
    } finally { await dash.cleanup(); }
  });
});
