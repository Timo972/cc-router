import { afterEach, describe, expect, it, vi } from "vitest";
import { followScrollWindow } from "../ui/Dashboard.js";
import { KEY_DOWN, KEY_UP, renderDashboard } from "./helpers/dashboard-harness.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("followScrollWindow", () => {
  it("keeps the window still while the selection moves inside it", () => {
    expect(followScrollWindow(5, 15, 50, 20)).toBe(5);
    expect(followScrollWindow(5, 5, 50, 20)).toBe(5);
    expect(followScrollWindow(5, 24, 50, 20)).toBe(5);
  });

  it("scrolls down by exactly one when the selection steps past the bottom edge", () => {
    // Window [0..19], selection moved to 20 → window [1..20].
    expect(followScrollWindow(0, 20, 50, 20)).toBe(1);
    // Window [5..24], selection moved to 25 → window [6..25].
    expect(followScrollWindow(5, 25, 50, 20)).toBe(6);
  });

  it("scrolls up by exactly one when the selection steps past the top edge", () => {
    // Window [10..29], selection moved to 9 → window [9..28].
    expect(followScrollWindow(10, 9, 50, 20)).toBe(9);
  });

  it("never scrolls when the whole list fits in the window", () => {
    expect(followScrollWindow(0, 9, 10, 20)).toBe(0);
    // A stale scroll position from a previously longer list clamps back to 0.
    expect(followScrollWindow(7, 3, 10, 20)).toBe(0);
  });

  it("clamps a stale scroll position when the list shrinks", () => {
    // 45 entries leave at most 25 hidden above the window.
    expect(followScrollWindow(40, 35, 45, 20)).toBe(25);
  });

  it("jumps the window when the selection lands far outside it", () => {
    // The selection is index-anchored to a timestamp, so a burst of new
    // entries can move it many rows at once — the window must still follow.
    expect(followScrollWindow(0, 40, 50, 20)).toBe(21);
    expect(followScrollWindow(30, 0, 50, 20)).toBe(0);
  });
});

describe("activity list follow-scroll", () => {
  it("scrolls the visible rows when the selection crosses the window edge", async () => {
    // 25 entries against LOG_VISIBLE = 20; ids row01 (newest, index 0) through
    // row25. The dashboard starts with the newest 20 visible.
    const recentLogs = Array.from({ length: 25 }, (_, i) => ({
      ts: 25_000 - i,
      accountId: `row${String(i + 1).padStart(2, "0")}`,
      model: "claude-fable-5",
      type: "route",
      statusCode: 200,
      durationMs: 5,
    }));
    const health = {
      status: "ok",
      mode: "direct",
      target: "api.anthropic.com",
      uptime: 60_000,
      totalRequests: 0,
      totalErrors: 0,
      totalRefreshes: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      accounts: [],
      recentLogs,
    };

    const dash = renderDashboard(health);
    try {
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("row01");
        expect(dash.lastFrame()).toContain("row20");
        expect(dash.lastFrame()).not.toContain("row21");
      });

      // 20 steps down: the selection walks from index 0 to 20, crossing the
      // bottom edge on the last step — the window must shift to [1..20].
      // row01 disappearing is the proof: the selected row's id also appears
      // in the detail panel, so its presence alone would not distinguish a
      // scrolled list from a stuck one.
      await dash.press(KEY_DOWN, 20);
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("row21");
        expect(dash.lastFrame()).not.toContain("row01");
      });

      // And back up: crossing the top edge scrolls the window back to [0..19].
      await dash.press(KEY_UP, 20);
      await dash.waitUntil(() => {
        expect(dash.lastFrame()).toContain("row01");
        expect(dash.lastFrame()).not.toContain("row21");
      });
    } finally {
      await dash.cleanup();
    }
  }, 20_000);
});
