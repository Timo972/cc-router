import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { parseUsageOptions, registerUsage } from "../cli/cmd-usage.js";
import { createUsageClient, validateUsageReport } from "../usage/client.js";
import { zeroSpend, zeroTokens } from "../usage/types.js";

describe("usage command", () => {
  it("validates calendar dates, periods and provider selectors", () => {
    expect(parseUsageOptions({})).toEqual({ period: "month" });
    expect(parseUsageOptions({ period: "day", date: "2024-02-29", provider: ["openai"] })).toEqual({ period: "day", date: "2024-02-29", providers: ["openai_subscription"] });
    for (const options of [{ period: "hour" }, { date: "2023-02-29" }, { date: "2026-02-30" }, { provider: ["bogus"] }]) expect(() => parseUsageOptions(options)).toThrow();
  });
  it("registers usage and subscription set/end/list commands", () => {
    const program = new Command(); registerUsage(program);
    const usage = program.commands.find(c => c.name() === "usage")!;
    expect(usage.options.map(o => o.long)).toEqual(expect.arrayContaining(["--period", "--date", "--provider", "--json"]));
    const sub = usage.commands.find(c => c.name() === "subscription")!;
    expect(sub.commands.map(c => c.name())).toEqual(["set", "end", "list"]);
  });
  it("parses repeated provider flags through Commander", async () => {
    const program = new Command(); registerUsage(program);
    const usage = program.commands.find(c => c.name() === "usage")!;
    usage.action(() => {});
    await program.parseAsync(["usage", "--provider", "claude", "--provider", "openai"], { from: "user" });
    expect(usage.opts().provider).toEqual(["claude", "openai"]);
  });
  it("never falls back to local files in remote mode and distinguishes old servers", async () => {
    const offline = vi.fn();
    const client = createUsageClient({ baseUrl: "https://router.test", headers: { authorization: "Bearer fixture" }, remote: true, directory: "/unused", fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })), offline });
    await expect(client.query({ period: "month" })).rejects.toThrow(/remote/i);
    expect(offline).not.toHaveBeenCalled();
    const old = createUsageClient({ baseUrl: "https://router.test", headers: {}, remote: true, directory: "/unused", fetch: vi.fn().mockResolvedValue(new Response("", { status: 404 })), offline });
    await expect(old.query({ period: "month" })).rejects.toThrow(/upgrade|support/i);
    expect(offline).not.toHaveBeenCalled();
  });
  it("falls back locally on connection failure, never on authentication failure", async () => {
    const offline = vi.fn().mockResolvedValue({ fixture: true });
    const settings = { baseUrl: "http://localhost:3456", headers: {}, remote: false, directory: "/unused", offline };
    const failed = createUsageClient({ ...settings, fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })) });
    expect(await failed.query({ period: "day" })).toEqual({ fixture: true });
    expect(offline).toHaveBeenCalledOnce();
    const denied = createUsageClient({ ...settings, fetch: vi.fn().mockResolvedValue(new Response("", { status: 401 })) });
    await expect(denied.query({ period: "day" })).rejects.toThrow(/401/);
    expect(offline).toHaveBeenCalledOnce();
  });
});

it("rejects invalid local targets/headers without pretending they are offline", async () => {
  for (const target of [
    { baseUrl: "not a URL", headers: {} },
    { baseUrl: "http://127.0.0.1:59999", headers: { authorization: "Bearer bad\nheader" } },
  ]) {
    const offline = vi.fn();
    const api = createUsageClient({ ...target, headers: target.headers as Record<string, string>, remote: false, directory: "/unused", offline });
    await expect(api.query({ period: "month" })).rejects.toThrow();
    expect(offline).not.toHaveBeenCalled();
  }
});

it("keeps unmeasured Grok coverage unknown when reading offline", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { UsageStore } = await import("../usage/store.js");
  const directory = mkdtempSync(join(tmpdir(), "usage-cli-offline-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-01-01")); const store = UsageStore.open(directory);
    try { store.account("xai_subscription", "grok"); store.setSubscription("grok", 0, "2026-01-01"); } finally { store.close(); }
    vi.setSystemTime(new Date("2026-01-03"));
    const api = createUsageClient({ baseUrl: "http://127.0.0.1:59999", headers: {}, remote: false, directory, fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })) });
    const report = await api.query({ period: "day", date: "2026-01-02" });
    expect(report.costs.savingsUsd).toBeNull(); expect(report.warnings.join(" ")).toMatch(/unmeasured/i);
  } finally { vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); }
});

it("refuses read-only offline history while an account transition needs recovery", async () => {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "usage-cli-transition-"));
  const file = join(directory, "account-transition.json"); const pending = '{"version":1}'; writeFileSync(file, pending);
  try {
    const api = createUsageClient({ baseUrl: "http://127.0.0.1:59999", headers: {}, remote: false, directory, fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })) });
    await expect(api.query({ period: "month" })).rejects.toThrow(/transition.*recover/i);
    await expect(api.subscriptions()).rejects.toThrow(/transition.*recover/i);
    expect(readFileSync(file, "utf8")).toBe(pending);
  } finally { rmSync(directory, { recursive: true, force: true }); }

});

it("defaults missing bucket spend from an older router and rejects invalid spend", () => {
  const tokens = zeroTokens(); const start = "2026-09-01T00:00:00.000Z"; const end = "2026-10-01T00:00:00.000Z";
  const report = () => ({ period: "month", start, end, now: "2026-09-17T00:00:00.000Z",
    buckets: [{ start, end, tokens, series: { a: { provider: "anthropic_subscription", model: "sonnet", tokens } } }],
    days: [{ date: "2026-09-01", start, end, tokens, selected: true, coverage: "complete", series: {} }],
    totals: tokens, accounts: [], warnings: [], costs: { pricedApiUsd: 0, subscriptionUsd: 0, savingsUsd: null, savingsPercent: null,
      coverage: { pricedTokens: 0, unpricedTokens: 0, pricingComplete: true, configuredAccounts: 0, unconfiguredAccounts: 0, subscriptionComplete: true, trackingComplete: true, persistenceHealthy: true } } }) as unknown as Record<string, unknown>;
  const validated = validateUsageReport(report());
  expect(validated.buckets[0].usd).toEqual(zeroSpend()); expect(validated.days[0].usd).toEqual(zeroSpend());
  expect(Object.values(validated.buckets[0].series)[0].usd).toEqual(zeroSpend());
  // Zero is a placeholder here, not a measurement: the dashboard must be told so it can say "unavailable".
  expect(validated.spendAvailable).toBe(false);
  expect(validated.warnings.at(-1)).toMatch(/restart/i);
  const current = report(); (current.buckets as Array<Record<string, unknown>>)[0].usd = zeroSpend(); (current.days as Array<Record<string, unknown>>)[0].usd = zeroSpend();
  (((current.buckets as Array<Record<string, unknown>>)[0].series as Record<string, Record<string, unknown>>).a).usd = zeroSpend();
  expect(validateUsageReport(current).spendAvailable).toBeUndefined();
  const negative = report(); (negative.buckets as Array<Record<string, unknown>>)[0].usd = { ...zeroSpend(), input: -1 };
  expect(() => validateUsageReport(negative)).toThrow(/spend/i);
  const nan = report(); ((nan.buckets as Array<Record<string, unknown>>)[0].series as Record<string, Record<string, unknown>>).a.usd = { ...zeroSpend(), output: Number.NaN };
  expect(() => validateUsageReport(nan)).toThrow(/spend/i);
});
