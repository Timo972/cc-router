import { InvalidArgumentError, type Command } from "commander";
import { USAGE_DIR, PROXY_PORT } from "../config/paths.js";
import { readAccountsRaw, readConfig } from "../config/manager.js";
import { resolveStatusTarget } from "./cmd-status.js";
import { createUsageClient } from "../usage/client.js";
import { recoverAccountTransition, reconcileUsageAccounts, type AccountAlias } from "../usage/account-lifecycle.js";
import { totalTokens, utcTimestamp, usageProvider, type UsagePeriod, type UsageProvider, type UsageQuery, type UsageReport } from "../usage/types.js";

interface UsageOptions { period?: string; date?: string; provider?: string[]; json?: boolean; port?: string }
const aliases: Record<string, UsageProvider> = { claude: "anthropic_subscription", anthropic: "anthropic_subscription", openai: "openai_subscription", grok: "xai_subscription", xai: "xai_subscription" };
export function parseUsageOptions(options: UsageOptions): UsageQuery {
  const period = options.period ?? "month";
  if (!["day", "week", "month", "year"].includes(period)) throw new InvalidArgumentError("Period must be day, week, month or year");
  if (options.date) { if (!/^\d{4}-\d\d-\d\d$/.test(options.date)) throw new InvalidArgumentError("Date must be YYYY-MM-DD (UTC)"); utcTimestamp(options.date); }
  const providers = options.provider?.map(p => usageProvider(aliases[p] ?? p));
  return { period: period as UsagePeriod, ...(options.date ? { date: options.date } : {}), ...(providers ? { providers: [...new Set(providers)] } : {}) };
}
function client(portText?: string) {
  const port = Number(portText ?? PROXY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InvalidArgumentError("Port must be 1..65535");
  const target = resolveStatusTarget(port);
  return createUsageClient({ baseUrl: target.baseUrl, headers: target.headers, remote: Boolean(readConfig().client), directory: USAGE_DIR,
    initializeOffline: store => {
      const aliases: AccountAlias[] = [];
      for (const raw of readAccountsRaw()) {
        if (!raw || typeof raw !== "object") continue;
        const record = raw as Record<string, unknown>;
        if (typeof record.id !== "string") continue;
        const provider = record.provider ?? "anthropic_subscription";
        if (typeof provider === "string" && ["anthropic_subscription", "openai_subscription", "xai_subscription"].includes(provider)) aliases.push({ id: record.id, provider: provider as UsageProvider });
      }
      recoverAccountTransition(store, USAGE_DIR, aliases);
      reconcileUsageAccounts(store, aliases);
    },
  });
}
export function formatUsageText(report: UsageReport): string {
  const { totals: t, costs: c } = report;
  const money = (n: number | null) => n === null ? "unavailable" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
  return [
    `Usage ${report.period}: ${report.start.slice(0, 10)} — ${report.end.slice(0, 10)} (UTC, end exclusive)`,
    `Tokens: ${totalTokens(t).toLocaleString("en-US")} | input ${t.input} | output ${t.output} | cache read ${t.cacheRead} | cache write ${t.cacheWrite}`,
    `API equivalent: ${money(c.pricedApiUsd)}${c.coverage.pricingComplete ? "" : " (partial; unpriced tokens excluded)"}`,
    `Subscription: ${money(c.subscriptionUsd)}${c.coverage.subscriptionComplete ? "" : " (partial; configure missing costs)"}`,
    `Net savings: ${money(c.savingsUsd)}${c.savingsPercent === null ? "" : ` (${c.savingsPercent.toFixed(1)}%)`}`,
    ...report.warnings.map(w => `Warning: ${w}`),
  ].join("\n");
}
export function registerUsage(program: Command): void {
  const usage = program.command("usage").description("Persistent token usage and API-equivalent subscription savings")
    .option("--period <period>", "day, week, month or year", "month")
    .option("--date <date>", "Date within the selected period (YYYY-MM-DD, UTC)")
    .option("--provider <provider>", "Filter Claude, OpenAI or Grok (repeatable)", (value: string, previous: string[] = []) => [...previous, value])
    .option("--port <port>", "Proxy port", String(PROXY_PORT))
    .option("--json", "Output JSON without initializing the terminal UI")
    .action(async (options: UsageOptions) => {
      try {
        const query = parseUsageOptions(options); const api = client(options.port);
        if (options.json || !process.stdout.isTTY || !process.stdin.isTTY) {
          const report = await api.query(query);
          console.log(options.json ? JSON.stringify(report, null, 2) : formatUsageText(report)); return;
        }
        const [{ render }, { createElement }, { UsageDashboard }] = await Promise.all([import("ink"), import("react"), import("../ui/UsageDashboard.js")]);
        const instance = render(createElement(UsageDashboard, { load: api.query, initialQuery: query }), { exitOnCtrlC: true });
        try { await instance.waitUntilExit(); } finally { if (process.stdin.isTTY) process.stdin.setRawMode(false); }
      } catch (error) { program.error(error instanceof Error ? error.message : "Usage query failed"); }
    });
  const subscriptions = usage.command("subscription").description("Configure effective-dated monthly USD subscription costs");
  const guarded = (command: Command, action: (...args: any[]) => Promise<void>) => command.action(async (...args: any[]) => {
    try { await action(...args); } catch (error) { program.error(error instanceof Error ? error.message : "Subscription update failed"); }
  });
  const set = subscriptions.command("set <account>").description("Start a monthly USD rate; closes the previous open interval")
    .requiredOption("--monthly-usd <amount>", "Monthly subscription cost in USD")
    .requiredOption("--from <date>", "Effective date, YYYY-MM-DD (UTC)");
  guarded(set, async (account: string, opts: { monthlyUsd: string; from: string }) => {
    if (!/^\d+(?:\.\d+)?$/.test(opts.monthlyUsd) || !Number.isFinite(Number(opts.monthlyUsd))) throw new InvalidArgumentError("Monthly USD must be a finite nonnegative amount");
    parseUsageOptions({ date: opts.from });
    await client(usage.opts().port).setSubscription(account, Number(opts.monthlyUsd), opts.from);
    console.log(`Subscription cost saved for ${account}.`);
  });
  const end = subscriptions.command("end <account>").description("End a subscription cost interval")
    .requiredOption("--on <date>", "Exclusive end date, YYYY-MM-DD (UTC)");
  guarded(end, async (account: string, opts: { on: string }) => { parseUsageOptions({ date: opts.on }); await client(usage.opts().port).endSubscription(account, opts.on); console.log(`Subscription interval ended for ${account}.`); });
  const list = subscriptions.command("list").description("List historical subscription costs").option("--json", "Output JSON");
  guarded(list, async (opts: { json?: boolean }) => {
    const result = await client(usage.opts().port).subscriptions();
    if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
    if (!result.subscriptions.length) { console.log("No subscription costs configured. Use: cc-router usage subscription set <account> --monthly-usd <amount> --from YYYY-MM-DD"); return; }
    for (const sub of result.subscriptions) {
      const account = result.accounts.find(a => a.key === sub.accountKey);
      console.log(`${account?.alias ?? sub.accountKey}${account?.retired ? " (retired)" : ""} | $${sub.monthlyUsd.toFixed(2)}/month | ${sub.from.slice(0, 10)} → ${sub.to?.slice(0, 10) ?? "ongoing"} | ${sub.accountKey}`);
    }
  });
}
