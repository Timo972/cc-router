import { describe, expect, it } from "vitest";
import { queryUsage } from "../usage/query.js";
import type { UsageDelta, UsageSnapshot } from "../usage/types.js";
import { totalSpend, totalTokens, zeroSpend, zeroTokens } from "../usage/types.js";
const p = "openai_subscription" as const;
function snapshot(): UsageSnapshot { return { version: 1, trackingSince: "2023-01-01T00:00:00.000Z", observations: [], deltas: [], aggregates: [], accounts: [{ key: "a", alias: "personal", provider: p }], subscriptions: [{ accountKey: "a", provider: p, monthlyUsd: 31, from: "2023-01-01T00:00:00.000Z" }], warnings: [], health: { status: "ok", warnings: [] } }; }
function delta(patch: Partial<UsageDelta> = {}): UsageDelta { return { attemptId: "a", ts: "2026-01-01T01:00:00.000Z", accountKey: "a", provider: p, model: "fixture", tokens: { ...zeroTokens(), input: 1e6, output: 1e6 }, rates: { input: 2, output: 8, source: "fixture", effectiveDate: "2026-01-01" }, ...patch }; }
describe("usage queries", () => {
  it("uses exact frozen input/output prices and daily monthly subscription proration", () => {
    const state = snapshot(); state.deltas.push(delta()); const report = queryUsage(state, { period: "day", date: "2026-01-01" }, "2026-01-03");
    expect(report.costs.pricedApiUsd).toBe(10); expect(report.costs.subscriptionUsd).toBe(1);
    expect(report.costs.savingsUsd).toBe(9); expect(report.costs.savingsPercent).toBe(90);
    expect(report.buckets).toHaveLength(24); expect(report.days).toHaveLength(365);
    expect(report.days[0].coverage).toBe("complete"); expect(report.days[0].selected).toBe(true);
    expect(report.buckets[1].tokens.input).toBe(1e6);
    expect(Object.values(report.buckets[1].series)[0].model).toBe("fixture");
    expect(report.costs.coverage.pricedTokens).toBe(2e6);
  });
  it("carries frozen spend per bucket, series and day, split by token category", () => {
    const state = snapshot();
    state.deltas = [delta(), delta({ attemptId: "b", model: "other", tokens: { ...zeroTokens(), cacheRead: 1e6, cacheWrite: 1e6 }, rates: { input: 2, output: 8, cacheRead: 0.5, source: "fixture", effectiveDate: "2026-01-01" } })];
    const report = queryUsage(state, { period: "day", date: "2026-01-01" }, "2026-01-03");
    // Unpriced cache creation contributes tokens but no spend; the split lets the dashboard show input/output/sum.
    expect(report.buckets[1].usd).toEqual({ input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 });
    expect(totalSpend(report.buckets[1].usd)).toBeCloseTo(report.costs.pricedApiUsd);
    expect(report.buckets[0].usd).toEqual(zeroSpend());
    const series = Object.values(report.buckets[1].series);
    expect(series.find(s => s.model === "fixture")?.usd).toEqual({ input: 2, output: 8, cacheRead: 0, cacheWrite: 0 });
    expect(series.find(s => s.model === "other")?.usd).toEqual({ input: 0, output: 0, cacheRead: 0.5, cacheWrite: 0 });
    expect(report.days[0].usd).toEqual(report.buckets[1].usd);
    expect(Object.values(report.days[0].series).find(s => s.model === "other")?.usd.cacheRead).toBe(0.5);
  });
  it("sums cache creation once and prices duration subsets and unknown remainder separately", () => {
    const state = snapshot(); state.deltas = [delta({ tokens: { ...zeroTokens(), cacheWrite: 1e6, cacheWrite5m: 400000, cacheWrite1h: 300000 }, rates: { input: 2, output: 8, cacheWrite5m: 3, cacheWrite1h: 4, source: "fixture", effectiveDate: "2026-01-01" } })];
    const report = queryUsage(state, { period: "day", date: "2026-01-01" }, "2026-01-03");
    expect(totalTokens(report.totals)).toBe(1e6); expect(report.costs.pricedApiUsd).toBeCloseTo(2.4);
    expect(report.costs.coverage.pricedTokens).toBe(700000); expect(report.costs.coverage.unpricedTokens).toBe(300000);
    expect(report.costs.savingsUsd).toBeNull(); expect(report.costs.savingsPercent).toBeNull();
  });
  it("does not use generic creation rates as a duration fallback", () => {
    const state = snapshot(); state.deltas = [delta({ tokens: { ...zeroTokens(), cacheWrite: 100, cacheWrite5m: 100 }, rates: { input: 2, output: 8, cacheWrite: 4, source: "x", effectiveDate: "2026-01-01" } })];
    expect(queryUsage(state, { period: "day", date: "2026-01-01" }, "2026-01-03").costs.coverage.unpricedTokens).toBe(100);
  });
  it("constructs UTC Monday weeks, leap-year daily grids and calendar-year buckets", () => {
    const state = snapshot(); const week = queryUsage(state, { period: "week", date: "2026-01-01" }, "2026-02-01");
    expect(week.start).toBe("2025-12-29T00:00:00.000Z"); expect(week.end).toBe("2026-01-05T00:00:00.000Z"); expect(week.buckets).toHaveLength(7);
    expect(week.days[0].date).toBe("2026-01-01");
    const year = queryUsage(state, { period: "year", date: "2024-02-29" }, "2026-01-01");
    expect(year.days).toHaveLength(366); expect(year.buckets).toHaveLength(12); expect(year.days[59].date).toBe("2024-02-29");
    expect(queryUsage(state, { period: "month", date: "2024-02-01" }, "2026-01-01").buckets).toHaveLength(29);
  });
  it("clamps current-day cost and future observations at now without marking healthy current coverage missing", () => {
    const state = snapshot(); state.deltas = [delta(), delta({ attemptId: "future", ts: "2026-01-01T18:00:00.000Z" })];
    const report = queryUsage(state, { period: "day", date: "2026-01-01" }, "2026-01-01T12:00:00.000Z");
    expect(report.costs.subscriptionUsd).toBe(0.5); expect(report.costs.pricedApiUsd).toBe(10);
    expect(report.days[0].coverage).toBe("partial"); expect(report.days[1].coverage).toBe("future");
    expect(report.costs.coverage.trackingComplete).toBe(true); expect(report.costs.savingsUsd).toBe(9.5);
  });
  it("includes paid inactive and retired accounts and keeps explicit empty selection empty", () => {
    const state = snapshot(); state.accounts[0].retired = true;
    const noTraffic = queryUsage(state, { period: "day", date: "2026-01-01" }, "2026-01-02");
    expect(noTraffic.costs.subscriptionUsd).toBe(1); expect(noTraffic.costs.savingsUsd).toBe(-1); expect(noTraffic.costs.savingsPercent).toBeNull();
    const none = queryUsage(state, { period: "day", date: "2026-01-01", providers: [] }, "2026-01-02");
    expect(none.costs.subscriptionUsd).toBe(0); expect(none.accounts).toEqual([]); expect(totalTokens(none.totals)).toBe(0);
  });
  it("filters provider costs, tokens, heatmap and model series consistently", () => {
    const state = snapshot(); state.accounts.push({ key: "b", provider: "anthropic_subscription", alias: "claude" });
    state.subscriptions.push({ accountKey: "b", provider: "anthropic_subscription", monthlyUsd: 62, from: "2023-01-01T00:00:00.000Z" });
    state.deltas = [delta(), delta({ attemptId: "b", provider: "anthropic_subscription", accountKey: "b" }), delta({ attemptId: "c", model: "model-2" })];
    const report = queryUsage(state, { period: "day", date: "2026-01-01", providers: [p] }, "2026-01-02");
    expect(report.costs.subscriptionUsd).toBe(1); expect(totalTokens(report.totals)).toBe(4e6); expect(totalTokens(report.days[0].tokens)).toBe(4e6);
    expect(Object.values(report.buckets[1].series).reduce((sum, s) => sum + totalTokens(s.tokens), 0)).toBe(4e6);
  });
  it("unknown pricing and unconfigured accounts suppress authoritative savings", () => {
    const state = snapshot(); state.subscriptions = []; state.deltas = [delta({ rates: undefined })];
    const report = queryUsage(state, { period: "day", date: "2026-01-01" }, "2026-01-02");
    expect(report.costs.pricedApiUsd).toBe(0); expect(report.costs.coverage.unpricedTokens).toBe(2e6);
    expect(report.costs.coverage.unconfiguredAccounts).toBe(1); expect(report.costs.savingsUsd).toBeNull();
    expect(report.warnings.join(" ")).toMatch(/pricing/i); expect(report.warnings.join(" ")).toMatch(/subscription/i);
  });
  it("marks pre-tracking and degraded persistence as incomplete, never known zero", () => {
    const state = snapshot(); state.trackingSince = "2026-01-01T12:00:00.000Z"; state.warnings = ["Recovered torn tail"]; state.health = { status: "degraded", warnings: state.warnings };
    const report = queryUsage(state, { period: "month", date: "2026-01-01" }, "2026-01-03");
    expect(report.costs.coverage.trackingComplete).toBe(false); expect(report.costs.coverage.persistenceHealthy).toBe(false);
    expect(report.days[0].coverage).toBe("partial"); expect(report.costs.savingsUsd).toBeNull();
    const earlier = queryUsage(state, { period: "day", date: "2025-12-31" }, "2026-01-03"); expect(earlier.days.at(-1)?.coverage).toBe("untracked");
  });
  it("counts hourly aggregates but not the cumulative observation view and preserves source inputs", () => {
    const state = snapshot(); const d = delta(); state.aggregates = [{ start: d.ts, end: "2026-01-01T02:00:00.000Z", accountKey: d.accountKey, provider: d.provider, model: d.model, tokens: d.tokens, rates: d.rates }];
    state.observations = [{ version: 1, revision: 1, complete: true, ...d }]; const before = structuredClone(state);
    expect(queryUsage(state, { period: "day", date: "2026-01-01" }, "2026-01-02").costs.pricedApiUsd).toBe(10); expect(state).toEqual(before);
  });
  it("rejects unknown periods/providers, non-calendar dates and oversized parameter lists", () => {
    for (const query of [{ period: "bad" }, { period: "day", date: "2026-02-29" }, { period: "day", providers: ["bad"] }, { period: "day", providers: Array(1000).fill(p) }]) expect(() => queryUsage(snapshot(), query as never, "2026-01-01")).toThrow();
  });
});

it("marks subscription interval gaps partial even when a cost row exists and shows priced subtotal", () => {
  const state = snapshot(); state.deltas = [delta()]; state.subscriptions[0].from = "2026-01-01T12:00:00.000Z";
  const result = queryUsage(state, { period: "day", date: "2026-01-01" }, new Date("2026-01-02"));
  expect(result.costs.subscriptionUsd).toBe(0.5); expect(result.costs.coverage.subscriptionComplete).toBe(false); expect(result.costs.savingsUsd).toBeNull();
  state.subscriptions = [{ ...state.subscriptions[0], from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T10:00:00.000Z" }, { ...state.subscriptions[0], from: "2026-01-01T11:00:00.000Z" }];
  expect(queryUsage(state, { period: "day", date: "2026-01-01" }, Date.parse("2026-01-02")).costs.coverage.subscriptionComplete).toBe(false);
  state.subscriptions[1].from = state.subscriptions[0].to!;
  expect(queryUsage(state, { period: "day", date: "2026-01-01" }, "2026-01-02").costs.coverage.subscriptionComplete).toBe(true);
});
it("bounds model series while preserving all token and frozen cost totals", () => {
  const state = snapshot(); state.deltas = Array.from({ length: 100 }, (_, i) => delta({ attemptId: `${i}`, model: `model-${i}` }));
  const result = queryUsage(state, { period: "day", date: "2026-01-01" }, "2026-01-02");
  expect(Object.keys(result.buckets[1].series).length).toBeLessThanOrEqual(16);
  expect(totalTokens(result.totals)).toBe(200e6); expect(result.costs.pricedApiUsd).toBe(1000);
  expect(Object.values(result.buckets[1].series).reduce((sum, s) => sum + totalTokens(s.tokens), 0)).toBe(200e6);
});
it("limits historical collection gaps to intersecting periods without poisoning future healthy savings", () => {
  const state = snapshot(); state.warnings = ["Recovered torn tail"]; state.gaps = [{ id: "torn", start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T11:00:00.000Z", reason: "Recovered torn tail" }];
  const intersecting = queryUsage(state, { period: "day", date: "2026-01-01" }, "2026-01-04");
  expect(intersecting.costs.savingsUsd).toBeNull(); expect(intersecting.costs.coverage.trackingComplete).toBe(false); expect(intersecting.days[0].coverage).toBe("partial");
  const later = queryUsage(state, { period: "day", date: "2026-01-02" }, "2026-01-04");
  expect(later.costs.savingsUsd).toBe(-1); expect(later.costs.coverage.persistenceHealthy).toBe(true); expect(later.days[1].coverage).toBe("complete"); expect(later.warnings).toContain("Recovered torn tail");
});
it("shows observed input from incomplete attempts without claiming complete savings coverage", () => {
  const state = snapshot(); const entry = delta({ tokens: { ...zeroTokens(), input: 1e6 } }); state.deltas = [entry];
  state.observations = [{ ...entry, version: 1, revision: 1, complete: false }];
  const report = queryUsage(state, { period: "day", date: "2026-01-01" }, "2026-01-03");
  expect(report.totals.input).toBe(1e6); expect(report.costs.pricedApiUsd).toBe(2);
  expect(report.costs.coverage.trackingComplete).toBe(false); expect(report.costs.savingsUsd).toBeNull(); expect(report.days[0].coverage).toBe("partial");
  state.observations[0].complete = true;
  expect(queryUsage(state, { period: "day", date: "2026-01-01" }, "2026-01-03").costs.savingsUsd).toBe(1);
});
