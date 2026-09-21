import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";
import { UsageDashboard } from "../ui/UsageDashboard.js";
import { zeroSpend, zeroTokens, type UsageReport, type UsageQuery } from "../usage/types.js";

function report(query: UsageQuery): UsageReport {
  const tokens = { ...zeroTokens(), input: 1000 };
  const usd = { ...zeroSpend(), input: 1 };
  const start = "2026-09-01T00:00:00.000Z", end = "2026-10-01T00:00:00.000Z";
  return { period: query.period, start, end, now: "2026-09-17T00:00:00.000Z", trackingSince: start,
    buckets: [{ start, end, tokens, usd, series: { a: { provider: "anthropic_subscription", model: "sonnet", tokens, usd } } }],
    days: [{ date: "2026-09-01", start, end, tokens, usd, selected: true, coverage: "complete", series: {} }],
    totals: tokens, accounts: [], warnings: [], costs: { pricedApiUsd: 1, subscriptionUsd: 2, savingsUsd: -1, savingsPercent: -100,
      coverage: { pricedTokens: 1000, unpricedTokens: 0, pricingComplete: true, configuredAccounts: 1, unconfiguredAccounts: 0, subscriptionComplete: true, trackingComplete: true, persistenceHealthy: true } } };
}
describe("UsageDashboard", () => {
  it("supports period, provider and model toggles with bounded terminal rows", async () => {
    const load = vi.fn(async (q: UsageQuery) => report(q));
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 32 });
    const frames: string[] = []; stdout.on("data", b => frames.push(String(b)));
    const instance = render(React.createElement(UsageDashboard, { load, initialQuery: { period: "month" } }), {
      stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    const exited = instance.waitUntilExit();
    try {
      await vi.waitFor(() => expect(frames.at(-1)).toContain("API cost"));
      expect(frames.at(-1)).not.toContain("Savings");
      stdin.push("\t");
      await vi.waitFor(() => expect(load.mock.calls.at(-1)?.[0].period).toBe("year"));
      stdin.push("1");
      await vi.waitFor(() => expect(load.mock.calls.at(-1)?.[0].providers).not.toContain("anthropic_subscription"));
      stdin.push("m");
      await vi.waitFor(() => expect(frames.at(-1)).toContain("Models"));
      stdout.columns = 48; stdout.rows = 18; stdout.emit("resize");
      await vi.waitFor(() => expect((frames.at(-1) ?? "").split("\n").length).toBeLessThanOrEqual(18));
      expect(frames.at(-1)).toContain("q quit");
    } finally { instance.unmount(); await exited; }
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });
});

function mountUsage(load: (query: UsageQuery) => Promise<UsageReport>, columns: number, rows: number) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  const stdout = Object.assign(new PassThrough(), { columns, rows });
  const frames: string[] = []; stdout.on("data", b => frames.push(String(b)));
  const instance = render(React.createElement(UsageDashboard, { load, initialQuery: { period: "month" } }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  const exited = instance.waitUntilExit();
  const plain = () => (frames.at(-1) ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  return { last: () => frames.at(-1) ?? "", plain, key: (s: string) => stdin.push(s), close: async () => { instance.unmount(); await exited; } };
}
it("keeps compact day inspection visible at 48 by 16", async () => {
  const ui = mountUsage(async q => report(q), 48, 16);
  try {
    await vi.waitFor(() => expect(ui.last()).toContain("API cost"));
    ui.key("g");
    await vi.waitFor(() => expect(ui.last()).toContain("day focus"));
    expect(ui.last()).toContain("2026-09-01");
    expect(ui.last()).toContain("1,000 tokens");
    expect(ui.last().split("\n").length).toBeLessThanOrEqual(16);
  } finally { await ui.close(); }
});
it("keeps Other visible and distinguishes future from untracked days", async () => {
  const ui = mountUsage(async q => {
    const r = report(q);
    r.buckets[0].series = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, { provider: "anthropic_subscription", model: `claude-long-model-label-number-${i}`, tokens: { ...zeroTokens(), input: 100 }, usd: zeroSpend() }]));
    r.days = [
      { ...r.days[0], coverage: "untracked", date: "2026-09-01" },
      { ...r.days[0], coverage: "future", date: "2026-09-02" },
    ];
    return r;
  }, 100, 32);
  try {
    await vi.waitFor(() => expect(ui.last()).toContain("API cost"));
    ui.key("m");
    await vi.waitFor(() => expect(ui.last()).toContain("Other"));
    expect(ui.last()).toMatch(/Tu.*\?/);
    expect(ui.last()).toMatch(/We.*·/);
    ui.key("l");
    await vi.waitFor(() => expect(ui.last()).toContain("claude-long-model-label-number-0"));
    ui.key("\u001b[B");
    await vi.waitFor(() => expect(ui.last()).toContain("claude-long-model-label-number-1"));
  } finally { await ui.close(); }
});
it.each([80, 70, 48, 30])("makes all controls discoverable at width %s", async width => {
  const ui = mountUsage(async q => report(q), width, 24);
  try {
    await vi.waitFor(() => expect(ui.last()).toContain("q quit"));
    expect(ui.last()).toContain("? help");
    ui.key("?");
    await vi.waitFor(() => expect(ui.last()).toContain("t  Current period"));
    expect(ui.last()).toContain("m  Model stacks");
    expect(ui.last()).toContain("s  Tokens / spend");
    expect(ui.last()).toContain("i  All / input / output");
    expect(ui.last()).toContain("g  Day focus");
  } finally { await ui.close(); }
});
it("switches chart and grid between tokens and spend and cycles the input/output facet", async () => {
  const ui = mountUsage(async q => report(q), 100, 32);
  try {
    await vi.waitFor(() => expect(ui.last()).toContain("[daily tokens]"));
    expect(ui.last()).toContain("Tokens · All");
    expect(ui.last()).toMatch(/\b1K\s*│/);
    ui.key("s");
    await vi.waitFor(() => expect(ui.last()).toContain("[daily spend]"));
    expect(ui.last()).toContain("Spend · All");
    expect(ui.last()).toMatch(/\$1\.00\s*│/);
    expect(ui.last()).toContain("$1.00 spend");
    ui.key("i");
    await vi.waitFor(() => expect(ui.last()).toContain("Spend · Input"));
    expect(ui.last()).toContain("[daily spend · input]");
    ui.key("i");
    await vi.waitFor(() => expect(ui.last()).toContain("Spend · Output"));
    expect(ui.last()).toContain("$0.00 output spend");
    ui.key("s");
    await vi.waitFor(() => expect(ui.last()).toContain("Tokens · Output"));
    expect(ui.last()).toContain("[daily tokens · output]");
    expect(ui.last()).toContain("0 output tokens");
    ui.key("i");
    await vi.waitFor(() => expect(ui.last()).toContain("Tokens · All"));
    expect(ui.last()).toContain("1,000 tokens");
  } finally { await ui.close(); }
});
it("splits the header spend by category and shows input/output per model in the inspector", async () => {
  const ui = mountUsage(async q => report(q), 100, 32);
  try {
    await vi.waitFor(() => expect(ui.last()).toContain("API cost $1.00"));
    expect(ui.plain()).toMatch(/API cost \$1\.00\s+Input \$1\.00\s+Output \$0\.00/);
    ui.key("l");
    await vi.waitFor(() => expect(ui.last()).toContain("sonnet"));
    expect(ui.plain()).toMatch(/Input 1K\b.*Output 0\b/);
    expect(ui.plain()).toMatch(/Spend \$1\.00/);
  } finally { await ui.close(); }
});
it("places warnings below the grid and lets the layout breathe on tall terminals", async () => {
  const ui = mountUsage(async q => ({ ...report(q), warnings: ["Pricing is incomplete: fixture"] }), 100, 36);
  try {
    await vi.waitFor(() => expect(ui.last()).toContain("Partial: Pricing"));
    const rows = ui.plain().split("\n");
    const warning = rows.findIndex(r => r.includes("Partial: Pricing"));
    const sunday = rows.findIndex(r => r.startsWith("Su"));
    const tabs = rows.findIndex(r => r.includes("Month"));
    const totals = rows.findIndex(r => r.includes("tokens  Input"));
    expect(sunday).toBeGreaterThan(0);
    expect(warning).toBeGreaterThan(sunday);
    // A blank spacer separates the tab strip from the totals when there is room.
    expect(totals - tabs).toBe(2); expect(rows[tabs + 1].trim()).toBe("");
  } finally { await ui.close(); }
});
