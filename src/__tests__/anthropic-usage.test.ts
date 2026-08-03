import { describe, expect, it } from "vitest";
import {
  canUseExtraUsage,
  normalizeModelFamily,
  parseAnthropicUsage,
} from "../providers/anthropic/usage.js";

const FETCHED_AT = 1_735_689_600_000;

describe("parseAnthropicUsage", () => {
  it("normalizes global and model-scoped limits without retaining raw payload", () => {
    const raw = {
      five_hour: { utilization: 25, resets_at: "2025-01-01T00:00:00.500Z" },
      seven_day: { utilization: 0.5, resets_at: "2025-01-02T00:00:00Z" },
      limits: [{
        kind: "weekly_scoped",
        group: "weekly",
        model_id: "claude-sonnet-4-5",
        model_name: "Claude Sonnet 4.5",
        utilization: 75,
        resets_at: "2025-01-03T00:00:00.250Z",
        active: true,
        severity: "warning",
      }],
    };

    expect(parseAnthropicUsage(raw, FETCHED_AT)).toEqual({
      fiveHour: { utilization: 0.25, resetAt: 1_735_689_600 },
      sevenDay: { utilization: 0.005, resetAt: 1_735_776_000 },
      modelLimits: [{
        kind: "weekly_scoped",
        group: "weekly",
        modelId: "claude-sonnet-4-5",
        modelFamily: "sonnet",
        displayName: "Claude Sonnet 4.5",
        utilization: 0.75,
        resetAt: 1_735_862_400,
        active: true,
        severity: "warning",
      }],
      fetchedAt: FETCHED_AT,
      fetchStatus: "fresh",
    });
  });

  it("supports scoped display names, future names, exhaustion, and legacy scoped fields", () => {
    const parsed = parseAnthropicUsage({
      seven_day_sonnet: { utilization: 100, resets_at: "2025-01-04T00:00:00Z" },
      seven_day_opus: { utilization: 101, resets_at: "invalid" },
      limits: undefined,
    }, FETCHED_AT);

    expect(parsed?.modelLimits).toEqual([
      expect.objectContaining({ modelFamily: "sonnet", utilization: 1, resetAt: 1_735_948_800 }),
      expect.objectContaining({ modelFamily: "opus", utilization: 1, resetAt: 0 }),
    ]);

    const scoped = parseAnthropicUsage({ limits: [
      { kind: "weekly_scoped", group: "weekly", model_id: null, model_name: "Claude Haiku 3.5", utilization: 100 },
      { kind: "weekly_scoped", group: "weekly", model_name: "Claude Nebula Next!", utilization: 10 },
    ] }, FETCHED_AT);
    expect(scoped?.modelLimits).toEqual([
      expect.objectContaining({ modelFamily: "haiku", displayName: "Claude Haiku 3.5", utilization: 1 }),
      expect.objectContaining({ modelFamily: "claude-nebula-next", displayName: "Claude Nebula Next!", utilization: 0.1 }),
    ]);
  });

  it("parses model identity and activity from the current scoped limit shape", () => {
    const parsed = parseAnthropicUsage({
      limits: [{
        kind: "weekly_scoped",
        group: "weekly",
        scope: {
          model: { id: null, display_name: "Fable" },
          surface: null,
        },
        percent: 100,
        resets_at: "2026-08-02T12:00:00.152578+00:00",
        is_active: false,
        severity: "critical",
      }],
    }, FETCHED_AT);

    expect(parsed?.modelLimits).toEqual([{
      kind: "weekly_scoped",
      group: "weekly",
      modelFamily: "fable",
      displayName: "Fable",
      utilization: 1,
      resetAt: 1_785_672_000,
      active: false,
      severity: "critical",
    }]);
  });

  it("tolerates malformed optional fields while rejecting non-object or fieldless responses", () => {
    expect(parseAnthropicUsage(null, FETCHED_AT)).toBeNull();
    expect(parseAnthropicUsage([], FETCHED_AT)).toBeNull();
    expect(parseAnthropicUsage({}, FETCHED_AT)).toBeNull();
    expect(parseAnthropicUsage({ five_hour: { utilization: -5 }, seven_day: { utilization: null } }, FETCHED_AT))
      .toEqual(expect.objectContaining({ fiveHour: { utilization: 0, resetAt: 0 } }));
    expect(parseAnthropicUsage({ five_hour: {} }, FETCHED_AT))
      .toEqual(expect.objectContaining({ fiveHour: { utilization: 0, resetAt: 0 } }));
    expect(parseAnthropicUsage({ five_hour: { utilization: "bad" }, limits: [{ kind: "weekly_scoped", model_name: "Sonnet", utilization: null }] }, FETCHED_AT))
      .toEqual(expect.objectContaining({ modelLimits: [expect.objectContaining({ utilization: 0 })] }));
  });

  it("normalizes enabled and exhausted extra usage", () => {
    expect(parseAnthropicUsage({
      extra_usage: { is_enabled: true, used_credits: 250, monthly_limit: 1_000, currency: "USD" },
    }, FETCHED_AT)?.extraUsage).toEqual({
      enabled: true,
      spendLimitReached: false,
      usedMinor: 250,
      limitMinor: 1_000,
      currency: "USD",
    });
    expect(parseAnthropicUsage({
      extra_usage: { is_enabled: false, spend_limit_reached: true, disabled_reason: "monthly_cap" },
    }, FETCHED_AT)?.extraUsage).toEqual({
      enabled: false,
      spendLimitReached: true,
      disabledReason: "monthly_cap",
    });
  });

  it("normalizes model families", () => {
    expect(normalizeModelFamily(" Claude-Opus-4-6 ")).toBe("opus");
    expect(normalizeModelFamily("Fable Prime")).toBe("fable");
    expect(normalizeModelFamily("New Model !! 2027")).toBe("new-model-2027");
    expect(normalizeModelFamily("   ")).toBeUndefined();
  });
});

describe("canUseExtraUsage", () => {
  it("allows only enabled extra usage with remaining spend and no disabling reason", () => {
    expect(canUseExtraUsage({ enabled: true, spendLimitReached: false })).toBe(true);
    expect(canUseExtraUsage({ enabled: false, spendLimitReached: false })).toBe(false);
    expect(canUseExtraUsage({ enabled: true, spendLimitReached: true })).toBe(false);
    expect(canUseExtraUsage({ enabled: true, spendLimitReached: false, disabledReason: "cap" })).toBe(false);
    expect(canUseExtraUsage(undefined)).toBe(false);
  });
});
