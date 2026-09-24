import { describe, expect, it } from "vitest";
import { chartColumns, heatmapWeeks, activityLevel, formatTokens, legendColor, legendGlyph } from "../ui/usage-chart.js";

describe("usage chart layout", () => {
  const buckets = Array.from({ length: 24 }, (_, i) => ({ label: String(i), series: [
    { provider: "anthropic_subscription", model: "sonnet", tokens: i + 1 },
    { provider: "openai_subscription", model: "codex", tokens: i + 2 },
  ] }));
  it("conserves totals when merging columns to fit a narrow viewport", () => {
    const expected = buckets.flatMap(b => b.series).reduce((n, s) => n + s.tokens, 0);
    for (const width of [1, 7, 24, 100]) {
      const chart = chartColumns(buckets, width, 8, true);
      expect(chart.columns.length).toBeLessThanOrEqual(width);
      expect(chart.columns.reduce((n, c) => n + c.total, 0)).toBe(expected);
      expect(chart.columns.every(c => c.cells.length === 8)).toBe(true);
    }
  });
  it("model differentiation never changes totals and overflow is retained", () => {
    const input = [{ label: "day", series: Array.from({ length: 25 }, (_, i) => ({ provider: "openai_subscription", model: `m${i}`, tokens: 10 })) }];
    const grouped = chartColumns(input, 1, 10, false);
    const models = chartColumns(input, 1, 10, true);
    expect(grouped.columns[0].total).toBe(250);
    expect(models.columns[0].total).toBe(250);
    expect(grouped.legend).toHaveLength(1);
    expect(models.legend.length).toBeLessThanOrEqual(8);
    expect(models.legend.some(s => s.label.includes("Other"))).toBe(true);
  });
  it("handles zero buckets and formats finite tiny or large totals", () => {
    expect(chartColumns([], 10, 5, true).columns).toEqual([]);
    expect(chartColumns([{ label: "0", series: [] }], 1, 5, false).columns[0].cells.every(c => c === null)).toBe(true);
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });
  it("places leap days in Monday-first week columns without losing days", () => {
    const days = Array.from({ length: 366 }, (_, n) => new Date(Date.UTC(2024, 0, 1 + n)).toISOString().slice(0, 10));
    const weeks = heatmapWeeks(days);
    expect(weeks.flat().filter(Boolean)).toEqual(days);
    expect(weeks[0][0]).toBe("2024-01-01");
    expect(weeks.some(w => w[3] === "2024-02-29")).toBe(true);
    expect(activityLevel(0, 100)).toBe(0);
    expect(activityLevel(100, 100)).toBe(4);
    expect(activityLevel(1, 100)).toBeGreaterThan(0);
  });
});

it("keeps a model color when its legend position changes", () => {
  const model = { key: "openai_subscription:codex", provider: "openai_subscription", label: "codex" };
  expect(legendColor(model, 0, true)).toBe(legendColor(model, 5, true));
});

it("gives colliding model colors distinct stack glyphs", () => {
  const one = { key: "anthropic_subscription:claude-sonnet-4-6", label: "sonnet", provider: "anthropic_subscription" };
  const two = { key: "anthropic_subscription:claude-haiku-4-5", label: "haiku", provider: "anthropic_subscription" };
  expect(legendGlyph(one, 0, true)).not.toBe(legendGlyph(two, 1, true));
});

it("keeps a small provider visible in the stack instead of rounding it away", () => {
  const hour = (claude: number, openai: number) => ({ label: "13", series: [
    { provider: "anthropic_subscription", model: "claude", tokens: claude },
    { provider: "openai_subscription", model: "gpt", tokens: openai },
  ] });
  // Real hourly shape: OpenAI at ~2% of Claude used to get zero of eight cells.
  const { columns } = chartColumns([hour(115_900_000, 4_200_000), hour(52_100_000, 1_100_000)], 2, 8, false);
  for (const column of columns) {
    const cells = column.cells.filter(Boolean);
    expect(cells).toContain("openai_subscription");
    expect(cells.filter(key => key === "anthropic_subscription").length).toBeGreaterThan(1);
  }
  // A one-cell column still shows both series rather than only the larger one.
  const tiny = chartColumns([hour(1_000_000, 10), hour(100_000_000, 0)], 2, 8, false).columns[0].cells.filter(Boolean);
  expect(new Set(tiny)).toEqual(new Set(["anthropic_subscription", "openai_subscription"]));
  // Bars still stack bottom-up in legend order: the first series sits at the base.
  expect(columns[0].cells.at(-1)).toBe("anthropic_subscription");
});

it("never draws a column taller than the chart when series outnumber rows", () => {
  const series = Array.from({ length: 6 }, (_, i) => ({ provider: "anthropic_subscription", model: `m${i}`, tokens: 1000 * (i + 1) }));
  const [column] = chartColumns([{ label: "01", series }], 1, 2, true, 8).columns;
  expect(column.cells).toHaveLength(2);
  // The rows that fit go to the largest contributors, not the first legend entries.
  expect(new Set(column.cells)).toEqual(new Set(["anthropic_subscription:m5", "anthropic_subscription:m4"]));
});
