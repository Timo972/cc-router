import { afterEach, describe, expect, it, vi } from "vitest";
import { KEY_DOWN, renderDashboard } from "./helpers/dashboard-harness.js";

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

/** An account whose usage carries many model-limit rows — renders much
 *  taller than the fleet's average row. */
function tallAccount(id: string) {
  const account = makeAccount(id);
  account.rateLimits.usage.modelLimits = Array.from({ length: 8 }, (_, i) => ({
    modelFamily: `family-${i}`,
    displayName: `Model Family ${i}`,
    utilization: 0.1 * i,
    resetAt: 0,
    active: true,
    severity: "",
  }));
  return account;
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

  it("re-fits immediately on a width-only resize that wraps lines taller", async () => {
    // Ink lays out at the new width on its own, but without a rows change the
    // old hook bailed out of the React commit — so the fitting effect never
    // remeasured the wrapped (taller) content and the overflow jump returned
    // until the next poll. Any resize must trigger a re-fit.
    const health = tallHealth();
    health.recentLogs = health.recentLogs.map(log => ({
      ...log,
      details: `sticky routed with a rather long explanation ${"x".repeat(110)}`,
    }));
    const dash = renderDashboard(health, {}, { rows: 60, columns: 220 });
    const ansi = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
    const maxLineWidth = (frame: string): number =>
      Math.max(...frame.split("\n").map(l => l.replace(ansi, "").length));
    try {
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("RECENT ACTIVITY");
        expect(frameHeight(dash.lastFrame())).toBeLessThanOrEqual(60);
      });

      // Freeze polling so only the resize path can trigger the re-fit.
      vi.stubGlobal("fetch", vi.fn(() => new Promise(() => { /* hang */ })));
      dash.resize({ columns: 90 });

      await dash.waitUntil(() => {
        const frame = dash.lastFrame();
        // Laid out at the new width...
        expect(maxLineWidth(frame)).toBeLessThanOrEqual(90);
        // ...and still fitting the viewport, header intact.
        expect(frameHeight(frame)).toBeLessThanOrEqual(60);
        expect(frame).toContain("CC-Router");
      });
    } finally {
      await dash.cleanup();
    }
  });

  it("never emits an unbounded frame while settling after a shrink", async () => {
    // The viewport bound must hold on EVERY React commit, not just the
    // settled one: a shrink that waits for the passive measurement effect
    // emits the old, now-oversized layout first — and one oversized frame is
    // all it takes for the terminal to scroll the header away.
    const dash = renderDashboard(tallHealth(), {}, { rows: 120, columns: 220 });
    try {
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("row20");
      });

      vi.stubGlobal("fetch", vi.fn(() => new Promise(() => { /* hang */ })));
      const before = dash.frames().length;
      dash.resize({ rows: 35, columns: 90 });

      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("CC-Router");
        expect(frameHeight(dash.lastFrame())).toBeLessThanOrEqual(35);
      });
      // Ink itself synchronously repaints the PREVIOUS commit's tree inside
      // the resize event, before React can deliver the new bound — that one
      // transient cannot be intercepted, but it is capped by the previous
      // viewport's bound. Everything React emits afterwards must carry the
      // new bound. Without the synchronous bound, the narrower wrapping
      // produced fully unbounded (~144-line) frames here.
      const heights = dash.frames().slice(before).map(frameHeight);
      for (const height of heights) {
        expect(height).toBeLessThanOrEqual(120 - 1); // never unbounded
      }
      expect(heights.filter(h => h > 35).length).toBeLessThanOrEqual(1);
    } finally {
      await dash.cleanup();
    }
  });

  it("keeps the selected account and its delete confirmation visible in a short pane", async () => {
    // Blind whole-frame clipping let keyboard navigation select an account
    // that was below the clip — and the delete confirmation rendered below
    // it too, so a user could confirm a deletion without seeing the target
    // or the prompt. The accounts list must follow its selection like the
    // activity list does.
    const dash = renderDashboard(tallHealth(), {}, { rows: 25, columns: 220 });
    try {
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("ACCOUNTS");
        expect(frameHeight(dash.lastFrame())).toBeLessThanOrEqual(25);
      });

      await dash.press("\t");        // focus the accounts panel
      await dash.press(KEY_DOWN, 8); // walk to the last account

      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("account-09");
        expect(frameHeight(dash.lastFrame())).toBeLessThanOrEqual(25);
      });

      await dash.press("d");
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain('Delete "account-09"');
        expect(frameHeight(dash.lastFrame())).toBeLessThanOrEqual(25);
      });
    } finally {
      await dash.cleanup();
    }
  }, 20_000);

  it("does not oscillate when the next hidden account is much taller than average", async () => {
    // The grow step estimated the next account's height from the AVERAGE of
    // the visible rows. Two short accounts followed by one tall account made
    // grow-add and overflow-remove alternate forever — hundreds of repaints
    // per second and React's maximum-update-depth warning.
    const health = tallHealth();
    health.accounts = [makeAccount("short-01"), makeAccount("short-02"), tallAccount("tall-03")];
    // 36 rows is the reproducing band: two short accounts fit with enough
    // slack that the average-based estimate keeps re-admitting the tall one.
    const dash = renderDashboard(health, {}, { rows: 36, columns: 220 });
    try {
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("ACCOUNTS");
      });
      // Freeze polling so any further repaints can only come from the
      // fitting controller itself.
      vi.stubGlobal("fetch", vi.fn(() => new Promise(() => { /* hang */ })));
      await new Promise(resolve => setTimeout(resolve, 300));
      const settled = dash.frames().length;
      await new Promise(resolve => setTimeout(resolve, 400));
      const later = dash.frames().length;
      expect(later - settled).toBeLessThanOrEqual(2);
      expect(frameHeight(dash.lastFrame())).toBeLessThanOrEqual(36);
    } finally {
      await dash.cleanup();
    }
  });

  it("keeps the delete confirmation visible when the selected account fills the pane", async () => {
    // A single account with many capacity rows can occupy the whole short
    // pane; the prompt used to render BELOW the account rows, where the clip
    // swallowed it — while confirmDelete input stayed armed, so an unseen
    // `y` deleted the account.
    const health = tallHealth();
    health.accounts = [tallAccount("tall-only")];
    const dash = renderDashboard(health, {}, { rows: 20, columns: 220 });
    try {
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("ACCOUNTS");
        expect(frameHeight(dash.lastFrame())).toBeLessThanOrEqual(20);
      });
      await dash.press("\t"); // focus accounts
      await dash.press("d");
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain('Delete "tall-only"');
        expect(frameHeight(dash.lastFrame())).toBeLessThanOrEqual(20);
      });
    } finally {
      await dash.cleanup();
    }
  }, 15_000);

  it("keeps the selected model above the clip in a short pane", async () => {
    // The models window followed its selection but at a fixed 16 rows; in a
    // short pane the outer clip hid its bottom rows while [c]/[o] still
    // applied the invisible selection.
    const health = tallHealth();
    health.accounts = [makeAccount("only-account")];
    const modelsPayload = {
      routing: {},
      models: Array.from({ length: 16 }, (_, i) => ({
        id: `anthropic/model-${String(i + 1).padStart(2, "0")}`,
      })),
    };
    const dash = renderDashboard(health, {}, { rows: 25, columns: 220 });
    try {
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("ACCOUNTS");
      });
      // Route model-list calls to the models payload; keep health for the poll.
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: unknown) =>
        String(url).includes("/cc-router/models")
          ? Response.json(modelsPayload)
          : Response.json(health),
      ));

      await dash.press("m"); // loads models and focuses the panel
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("MODELS");
      });
      await dash.press(KEY_DOWN, 15);

      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("model-16");
        expect(frameHeight(dash.lastFrame())).toBeLessThanOrEqual(25);
      });
    } finally {
      await dash.cleanup();
    }
  }, 20_000);

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
