import { existsSync } from "node:fs";
import { join } from "node:path";
import { UsageStore } from "./store.js";
import { queryRuntimeUsage } from "./runtime.js";
import { utcTimestamp, usageProvider, validateAccount, validateSpend, validateTokens, zeroSpend, type UsageQuery, type UsageReport, type Subscription, type UsageAccount } from "./types.js";

export interface SubscriptionListing { accounts: UsageAccount[]; subscriptions: Subscription[] }
export interface UsageClientOptions {
  baseUrl: string; headers: Record<string, string>; remote: boolean; directory: string;
  fetch?: typeof globalThis.fetch;
  offline?: (query: UsageQuery) => Promise<UsageReport>;
  /** Offline command initialization reconciles configured account aliases without profile data. */
  initializeOffline?: (store: UsageStore) => void;
}
const clean = (value: unknown, max = 256): string => {
  if (typeof value !== "string" || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error("Invalid usage text from server");
  return value;
};
/** Validate a bounded report before untrusted remote labels reach the terminal. */
export function validateUsageReport(value: unknown): UsageReport {
  if (!value || typeof value !== "object") throw new Error("Invalid usage report from server");
  const r = value as UsageReport;
  if (!["day", "week", "month", "year"].includes(r.period)) throw new Error("Invalid usage period from server");
  for (const d of [r.start, r.end, r.now, ...(r.trackingSince ? [r.trackingSince] : [])]) utcTimestamp(d);
  validateTokens(r.totals);
  if (!Array.isArray(r.buckets) || r.buckets.length > 366 || !Array.isArray(r.days) || r.days.length > 366
    || !Array.isArray(r.accounts) || r.accounts.length > 10_000 || !Array.isArray(r.warnings) || r.warnings.length > 100) throw new Error("Invalid usage report size");
  // A router from before per-bucket spend omits `usd`; treat that as zero rather than refusing its history,
  // but flag it so the dashboard shows "unavailable" instead of a false $0.00 split.
  let spendMissing = false;
  const spend = (value: unknown) => { if (value === undefined) { spendMissing = true; return zeroSpend(); } return validateSpend(value); };
  for (const b of [...r.buckets, ...r.days]) {
    utcTimestamp(b.start); utcTimestamp(b.end); validateTokens(b.tokens); b.usd = spend(b.usd);
    if (!b.series || typeof b.series !== "object" || Object.keys(b.series).length > 100) throw new Error("Invalid usage series");
    for (const s of Object.values(b.series)) { usageProvider(s.provider); clean(s.model); validateTokens(s.tokens); s.usd = spend(s.usd); }
  }
  for (const d of r.days) {
    utcTimestamp(d.date);
    if (!["complete", "partial", "untracked", "future"].includes(d.coverage) || typeof d.selected !== "boolean") throw new Error("Invalid day coverage");
  }
  r.accounts.forEach(validateAccount); r.accounts.forEach(a => clean(a.alias, 128)); r.warnings.forEach(w => clean(w, 1024));
  if (!r.costs || !r.costs.coverage) throw new Error("Invalid usage costs");
  for (const amount of [r.costs.pricedApiUsd, r.costs.subscriptionUsd]) if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid usage cost");
  for (const amount of [r.costs.savingsUsd, r.costs.savingsPercent]) if (amount !== null && !Number.isFinite(amount)) throw new Error("Invalid savings");
  for (const key of ["pricingComplete", "subscriptionComplete", "trackingComplete", "persistenceHealthy"] as const) if (typeof r.costs.coverage[key] !== "boolean") throw new Error("Invalid coverage");
  if (spendMissing) { r.spendAvailable = false; r.warnings.push("This router predates per-category spend; restart it (cc-router start) to see input, output and cache costs."); }
  return r;
}

function transportFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; code?: string; cause?: unknown; errors?: unknown[] };
  if (e.name === "TimeoutError") return true;
  if (e.code && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(e.code)) return true;
  if (e.cause && e.cause !== error) return transportFailure(e.cause);
  return Array.isArray(e.errors) && e.errors.length > 0 && e.errors.every(transportFailure);
}
export function createUsageClient(options: UsageClientOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const assertNoPendingTransition = () => {
    if (existsSync(join(options.directory, "account-transition.json"))) throw new Error("Usage account transition needs recovery; restart the router before reading history");
  };
  const readOfflineSnapshot = () => {
    assertNoPendingTransition(); const snapshot = UsageStore.read(options.directory); assertNoPendingTransition(); return snapshot;
  };
  const offline = options.offline ?? (async (query: UsageQuery) => queryRuntimeUsage(readOfflineSnapshot(), query, Date.now()));
  async function request(path: string, init?: RequestInit): Promise<Response | undefined> {
    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl}/cc-router/usage${path}`, {
        ...init, headers: { ...options.headers, ...(init?.body ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      if (options.remote) throw new Error("Cannot connect to the remote router; local history was not used");
      // Only transport-level failures permit offline access, never HTTP/auth/schema failures.
      if (transportFailure(error)) return undefined;
      throw error;
    }
    if (response.status === 404) throw new Error("This router does not support usage history; upgrade the running service");
    if (!response.ok) {
      // Do not print arbitrary remote response bodies into the terminal.
      throw new Error(`Usage request failed (HTTP ${response.status})${response.status === 409 ? ": conflicting subscription history or writer lock" : ""}`);
    }
    return response;
  }
  function mutate<T>(fn: (store: UsageStore) => T): T {
    const store = UsageStore.open(options.directory);
    try { options.initializeOffline?.(store); assertNoPendingTransition(); return fn(store); } finally { store.close(); }
  }
  return {
    async query(query: UsageQuery): Promise<UsageReport> {
      const params = new URLSearchParams({ period: query.period });
      if (query.date) params.set("date", query.date);
      if (query.providers) {
        if (query.providers.length === 0) params.append("provider", "none");
        else query.providers.forEach(provider => params.append("provider", provider));
      }
      const response = await request(`?${params}`);
      return response ? validateUsageReport(await response.json()) : offline(query);
    },
    async subscriptions(): Promise<SubscriptionListing> {
      const response = await request("/subscriptions");
      if (response) {
        const value = await response.json() as SubscriptionListing;
        if (!value || !Array.isArray(value.accounts) || !Array.isArray(value.subscriptions)) throw new Error("Invalid subscription response");
        value.accounts.forEach(validateAccount);
        const { validateSubscriptions } = await import("./subscriptions.js");
        return { accounts: value.accounts, subscriptions: validateSubscriptions(value.subscriptions) };
      }
      const snapshot = readOfflineSnapshot();
      return { accounts: snapshot.accounts, subscriptions: snapshot.subscriptions };
    },
    async setSubscription(account: string, monthlyUsd: number, from: string): Promise<void> {
      const response = await request("/subscriptions", { method: "POST", body: JSON.stringify({ account, monthlyUsd, from }) });
      if (!response) mutate(store => store.setSubscription(account, monthlyUsd, from));
    },
    async endSubscription(account: string, on: string): Promise<void> {
      const response = await request("/subscriptions/end", { method: "POST", body: JSON.stringify({ account, on }) });
      if (!response) mutate(store => store.endSubscription(account, on));
    },
  };
}
