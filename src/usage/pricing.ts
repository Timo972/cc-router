import { readFileSync } from "node:fs";
import { utcTimestamp } from "./types.js";
import type { UsageProvider, UsageRates } from "./types.js";

/** Standard text-token API equivalent, not an invoice (tools/tax/fast mode excluded).
 * Verified against these official pages on 2026-09-16. Never prefix-match models.
 * Unknown cache-write duration stays unpriced unless the user supplies a rate. */
const VERIFIED = "2026-09-16";
/** Opus 5.5 and the GPT-6 / GPT-5.6 families, verified against the same pages. */
const VERIFIED_2026_09_24 = "2026-09-24";
const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI = "https://developers.openai.com/api/docs/pricing";
export interface PricingOverride extends UsageRates { provider: UsageProvider; model: string }

const claude = (model: string, input: number, output: number, cacheRead = input / 10, effectiveDate = VERIFIED): PricingOverride => ({
  provider: "anthropic_subscription", model, input, output, cacheRead,
  cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, source: ANTHROPIC, effectiveDate,
});
const codex = (model: string, input: number, output: number, source = OPENAI, effectiveDate = VERIFIED): PricingOverride => ({
  provider: "openai_subscription", model, input, output, cacheRead: input / 10, source, effectiveDate,
});
const modelPage = (model: string) => `https://developers.openai.com/api/docs/models/${model}`;
/** Short-context (<=272K input) rates; longer prompts stay unpriced, see LONG_CONTEXT_272K. */
const GPT_6_AND_5_6: ReadonlyArray<[string, number, number]> = [
  ["gpt-6-astra", 10, 50], ["gpt-6-sol", 2, 10], ["gpt-6-luna", 0.1, 0.5],
  ["gpt-5.6-sol", 4, 20], ["gpt-5.6-terra", 2, 12], ["gpt-5.6-luna", 0.2, 1.2],
];
const LONG_CONTEXT_272K = new Set(["gpt-5.4", "gpt-5.4-2026-03-05", "gpt-5.5", "gpt-5.5-2026-04-23", ...GPT_6_AND_5_6.map(([model]) => model)]);
const CATALOG: readonly PricingOverride[] = [
  claude("claude-opus-5-5", 4, 20, 0.2, VERIFIED_2026_09_24),
  ...["claude-fable-5-1", "claude-mythos-5-1"].map(model => claude(model, 10, 50, 0.25)),
  ...["claude-fable-5", "claude-mythos-5"].map(model => claude(model, 10, 50)),
  ...["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-opus-4-5-20251101"].map(model => claude(model, 5, 25)),
  claude("claude-sonnet-5", 2, 10),
  ...["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929"].map(model => claude(model, 3, 15)),
  ...["claude-haiku-4-5", "claude-haiku-4-5-20251001"].map(model => claude(model, 1, 5)),
  codex("gpt-5", 1.25, 10, "https://developers.openai.com/api/docs/models/gpt-5"),
  codex("gpt-5.1-codex", 1.25, 10, "https://developers.openai.com/api/docs/models/gpt-5.1-codex"),
  codex("gpt-5.2", 1.75, 14, "https://developers.openai.com/api/docs/models/gpt-5.2"),
  codex("gpt-5.2-codex", 1.75, 14, "https://developers.openai.com/api/docs/models/gpt-5.2-codex"),
  codex("gpt-5.3-codex", 1.75, 14),
  ...["gpt-5.5", "gpt-5.5-2026-04-23"].map(model => codex(model, 5, 30, "https://developers.openai.com/api/docs/models/gpt-5.5")),
  ...["gpt-5.4", "gpt-5.4-2026-03-05"].map(model => codex(model, 2.5, 15, "https://developers.openai.com/api/docs/models/gpt-5.4")),
  ...GPT_6_AND_5_6.map(([model, input, output]) => codex(model, input, output, modelPage(model), VERIFIED_2026_09_24)),
  codex("gpt-5.6-cyber", 12.5, 75, OPENAI, VERIFIED_2026_09_24),
];

export function lookupUsageRates(
  provider: UsageProvider, model: string, inputContext: number | undefined = undefined, overrides: readonly PricingOverride[] = [],
): UsageRates | undefined {
  const override = overrides.find(rate => rate.provider === provider && rate.model === model);
  const rate = override ?? CATALOG.find(rate => rate.provider === provider && rate.model === model);
  if (!rate) return undefined;
  // Never use short-context rates for a prompt that might have tiered pricing.
  const threshold = provider === "openai_subscription" && LONG_CONTEXT_272K.has(model) ? 272_000
    : provider === "anthropic_subscription" && ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"].includes(model) ? 200_000 : undefined;
  if (inputContext !== undefined && (!Number.isSafeInteger(inputContext) || inputContext < 0)) return undefined;
  if (!override && threshold !== undefined && (inputContext === undefined || inputContext > threshold)) return undefined;
  const { provider: _provider, model: _model, ...snapshot } = rate;
  return Object.freeze(snapshot);
}

export function parsePricingOverrides(raw: unknown): PricingOverride[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid pricing configuration");
  const data = raw as Record<string, unknown>;
  if (data.version !== 1 || !Array.isArray(data.models) || data.models.length > 500) throw new Error("Pricing requires version 1 and up to 500 models");
  const seen = new Set<string>();
  return data.models.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid model price");
    const row = item as Record<string, unknown>;
    if (typeof row.provider !== "string" || !["anthropic_subscription", "openai_subscription", "xai_subscription"].includes(row.provider)) throw new Error("Invalid pricing provider");
    if (typeof row.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(row.model)) throw new Error("Invalid pricing model");
    if (typeof row.source !== "string" || row.source.length < 1 || row.source.length > 256 || /[\p{Cc}\p{Cf}]/u.test(row.source)) throw new Error("Invalid price source");
    if (typeof row.effectiveDate !== "string" || !/^\d{4}-\d\d-\d\d$/.test(row.effectiveDate)
      || utcTimestamp(row.effectiveDate).slice(0, 10) !== row.effectiveDate) throw new Error("Invalid price effectiveDate");
    const key = `${row.provider}:${row.model}`;
    if (seen.has(key)) throw new Error("Duplicate model price");
    seen.add(key);
    const result: Record<string, unknown> = { provider: row.provider, model: row.model, source: row.source, effectiveDate: row.effectiveDate };
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h"] as const) {
      const value = row[field];
      if (value === undefined && field !== "input" && field !== "output") continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) throw new Error(`Invalid ${field} rate`);
      result[field] = value;
    }
    return result as unknown as PricingOverride;
  });
}

/** A missing override file is normal. Malformed overrides are surfaced by the caller. */
export function readPricingOverrides(path: string): PricingOverride[] {
  try { return parsePricingOverrides(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
