import { describe, expect, it } from "vitest";
import { lookupUsageRates, parsePricingOverrides } from "../usage/pricing.js";

describe("usage pricing", () => {
  it("uses exact provider/model matches and separates cache durations", () => {
    const rate = lookupUsageRates("anthropic_subscription", "claude-sonnet-4-6");
    expect(rate).toMatchObject({ input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 });
    expect(lookupUsageRates("openai_subscription", "gpt-5.3-codex")).toMatchObject({ input: 1.75, output: 14, cacheRead: 0.175 });
    expect(lookupUsageRates("openai_subscription", "gpt-5.2-codex", 100)).toMatchObject({ input: 1.75, output: 14 });
    expect(lookupUsageRates("openai_subscription", "gpt-5.5", 100)).toMatchObject({ input: 5, output: 30, cacheRead: 0.5 });
    expect(lookupUsageRates("openai_subscription", "gpt-5.5-2026-04-23", 272_001)).toBeUndefined();
    expect(lookupUsageRates("openai_subscription", "gpt-5.4-2026-03-05", 100)).toMatchObject({ input: 2.5, output: 15 });
    expect(lookupUsageRates("openai_subscription", "gpt-5.3-codex-spark")).toBeUndefined();
    expect(lookupUsageRates("openai_subscription", "claude-sonnet-4-6")).toBeUndefined();
    expect(lookupUsageRates("xai_subscription", "grok-4")).toBeUndefined();
  });
  it("rejects unsupported long-context pricing instead of using the small-context rate", () => {
    expect(lookupUsageRates("openai_subscription", "gpt-5.4", 272_000)?.input).toBe(2.5);
    expect(lookupUsageRates("openai_subscription", "gpt-5.4", 272_001)).toBeUndefined();
    expect(lookupUsageRates("anthropic_subscription", "claude-sonnet-4-5", 200_001)).toBeUndefined();
    expect(lookupUsageRates("openai_subscription", "gpt-6-sol", 272_001)).toBeUndefined();
    expect(lookupUsageRates("openai_subscription", "gpt-6-astra")).toBeUndefined();
  });
  it("prices the Opus 5.5, GPT-6 and GPT-5.6 models the router sees today", () => {
    expect(lookupUsageRates("anthropic_subscription", "claude-opus-5-5")).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 });
    expect(lookupUsageRates("openai_subscription", "gpt-6-astra", 100)).toMatchObject({ input: 10, output: 50, cacheRead: 1 });
    expect(lookupUsageRates("openai_subscription", "gpt-6-sol", 272_000)).toMatchObject({ input: 2, output: 10, cacheRead: 0.2 });
    expect(lookupUsageRates("openai_subscription", "gpt-6-luna", 100)).toMatchObject({ input: 0.1, output: 0.5, cacheRead: 0.01 });
    expect(lookupUsageRates("openai_subscription", "gpt-5.6-sol", 100)).toMatchObject({ input: 4, output: 20, cacheRead: 0.4 });
    expect(lookupUsageRates("openai_subscription", "gpt-5.6-terra", 100)).toMatchObject({ input: 2, output: 12, cacheRead: 0.2 });
    expect(lookupUsageRates("openai_subscription", "gpt-5.6-luna", 100)).toMatchObject({ input: 0.2, output: 1.2, cacheRead: 0.02 });
    expect(lookupUsageRates("openai_subscription", "gpt-5.6-cyber", 900_000)).toMatchObject({ input: 12.5, output: 75, cacheRead: 1.25 });
  });
  it("keeps supported long-context rates and rejects invalid tier context", () => {
    expect(lookupUsageRates("anthropic_subscription", "claude-sonnet-4-6", 900_000)?.input).toBe(3);
    expect(lookupUsageRates("openai_subscription", "gpt-5.2", 300_000)?.input).toBe(1.75);
    for (const context of [undefined, NaN, -1, -Infinity]) {
      expect(lookupUsageRates("openai_subscription", "gpt-5.4", context)).toBeUndefined();
    }
    expect(() => parsePricingOverrides({ version: 1, models: [{ provider: ["openai_subscription"], model: "gpt-5.4", input: 9, output: 20, source: "user", effectiveDate: "2026-09-17" }] })).toThrow();
  });
  it("returns independent immutable historical snapshots", () => {
    const one = lookupUsageRates("openai_subscription", "gpt-5.2")!;
    const two = lookupUsageRates("openai_subscription", "gpt-5.2")!;
    expect(one).not.toBe(two);
    expect(one.source).toMatch(/^https:\/\//);
    expect(one.effectiveDate).toBe("2026-09-16");
  });
  it("validates explicit exact-model overrides without trusting unknown fields", () => {
    const overrides = parsePricingOverrides({ version: 1, models: [{ provider: "xai_subscription", model: "my-model", input: 2, output: 8, source: "user-configured", effectiveDate: "2026-09-17" }] });
    expect(lookupUsageRates("xai_subscription", "my-model", 10, overrides)).toMatchObject({ input: 2, output: 8 });
    for (const value of [-1, Infinity, NaN, "2"]) {
      expect(() => parsePricingOverrides({ version: 1, models: [{ provider: "xai_subscription", model: "x", input: value, output: 1, source: "user", effectiveDate: "2026-09-17" }] })).toThrow();
    }
    expect(() => parsePricingOverrides({ version: 1, models: [{ provider: "openai_subscription", model: "future", input: 1, output: 1, source: "user", effectiveDate: "0000-01-01" }] })).toThrow();
    expect(() => parsePricingOverrides({ version: 2, models: [] })).toThrow();
  });
});
