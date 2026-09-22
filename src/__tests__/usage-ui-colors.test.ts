// Chalk decides colour support when it is imported, and the shared UI tests run without colour so
// their substring assertions stay simple. This file forces truecolour before anything loads.
vi.hoisted(() => { process.env.FORCE_COLOR = "3"; });
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { expect, it, vi } from "vitest";
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
function mountUsage(load: (query: UsageQuery) => Promise<UsageReport>, columns: number, rows: number) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  const stdout = Object.assign(new PassThrough(), { columns, rows });
  const frames: string[] = []; stdout.on("data", b => frames.push(String(b)));
  const instance = render(React.createElement(UsageDashboard, { load, initialQuery: { period: "month" } }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  const exited = instance.waitUntilExit();
  const plain = () => (frames.at(-1) ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  return { last: () => frames.at(-1) ?? "", plain, key: (s: string) => stdin.push(s), close: async () => { instance.unmount(); await exited; } };
}
it("colors the input, output and cache figures consistently across the header lines", async () => {
  const ui = mountUsage(async q => report(q), 100, 32);
  try {
    await vi.waitFor(() => expect(ui.plain()).toContain("API cost $1.00"));
    const colored = (label: string) => ui.last().match(new RegExp(`\\u001b\\[38;2;(\\d+;\\d+;\\d+)m${label}`, "g"))?.map(m => m.replace(new RegExp(`m${label}$`), "")) ?? [];
    // The same colour opens "Input" on the token line, the cost line and the mode indicator.
    for (const label of ["Input", "Output", "Cache"]) { const hits = colored(label); expect(hits.length, label).toBeGreaterThanOrEqual(2); expect(new Set(hits).size, label).toBe(1); }
    expect(new Set([...colored("Input"), ...colored("Output"), ...colored("Cache")]).size).toBe(3);
  } finally { await ui.close(); }
});
