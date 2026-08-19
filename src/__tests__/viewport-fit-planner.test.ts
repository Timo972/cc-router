import { describe, expect, it } from "vitest";
import { planViewportFit } from "../ui/Dashboard.js";
import type { FitList, FitMemory } from "../ui/Dashboard.js";

function memory(): FitMemory {
  return { attempts: {}, denials: {} };
}

describe("planViewportFit", () => {
  it("shrinks lists in order, converting lines through each list's row height", () => {
    const lists: FitList[] = [
      { key: "logs", current: 10, min: 3, max: 20, avgRow: 1 },
      { key: "accounts", current: 5, min: 1, max: 5, avgRow: 3 },
    ];
    // 10 lines over: logs can give up 7 rows (7 lines), accounts cover the
    // remaining 3 lines with one 3-line row.
    const targets = planViewportFit(10, lists, memory());
    expect(targets).toEqual({ logs: 3, accounts: 4 });
  });

  it("grows only the last list in priority order, one step at a time for growOne lists", () => {
    const lists: FitList[] = [
      { key: "logs", current: 3, min: 3, max: 20, avgRow: 1 },
      { key: "accounts", current: 2, min: 1, max: 5, avgRow: 2, growOne: true },
    ];
    const targets = planViewportFit(-6, lists, memory());
    // Reverse priority: accounts grow first, exactly one.
    expect(targets).toEqual({ accounts: 3 });
  });

  it("records a denial when a growth immediately overflows, and refines the next target downward", () => {
    const lists: FitList[] = [
      { key: "logs", current: 5, min: 3, max: 20, avgRow: 1 },
    ];
    const mem = memory();
    // Grow: slack 4 → target 5 + 3 = 8.
    expect(planViewportFit(-4, lists, mem)).toEqual({ logs: 8 });
    // That growth overflowed by 2 (the hidden rows wrapped taller).
    lists[0].current = 8;
    const shrink = planViewportFit(2, lists, mem);
    expect(shrink.logs).toBeLessThan(8);
    expect(mem.denials["logs"]).toMatchObject({ to: 8, slack: 6 });
    // Same slack again: the denied target must not be retried — the next
    // attempt steps DOWN from the denied target instead.
    lists[0].current = shrink.logs!;
    const retry = planViewportFit(-4, lists, mem);
    expect(retry.logs ?? lists[0].current).toBeLessThan(8);
  });

  it("clears attempts (growth fit) on slack without re-denying", () => {
    const lists: FitList[] = [{ key: "logs", current: 5, min: 3, max: 20, avgRow: 1 }];
    const mem = memory();
    planViewportFit(-4, lists, mem);
    expect(mem.attempts["logs"]).toBeDefined();
    lists[0].current = 8;
    planViewportFit(-1, lists, mem); // fits, slack too small to grow further
    expect(mem.attempts["logs"]).toBeUndefined();
    expect(mem.denials["logs"]).toBeUndefined();
  });

  it("converges without cycling for multi-line rows in every list", () => {
    // Simulation: real per-row line heights, including the three reported
    // oscillation shapes — a tall account below short ones, wrapped activity
    // rows, and 3-line wrapped model rows. The planner must reach a fixpoint
    // in a bounded number of steps for every budget.
    const logHeights = Array.from({ length: 20 }, (_, i) => (i % 5 === 4 ? 4 : 1));
    const accountHeights = [2, 2, 9, 2, 3];
    const modelHeights = Array.from({ length: 16 }, () => 3);
    const sum = (heights: number[], count: number) =>
      heights.slice(0, count).reduce((total, h) => total + h, 0);

    for (let budget = 10; budget <= 90; budget++) {
      const state = { logs: 3, accounts: 5, models: 16 };
      const mem = memory();
      let steps = 0;
      for (; steps < 60; steps++) {
        const chrome = 12;
        const used = chrome
          + sum(logHeights, state.logs)
          + sum(accountHeights, state.accounts)
          + sum(modelHeights, state.models);
        const lists: FitList[] = [
          {
            key: "logs", current: state.logs, min: 3, max: 20,
            avgRow: Math.max(1, sum(logHeights, state.logs) / state.logs),
          },
          {
            key: "accounts", current: state.accounts, min: 1, max: 5, growOne: true,
            avgRow: Math.max(1, sum(accountHeights, state.accounts) / state.accounts),
          },
          {
            key: "models", current: state.models, min: 3, max: 16,
            avgRow: Math.max(1, sum(modelHeights, state.models) / state.models),
          },
        ];
        const targets = planViewportFit(used - budget, lists, mem);
        if (Object.keys(targets).length === 0) break;
        for (const [key, value] of Object.entries(targets)) {
          state[key as keyof typeof state] = value;
        }
      }
      expect(steps, `budget ${budget} did not converge`).toBeLessThan(60);
    }
  });
});

describe("planViewportFit priority rebalancing", () => {
  it("reclaims budget from lower-priority lists when slack alone cannot fund a growth", () => {
    // Accounts (higher grow priority) sit below max while logs have absorbed
    // all the slack. Waiting for slack to reappear on its own would leave
    // the account list collapsed forever — the planner funds the growth by
    // shrinking logs in the same step.
    const lists: FitList[] = [
      { key: "logs", current: 12, min: 3, max: 20, avgRow: 1 },
      { key: "accounts", current: 1, min: 1, max: 3, avgRow: 3, growOne: true },
    ];
    const targets = planViewportFit(-1, lists, memory());
    expect(targets["accounts"]).toBe(2);
    expect(targets["logs"]).toBeLessThan(12);
  });

  it("does not fund a growth that is still denied", () => {
    const lists: FitList[] = [
      { key: "logs", current: 12, min: 3, max: 20, avgRow: 1 },
      { key: "accounts", current: 1, min: 1, max: 3, avgRow: 3, growOne: true },
    ];
    const mem = memory();
    mem.denials["accounts"] = { to: 2, slack: 50, expiresAt: 10_000 };
    const targets = planViewportFit(-1, lists, mem, 1_000);
    // The denial blocks the reclaim; the slack falls through to logs.
    expect(targets["accounts"]).toBeUndefined();
  });
});

describe("planViewportFit denial expiry", () => {
  it("retries a denied growth after the denial's TTL — row geometry may have changed", () => {
    const lists: FitList[] = [{ key: "logs", current: 5, min: 3, max: 20, avgRow: 1 }];
    const mem = memory();
    expect(planViewportFit(-4, lists, mem, 1_000)).toEqual({ logs: 8 });
    lists[0].current = 8;
    planViewportFit(2, lists, mem, 1_100); // denied
    lists[0].current = 6;
    // Within the TTL the denial clamps the target below the denied one...
    const early = planViewportFit(-4, lists, mem, 2_000);
    expect(early.logs ?? 6).toBeLessThan(8);
    // ...but once it expires, the full growth is retried: the rows the
    // denial was measured against may no longer exist.
    lists[0].current = 6;
    const late = planViewportFit(-4, lists, mem, 60_000);
    expect(late).toEqual({ logs: 9 });
  });
});
