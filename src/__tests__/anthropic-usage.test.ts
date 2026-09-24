import { describe, expect, it } from "vitest";
import {
  canUseExtraUsage,
  normalizeModelFamily,
  parseAnthropicUsage,
  parseLimitResets,
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
    // A figure the provider actually sent is kept, clamped into range.
    expect(parseAnthropicUsage({ five_hour: { utilization: -5 } }, FETCHED_AT))
      .toEqual(expect.objectContaining({ fiveHour: { utilization: 0, resetAt: 0 } }));
  });

  it("leaves utilization unreported rather than defaulting it to zero", () => {
    // A window with no usable figure must not read as 0% headroom: callers
    // that release a cooldown on reported headroom would take missing data as
    // proof of capacity and unbench an account that is still being limited.
    const windowOf = (payload: unknown) =>
      parseAnthropicUsage(payload as never, FETCHED_AT)?.fiveHour;

    expect(windowOf({ five_hour: {} })).toEqual({ resetAt: 0 });
    expect(windowOf({ five_hour: {} })).not.toHaveProperty("utilization");
    expect(windowOf({ five_hour: { utilization: "bad" } })).not.toHaveProperty("utilization");
    expect(windowOf({ five_hour: { utilization: null } })).not.toHaveProperty("utilization");
    // A real zero is still a real zero.
    expect(windowOf({ five_hour: { utilization: 0 } })).toEqual({ utilization: 0, resetAt: 0 });

    const modelLimit = parseAnthropicUsage(
      { limits: [{ kind: "weekly_scoped", model_name: "Sonnet", utilization: null }] } as never,
      FETCHED_AT,
    )?.modelLimits[0];
    expect(modelLimit).toBeDefined();
    expect(modelLimit).not.toHaveProperty("utilization");
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

describe("parseLimitResets (cedar_ember)", () => {
  const grant = {
    id: "opus55-launch-promax-20260921", label: "launch", resets_total: 1, resets_left: 1,
    starts_at: "2026-09-22T16:00:00+00:00", ends_at: "2026-10-22T16:00:00+00:00",
    clears: ["five_hour", "seven_day", "seven_day_overage_included"],
    paused: false, usable_now: true, use_requires_limit: false,
    percent_used: { five_hour: 9 }, blocking: [],
  };
  const block = {
    eligible: true, ineligible_reason: null, at_limit: false, exhausted: [], grants: [grant],
    next_grant_id: grant.id, weekly_resets_at: "2026-09-25T23:00:00+00:00", cooldown_until: null,
    event_props: { surface: "claude_code_cli" },
  };

  it("parses an eligible block", () => {
    expect(parseLimitResets(block)).toEqual({
      eligible: true,
      grants: [{
        id: grant.id, resetsLeft: 1, endsAt: 1_792_684_800,
        clears: ["five_hour", "seven_day", "seven_day_overage_included"],
        clearsOther: false, usableNow: true, useRequiresLimit: false, paused: false,
      }],
      nextGrantId: grant.id,
      cooldownUntil: 0,
    });
  });

  it("treats null/absent/malformed blocks as unknown, never as zero resets", () => {
    expect(parseLimitResets(null)).toBeUndefined();
    expect(parseLimitResets(undefined)).toBeUndefined();
    expect(parseLimitResets({ grants: [] })).toBeUndefined(); // eligible missing
    expect(parseLimitResets("nope")).toBeUndefined();
  });

  it("keeps a known ineligible reason and maps unknown ones to 'unknown'", () => {
    expect(parseLimitResets({ eligible: false, ineligible_reason: "cli_version" })?.ineligibleReason).toBe("cli_version");
    expect(parseLimitResets({ eligible: false, ineligible_reason: "brand_new" })?.ineligibleReason).toBe("unknown");
    expect(parseLimitResets({ eligible: false, ineligible_reason: null })?.ineligibleReason).toBeUndefined();
  });

  it("drops malformed grants, filters unknown windows, and ignores a dangling next_grant_id", () => {
    const parsed = parseLimitResets({
      ...block,
      grants: [
        { ...grant, id: "Bad Id!" },
        { ...grant, resets_left: -1 },
        { ...grant, id: "other", clears: ["five_hour", "mystery_window", 3] },
      ],
      next_grant_id: grant.id, // points at the dropped grant
    });
    expect(parsed?.grants).toEqual([expect.objectContaining({ id: "other", clears: ["five_hour"], clearsOther: true })]);
    expect(parsed?.nextGrantId).toBeUndefined();
  });

  it("marks a refill scope it cannot name instead of silently shrinking it", () => {
    const only = (clears: unknown) => parseLimitResets({ ...block, grants: [{ ...grant, clears }] })?.grants[0];
    expect(only(["brand_new_window"])).toMatchObject({ clears: [], clearsOther: true });
    expect(only(undefined)).toMatchObject({ clears: [], clearsOther: true });
    expect(only("five_hour")).toMatchObject({ clears: [], clearsOther: true });
    expect(only(["five_hour"])).toMatchObject({ clears: ["five_hour"], clearsOther: false });
  });

  it("keeps an eligible block without a grant list unknown, but an explicit empty list is zero", () => {
    const { grants: _omit, ...noGrants } = block;
    expect(parseLimitResets(noGrants)).toBeUndefined();
    expect(parseLimitResets({ ...block, grants: "none" })).toBeUndefined();
    expect(parseLimitResets({ ...block, grants: [], next_grant_id: null })).toMatchObject({ eligible: true, grants: [] });
    // Ineligible blocks carry no entitlement, so a missing list is fine there.
    expect(parseLimitResets({ eligible: false, ineligible_reason: "surface" })).toMatchObject({ eligible: false, grants: [] });
  });

  it("defaults use_requires_limit to true when absent (the conservative reading)", () => {
    const { use_requires_limit: _omit, ...rest } = grant;
    expect(parseLimitResets({ ...block, grants: [rest] })?.grants[0]?.useRequiresLimit).toBe(true);
  });

  it("is attached to the usage snapshot", () => {
    const snapshot = parseAnthropicUsage({ five_hour: { utilization: 5 }, cedar_ember: block }, 1);
    expect(snapshot?.limitResets?.nextGrantId).toBe(grant.id);
    expect(parseAnthropicUsage({ five_hour: { utilization: 5 }, cedar_ember: null }, 1)?.limitResets).toBeUndefined();
  });
});
