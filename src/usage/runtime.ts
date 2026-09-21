import { recoverAccountTransition, reconcileUsageAccounts, registerUsageWriter } from "./account-lifecycle.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { UsageStore } from "./store.js";
import { queryUsage } from "./query.js";
import { lookupUsageRates, readPricingOverrides, type PricingOverride } from "./pricing.js";
import { observeEntryUsage, type LogEntry, type UsageCaptureEvent } from "../proxy/stats.js";
import { zeroTokens, validateTokens, TOKEN_KEYS, type UsageProvider, type UsageQuery, type UsageSnapshot, type UsageRates } from "./types.js";

export interface ConfiguredUsageAccount { id: string; provider?: UsageProvider }
export class UsageUnavailableError extends Error { constructor() { super("Usage history unavailable; check storage and writer ownership"); } }
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const validModel = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(v);

export function startUsageRuntime(directory: string, accounts: readonly ConfiguredUsageAccount[], options: { compactIntervalMs?: number; unmeasuredProviders?: UsageProvider[] } = {}) {
  let store: UsageStore | undefined;
  let unregister: (() => void) | undefined;
  let closed = false;
  let failed = false;
  let overrides: PricingOverride[] = [];
  let pricingInvalid = false;
  const active = new Set<() => void>();
  const warnings = new Set<string>();
  const unmeasured = new Set<UsageProvider>(["xai_subscription", ...options.unmeasuredProviders ?? []]);
  try {
    store = UsageStore.open(directory);
    recoverAccountTransition(store, directory, accounts);
    reconcileUsageAccounts(store, accounts);
    unregister = registerUsageWriter(directory, store, () => { failed = true; });
  } catch {
    // Initialization may fail after UsageStore.open() has claimed the journal
    // and before the runtime becomes usable. Do not leave that partial owner
    // alive: the server continues booting with a failed runtime, and later
    // account mutations must still be able to recover/open the store.
    try { unregister?.(); } finally {
      unregister = undefined;
      try { store?.close(); } catch { /* preserve the original init failure */ }
      store = undefined;
    }
    failed = true;
  }
  try { overrides = readPricingOverrides(join(directory, "pricing.json")); }
  catch { pricingInvalid = true; warnings.add("Invalid pricing overrides: observations remain unpriced until restart with valid configuration."); }
  const available = (): UsageStore => { if (!store || closed || failed) throw new UsageUnavailableError(); return store; };
  const passive = (fn: () => void) => { if (closed || failed || !store) return; try { fn(); } catch {
    if (store.snapshot().health.status === "degraded") failed = true;
    else warnings.add("A usage observation was rejected; affected attempts remain incomplete.");
  } };
  const timer = setInterval(() => passive(() => store!.compact()), options.compactIntervalMs ?? 5 * 60_000);
  timer.unref?.();
  return {
    bind(entry: LogEntry, provider: UsageProvider): void {
      if (provider === "xai_subscription") return;
      const unmeasuredAttempt = unmeasured.has(provider);
      passive(() => {
        const accountKey = store!.account(provider, entry.accountId).key;
        const attemptId = randomUUID();
        const attemptTs = new Date(entry.ts).toISOString();
        let tokens = zeroTokens(); let inputKnown = false; let outputKnown = false;
        let model = unmeasuredAttempt ? "unmeasured" : "unknown"; let revision = 0; let rates: UsageRates | undefined;
        let done = false; let rawCodex = false; let previous = "";
        let invalid = false; let lastTokens = zeroTokens();
        const persist = (complete: boolean, settled = false) => {
          try {
            validateTokens(tokens);
            if (TOKEN_KEYS.some(key => tokens[key] < lastTokens[key]) || tokens.cacheWrite - tokens.cacheWrite5m - tokens.cacheWrite1h < lastTokens.cacheWrite - lastTokens.cacheWrite5m - lastTokens.cacheWrite1h) throw new Error("Non-cumulative usage");
          } catch { tokens = { ...lastTokens }; invalid = true; }
          complete = complete && !invalid;
          const fingerprint = JSON.stringify([tokens, complete, settled]);
          if (previous === fingerprint) return;
          if (revision === 0) rates = pricingInvalid || unmeasuredAttempt ? undefined : lookupUsageRates(provider, model, inputKnown ? tokens.input + tokens.cacheRead + tokens.cacheWrite : undefined, overrides);
          store!.observe({ version: 1, attemptId, revision: revision + 1, ts: attemptTs, accountKey, provider, model, tokens, rates, complete, ...(settled ? { settled: true as const } : {}) });
          revision++; lastTokens = { ...tokens }; previous = fingerprint;
        };
        const stop = () => { passive(() => { persist(false, true); done = true; }); active.delete(stop); };
        active.add(stop);
        observeEntryUsage(entry, (event: UsageCaptureEvent) => {
          if (done) return;
          if (event.kind === "discard" || event.kind === "finish") {
            // Even unavailable storage must not retain released request closures.
            // Never erase observed tokens if a caller mistakenly discards after usage.
            if (event.kind === "finish" || revision > 0) passive(() => persist(event.kind === "finish" && event.complete && inputKnown && outputKnown && !unmeasuredAttempt, true));
            done = true; active.delete(stop); return;
          }
          passive(() => {
            if (unmeasuredAttempt) return;
            if (event.kind === "model") { if (revision === 0 && validModel(event.model)) model = event.model; return; }
            if (event.kind === "codex-response") {
              rawCodex = true;
              const body = record(event.body); if (!body) return;
              if (revision === 0 && validModel(body.model)) model = body.model;
              const usage = record(body.usage); if (!usage) return;
              const input = usage.input_tokens; const output = usage.output_tokens;
              const cached = record(usage.input_tokens_details)?.cached_tokens ?? 0;
              if (count(input) && count(cached) && cached <= input) { tokens.input = input - cached; tokens.cacheRead = cached; inputKnown = true; }
              else if (input !== undefined || record(usage.input_tokens_details)?.cached_tokens !== undefined) invalid = true;
              if (count(output)) { tokens.output = output; outputKnown = true; }
              else if (output !== undefined) invalid = true;
            } else if (event.kind === "codex") {
              if (rawCodex) return;
              const u = event.usage;
              if (!count(u.inputTokens) || !count(u.cachedInputTokens) || u.cachedInputTokens > u.inputTokens || !count(u.outputTokens)) { invalid = true; return; }
              tokens.input = u.inputTokens - u.cachedInputTokens; tokens.cacheRead = u.cachedInputTokens; tokens.output = u.outputTokens;
              inputKnown = outputKnown = true;
            } else if (event.kind === "input" || event.kind === "output") {
              const u = event.usage;
              const next = { ...tokens };
              const fields = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens,
                cacheWrite: u.cache_creation_input_tokens, cacheWrite5m: u.cache_creation?.ephemeral_5m_input_tokens,
                cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens };
              for (const key of TOKEN_KEYS) {
                const value = fields[key];
                if (value === undefined) continue;
                if (count(value)) next[key] = value;
                else invalid = true;
              }
              try { validateTokens(next); } catch { invalid = true; return; }
              tokens = next;
              inputKnown ||= count(u.input_tokens); outputKnown ||= count(u.output_tokens);
            }
            if (inputKnown || outputKnown) persist(false);
          });
        });
      });
    },
    snapshot(): UsageSnapshot {
      const snapshot = available().snapshot(); snapshot.warnings = [...snapshot.warnings, ...warnings]; return snapshot;
    },
    report(query: UsageQuery) { return queryRuntimeUsage(this.snapshot(), query, Date.now(), [...unmeasured]); },
    rename(provider: UsageProvider, oldAlias: string, newAlias: string) { return available().rename(provider, oldAlias, newAlias); },
    retire(provider: UsageProvider, alias: string) { return available().retire(provider, alias); },
    setSubscription(account: string, amount: number, from: string) { return available().setSubscription(account, amount, from); },
    endSubscription(account: string, on: string) { return available().endSubscription(account, on); },
    close(): void { if (closed) return; for (const stop of active) stop(); closed = true; clearInterval(timer); unregister?.(); try { store?.close(); } catch { /* core retains uncertainty markers */ } },
  };
}
export type UsageRuntime = ReturnType<typeof startUsageRuntime>;

/** Runtime/offline presentation guard: overview-only accounts are not measured $0 usage. */
export function queryRuntimeUsage(snapshot: UsageSnapshot, query: UsageQuery, now: Date | string | number, unmeasuredProviders: readonly UsageProvider[] = ["xai_subscription"]) {
  const report = queryUsage(snapshot, query, now);
  const selected = unmeasuredProviders.filter(provider => report.accounts.some(account => account.provider === provider));
  if (selected.length) {
    report.costs.coverage.pricingComplete = false;
    report.costs.coverage.trackingComplete = false;
    report.costs.savingsUsd = null; report.costs.savingsPercent = null;
    report.warnings.push(...selected.map(provider => provider === "xai_subscription"
      ? "Grok/xAI is overview-only and unmeasured; API-equivalent savings are unavailable."
      : "LiteLLM passthrough is unmeasured subscription usage; API-equivalent savings are unavailable."));
    for (const day of report.days) if (day.coverage === "complete") day.coverage = "partial";
  }
  return report;
}
