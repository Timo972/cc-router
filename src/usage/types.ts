/** All timestamps and calendar boundaries are UTC; interval ends are exclusive. */
export type UsageProvider = "anthropic_subscription" | "openai_subscription" | "xai_subscription";
export type UsagePeriod = "day" | "week" | "month" | "year";
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  /** Total cache creation. Duration counts below are subsets, NOT additional tokens. */
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}
/** USD per million tokens. A missing cache rate is unknown, never implicitly zero. */
export interface UsageRates {
  input: number;
  output: number;
  cacheRead?: number;
  /** Applies only to the cacheWrite remainder not assigned a duration. */
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  source: string;
  effectiveDate: string;
}
export interface UsageObservation {
  version: 1;
  attemptId: string;
  revision: number;
  ts: string;
  accountKey: string;
  provider: UsageProvider;
  model: string;
  tokens: TokenCounts;
  rates?: UsageRates;
  complete: boolean;
  /** No further callbacks are expected, even if final token usage is unknown. */
  settled?: true;
}
export interface UsageAccount { key: string; alias: string; provider: UsageProvider; retired?: boolean }
export interface Subscription { accountKey: string; provider: UsageProvider; monthlyUsd: number; from: string; to?: string }
export interface UsageQuery { period: UsagePeriod; date?: string; providers?: UsageProvider[] }
/** Only positive cumulative differences are counted. The attempt's first rates are frozen. */
export interface UsageDelta {
  attemptId: string;
  ts: string;
  accountKey: string;
  provider: UsageProvider;
  model: string;
  tokens: TokenCounts;
  rates?: UsageRates;
}
export interface UsageAggregate {
  start: string;
  end: string;
  accountKey: string;
  provider: UsageProvider;
  model: string;
  tokens: TokenCounts;
  rates?: UsageRates;
}
export interface UsageHealth { status: "ok" | "degraded"; warnings: string[] }
export interface UsageSnapshot {
  version: 1;
  gaps?: UsageGap[];
  trackingSince?: string;
  /** Latest cumulative snapshots not yet compacted; never sum these with deltas. */
  observations: UsageObservation[];
  /** Uncompacted deltas plus compacted hourly aggregates form the accounting ledger. */
  deltas: UsageDelta[];
  aggregates: UsageAggregate[];
  accounts: UsageAccount[];
  subscriptions: Subscription[];
  warnings: string[];
  health: UsageHealth;
}
export interface UsageSeries {
  provider: UsageProvider;
  model: string;
  tokens: TokenCounts;
}
export interface UsageBucket {
  start: string;
  end: string;
  tokens: TokenCounts;
  /** Key is JSON.stringify([provider, model]); values also contain both labels. */
  series: Record<string, UsageSeries>;
}
export interface UsageDay extends UsageBucket {
  date: string;
  selected: boolean;
  coverage: "complete" | "partial" | "untracked" | "future";
}
export interface UsageCoverage {
  pricedTokens: number;
  unpricedTokens: number;
  pricingComplete: boolean;
  configuredAccounts: number;
  unconfiguredAccounts: number;
  subscriptionComplete: boolean;
  trackingComplete: boolean;
  persistenceHealthy: boolean;
}
export interface UsageCosts {
  pricedApiUsd: number;
  subscriptionUsd: number;
  savingsUsd: number | null;
  savingsPercent: number | null;
  coverage: UsageCoverage;
}
export interface UsageReport {
  period: UsagePeriod;
  start: string;
  end: string;
  now: string;
  trackingSince?: string;
  buckets: UsageBucket[];
  /** Complete selected calendar year, including future and untracked dates. */
  days: UsageDay[];
  totals: TokenCounts;
  costs: UsageCosts;
  accounts: UsageAccount[];
  warnings: string[];
}

export const USAGE_PROVIDERS: readonly UsageProvider[] = ["anthropic_subscription", "openai_subscription", "xai_subscription"];
export const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h"] as const;
export function zeroTokens(): TokenCounts { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 }; }
export function totalTokens(tokens: TokenCounts): number { return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite; }
export function addTokens(target: TokenCounts, tokens: TokenCounts): void {
  for (const key of TOKEN_KEYS) {
    const value = target[key] + tokens[key];
    if (!Number.isSafeInteger(value)) throw new Error("Invalid token total: safe integer overflow");
    target[key] = value;
  }
  if (!Number.isSafeInteger(totalTokens(target))) throw new Error("Invalid token total: safe integer overflow");
}
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid usage object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) throw new Error("Invalid usage field");
  return result;
}
export function boundedString(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.length || value.length > max || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
export function usageProvider(value: unknown): UsageProvider {
  if (!USAGE_PROVIDERS.includes(value as UsageProvider)) throw new Error("Invalid usage provider");
  return value as UsageProvider;
}
export function finiteAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9) throw new Error("Invalid USD amount or rate (expected 0..1e9)");
  return value;
}
/** Canonical UTC only: strict date-only or millisecond ISO timestamp. */
export function utcTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(value)) throw new Error("Invalid UTC date");
  const full = value.length === 10 ? `${value}T00:00:00.000Z` : value;
  const ms = Date.parse(full);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== full || +full.slice(0, 4) < 1970) throw new Error("Invalid UTC date");
  return full;
}
export function validateTokens(value: unknown): TokenCounts {
  const input = object(value, TOKEN_KEYS); const result = zeroTokens();
  for (const key of TOKEN_KEYS) {
    const count = input[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid token count: ${key}`);
    result[key] = count;
  }
  if (result.cacheWrite5m + result.cacheWrite1h > result.cacheWrite || !Number.isSafeInteger(totalTokens(result))) throw new Error("Invalid cache subsets or token total");
  return result;
}
export function validateRates(value: unknown): UsageRates | undefined {
  if (value === undefined) return undefined;
  const input = object(value, [...TOKEN_KEYS, "source", "effectiveDate"]);
  const result: UsageRates = { input: finiteAmount(input.input), output: finiteAmount(input.output), source: boundedString(input.source, "rate source", 2048), effectiveDate: utcTimestamp(input.effectiveDate).slice(0, 10) };
  for (const key of ["cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h"] as const) if (input[key] !== undefined) result[key] = finiteAmount(input[key]);
  return result;
}
export function validateAccount(value: unknown): UsageAccount {
  const input = object(value, ["key", "alias", "provider", "retired"]);
  if (input.retired !== undefined && typeof input.retired !== "boolean") throw new Error("Invalid retired account flag");
  return { key: boundedString(input.key, "account key", 128), alias: boundedString(input.alias, "account alias", 128), provider: usageProvider(input.provider), ...(input.retired === undefined ? {} : { retired: input.retired }) };
}
export function validateObservation(value: unknown): UsageObservation {
  const input = object(value, ["version", "attemptId", "revision", "ts", "accountKey", "provider", "model", "tokens", "rates", "complete", "settled"]);
  if (input.version !== 1 || !Number.isSafeInteger(input.revision) || (input.revision as number) < 1 || typeof input.complete !== "boolean") throw new Error("Invalid observation version, revision or completeness");
  if (input.settled !== undefined && input.settled !== true) throw new Error("Invalid settled flag");
  const rates = validateRates(input.rates);
  return { version: 1, attemptId: boundedString(input.attemptId, "attempt ID", 128), revision: input.revision as number, ts: utcTimestamp(input.ts), accountKey: boundedString(input.accountKey, "account key", 128), provider: usageProvider(input.provider), model: boundedString(input.model, "model"), tokens: validateTokens(input.tokens), ...(rates ? { rates } : {}), complete: input.complete, ...(input.settled === true ? { settled: true as const } : {}) };
}

/** A known collection gap; open-ended only while persistence/recovery is unresolved. */
export interface UsageGap { id: string; start: string; end?: string; reason: string; provider?: UsageProvider }
