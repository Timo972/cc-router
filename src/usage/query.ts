import { addTokens, object, totalTokens, USAGE_PROVIDERS, utcTimestamp, usageProvider, zeroTokens } from "./types.js";
import type { TokenCounts, UsageBucket, UsageDay, UsageDelta, UsageAggregate, UsageQuery, UsageReport, UsageSnapshot, Subscription } from "./types.js";
import { prorateSubscriptions } from "./subscriptions.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MODEL_LIMIT = 16; // Per provider, including Other. Bounds all chart/heatmap series.
function iso(ms: number): string { return new Date(ms).toISOString(); }
function newBucket(start: number, end: number): UsageBucket { return { start: iso(start), end: iso(end), tokens: zeroTokens(), series: {} }; }
function addToBucket(bucket: UsageBucket, entry: UsageDelta | UsageAggregate, model: string): void {
  addTokens(bucket.tokens, entry.tokens);
  const key = JSON.stringify([entry.provider, model]);
  const series = bucket.series[key] ??= { provider: entry.provider, model, tokens: zeroTokens() };
  addTokens(series.tokens, entry.tokens);
}
function price(entry: UsageDelta | UsageAggregate): { usd: number; priced: number; unpriced: number } {
  const { tokens, rates } = entry;
  const categories: [number, number | undefined][] = [
    [tokens.input, rates?.input], [tokens.output, rates?.output], [tokens.cacheRead, rates?.cacheRead],
    [tokens.cacheWrite - tokens.cacheWrite5m - tokens.cacheWrite1h, rates?.cacheWrite],
    [tokens.cacheWrite5m, rates?.cacheWrite5m], [tokens.cacheWrite1h, rates?.cacheWrite1h],
  ];
  let usd = 0; let priced = 0; let unpriced = 0;
  for (const [count, rate] of categories) {
    if (rate === undefined) unpriced += count;
    else { priced += count; usd += count * rate / 1e6; }
  }
  return { usd, priced, unpriced };
}
function configuredThroughout(entries: Subscription[], start: number, end: number): boolean {
  if (start >= end) return false;
  let cursor = start;
  for (const entry of [...entries].sort((a,b) => a.from.localeCompare(b.from))) {
    const from = Date.parse(entry.from); const to = entry.to ? Date.parse(entry.to) : Infinity;
    if (to <= cursor) continue;
    if (from > cursor) return false;
    cursor = Math.max(cursor, to); if (cursor >= end) return true;
  }
  return false;
}

/** Pure UTC calendar query. Never reprices history against a current catalog. */
export function queryUsage(snapshot: UsageSnapshot, query: UsageQuery, now: Date | string | number): UsageReport {
  object(query, ["period", "date", "providers"]);
  if (!["day", "week", "month", "year"].includes(query.period)) throw new Error("Invalid usage period; expected day, week, month or year");
  if (query.providers !== undefined && (!Array.isArray(query.providers) || query.providers.length > USAGE_PROVIDERS.length)) throw new Error("Invalid provider selection; select at most three providers");
  const providers = new Set((query.providers ?? USAGE_PROVIDERS).map(usageProvider));
  const nowIso = utcTimestamp(typeof now === "string" ? now : new Date(now).toISOString()); const current = Date.parse(nowIso);
  if (query.date !== undefined && (typeof query.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(query.date))) throw new Error("Invalid date; expected YYYY-MM-DD");
  const selected = new Date(utcTimestamp(query.date ?? nowIso.slice(0,10)));
  const year = selected.getUTCFullYear(); const month = selected.getUTCMonth();
  let start = selected.getTime(); let end: number;
  switch (query.period) {
    case "day": end = start + DAY; break;
    case "week": start -= ((selected.getUTCDay() + 6) % 7) * DAY; end = start + 7 * DAY; break;
    case "month": start = Date.UTC(year, month, 1); end = Date.UTC(year, month + 1, 1); break;
    case "year": start = Date.UTC(year, 0, 1); end = Date.UTC(year + 1, 0, 1); break;
  }
  // Bound dates to the persisted timestamp contract, including next-year ends.
  if (year >= 9999 || start < Date.UTC(1970, 0, 1)) throw new Error("Usage period is outside supported UTC years 1970..9998");
  const elapsedEnd = Math.min(end, current);
  const buckets: UsageBucket[] = [];
  for (let cursor = start; cursor < end;) {
    const next = query.period === "year" ? Date.UTC(year, new Date(cursor).getUTCMonth() + 1, 1) : cursor + (query.period === "day" ? HOUR : DAY);
    buckets.push(newBucket(cursor, next)); cursor = next;
  }
  const tracking = snapshot.trackingSince ? Date.parse(utcTimestamp(snapshot.trackingSince)) : Infinity;
  const persistenceHealthy = snapshot.health.status === "ok";
  const gaps = (snapshot.gaps ?? []).filter(gap => !gap.provider || providers.has(gap.provider));
  const intersectsGap = (from: number, to: number) => gaps.some(gap => Date.parse(gap.start) < to && (gap.end ? Date.parse(gap.end) : Infinity) > from);
  const days: UsageDay[] = [];
  const yearStart = Date.UTC(year, 0, 1); const yearEnd = Date.UTC(year + 1, 0, 1);
  for (let cursor = yearStart; cursor < yearEnd; cursor += DAY) {
    const next = cursor + DAY;
    const coverage = cursor >= current ? "future" : tracking >= Math.min(next, current) ? "untracked" : cursor < tracking || next > current || intersectsGap(cursor, Math.min(next, current)) || !persistenceHealthy ? "partial" : "complete";
    days.push({ ...newBucket(cursor, next), date: iso(cursor).slice(0,10), selected: cursor < end && next > start, coverage });
  }
  const totals: TokenCounts = zeroTokens();
  let pricedApiUsd = 0; let pricedTokens = 0; let unpricedTokens = 0;
  const incompleteAttempts = new Set(snapshot.observations.filter(entry => !entry.complete).map(entry => entry.attemptId));
  let incompleteInPeriod = false;
  const observedAccounts = new Set<string>(); const models = new Map<string, Set<string>>(); let overflowModels = false;
  for (const entry of [...snapshot.aggregates, ...snapshot.deltas]) {
    if (!providers.has(entry.provider)) continue;
    const ts = Date.parse("ts" in entry ? entry.ts : entry.start);
    if (ts >= current || (ts < start || ts >= end) && (ts < yearStart || ts >= yearEnd)) continue;
    const knownModels = models.get(entry.provider) ?? new Set<string>(); models.set(entry.provider, knownModels);
    let model = entry.model;
    if (!knownModels.has(model) && model !== "Other") {
      if (knownModels.size < MODEL_LIMIT - 1) knownModels.add(model);
      else { model = "Other"; overflowModels = true; }
    }
    const incomplete = "attemptId" in entry && incompleteAttempts.has(entry.attemptId);
    if (ts >= yearStart && ts < yearEnd) {
      const day = days[Math.floor((ts - yearStart) / DAY)]; addToBucket(day, entry, model);
      if (incomplete && day.coverage === "complete") day.coverage = "partial";
    }
    if (ts < start || ts >= elapsedEnd) continue;
    if (incomplete) incompleteInPeriod = true;
    observedAccounts.add(entry.accountKey); addTokens(totals, entry.tokens);
    const cost = price(entry); pricedApiUsd += cost.usd; pricedTokens += cost.priced; unpricedTokens += cost.unpriced;
    const bucket = buckets.find(candidate => candidate.start <= iso(ts) && candidate.end > iso(ts));
    if (bucket) addToBucket(bucket, entry, model);
  }
  const subscriptions = snapshot.subscriptions.filter(entry => providers.has(entry.provider));
  const overlappingSubscriptions = subscriptions.filter(entry => Date.parse(entry.from) < elapsedEnd && (!entry.to || Date.parse(entry.to) > start));
  const subscribedAccounts = new Set(overlappingSubscriptions.map(entry => entry.accountKey));
  const accounts = snapshot.accounts.filter(entry => providers.has(entry.provider) && (!entry.retired || observedAccounts.has(entry.key) || subscribedAccounts.has(entry.key)));
  let configuredAccounts = 0; let unconfiguredAccounts = 0;
  for (const account of accounts) {
    if (configuredThroughout(subscriptions.filter(entry => entry.accountKey === account.key), start, elapsedEnd)) configuredAccounts++;
    else unconfiguredAccounts++;
  }
  const subscriptionUsd = prorateSubscriptions(subscriptions, iso(start), iso(end), nowIso);
  const pricingComplete = unpricedTokens === 0;
  const subscriptionComplete = unconfiguredAccounts === 0;
  const gapInPeriod = intersectsGap(start, elapsedEnd);
  const trackingComplete = providers.size === 0 || tracking <= start && start < elapsedEnd && !gapInPeriod && !incompleteInPeriod;
  const complete = pricingComplete && subscriptionComplete && trackingComplete && persistenceHealthy;
  const savingsUsd = complete ? pricedApiUsd - subscriptionUsd : null;
  const warnings = [...new Set([...snapshot.warnings, ...snapshot.health.warnings])];
  if (!pricingComplete) warnings.push("Pricing is incomplete: tokens with missing frozen rates are excluded from the priced subtotal.");
  if (!subscriptionComplete) warnings.push("Subscription coverage is incomplete: some account intervals have no configured cost.");
  if (incompleteInPeriod) warnings.push("Some attempts have only incomplete usage observations; observed tokens are retained but final usage is unknown.");
  if (!trackingComplete && !incompleteInPeriod) warnings.push(gapInPeriod ? "The selected period intersects a known collection gap; usage is incomplete." : "Tracking does not cover the full elapsed period; earlier usage is unavailable, not zero.");
  if (!persistenceHealthy && !warnings.length) warnings.push("Usage persistence is degraded; history may be incomplete.");
  if (overflowModels) warnings.push("Overflow models are grouped as Other; token and cost totals are unchanged.");
  return {
    period: query.period, start: iso(start), end: iso(end), now: nowIso, ...(snapshot.trackingSince ? { trackingSince: snapshot.trackingSince } : {}),
    buckets, days, totals, costs: { pricedApiUsd, subscriptionUsd, savingsUsd, savingsPercent: savingsUsd === null || pricedApiUsd === 0 ? null : 100 * savingsUsd / pricedApiUsd,
      coverage: { pricedTokens, unpricedTokens, pricingComplete, configuredAccounts, unconfiguredAccounts, subscriptionComplete, trackingComplete, persistenceHealthy } },
    accounts: structuredClone(accounts), warnings,
  };
}
