import { describe, expect, it } from "vitest";
import { getCodexCapacityRows, getCodexDefaultWindows, isCodexLimited, type CodexRateLimitsView } from "../ui/Dashboard.js";

const NOW = 1_754_000_000_000;

function codexView(overrides: Partial<CodexRateLimitsView> = {}): CodexRateLimitsView {
  return { status: "ok", plan: "plus", buckets: [], lastUpdated: NOW, ...overrides };
}

describe("getCodexCapacityRows", () => {
  it("returns no rows without named buckets or cooldowns", () => {
    expect(getCodexCapacityRows(codexView({
      buckets: [{ limitId: "codex", label: "codex", cooldownUntilMs: 0, primary: { utilization: 0.4, resetAt: 0, windowMinutes: 300 } }],
    }), 0, NOW)).toEqual([]);
    expect(getCodexCapacityRows(undefined, 0, NOW)).toEqual([]);
  });

  it("emits one labeled row per named-bucket window", () => {
    const rows = getCodexCapacityRows(codexView({
      buckets: [
        { limitId: "codex", label: "codex", cooldownUntilMs: 0 },
        {
          limitId: "codex_bengalfox", label: "gpt-5.6-sol", cooldownUntilMs: 0,
          primary: { utilization: 0.88, resetAt: Math.floor(NOW / 1000) + 600, windowMinutes: 300 },
          secondary: { utilization: 1, resetAt: 0, windowMinutes: 10080 },
        },
      ],
    }), 0, NOW);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: "gpt-5.6-sol 5h", color: "yellow", utilization: 0.88 });
    expect(rows[1]).toMatchObject({ label: "gpt-5.6-sol weekly", state: "exhausted", color: "red" });
  });

  it("counts down to the cooldown expiry, not the window reset, while cooling", () => {
    const windowReset = Math.floor(NOW / 1000) + 600;
    const rows = getCodexCapacityRows(codexView({
      buckets: [{
        limitId: "codex_bengalfox",
        label: "gpt-5.6-sol",
        // A Retry-After-derived cooldown outlasting the window reset: showing
        // the window reset would tell the operator routing resumes in 10m
        // when it actually resumes in an hour.
        cooldownUntilMs: NOW + 60 * 60_000,
        primary: { utilization: 1, resetAt: windowReset, windowMinutes: 300 },
      }],
    }), 0, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "bucket cooldown" });
    expect(rows[0]?.resetAt).toBe(Math.floor((NOW + 60 * 60_000) / 1000));
  });

  it("shows a cooling bucket's expiry even when the window reset is unknown", () => {
    const rows = getCodexCapacityRows(codexView({
      buckets: [{
        limitId: "codex_bengalfox",
        label: "gpt-5.6-sol",
        cooldownUntilMs: NOW + 90_000,
        primary: { utilization: 1, resetAt: 0, windowMinutes: 0 },
      }],
    }), 0, NOW);

    expect(rows[0]?.resetAt).toBe(Math.floor((NOW + 90_000) / 1000));
  });

  it("marks cooling buckets and appends the global cooldown row", () => {
    const rows = getCodexCapacityRows(codexView({
      buckets: [{ limitId: "codex_x", label: "gpt-5.6-terra", cooldownUntilMs: NOW + 30_000 }],
    }), NOW + 60_000, NOW);

    expect(rows[0]).toMatchObject({ label: "gpt-5.6-terra", state: "bucket cooldown", color: "yellow" });
    expect(rows[rows.length - 1]).toMatchObject({ label: "cooldown", state: "global", color: "red" });
  });
});

describe("isCodexLimited", () => {
  it("is limited when the account-wide status is rate_limited", () => {
    expect(isCodexLimited(codexView({ status: "rate_limited" }))).toBe(true);
  });

  it("is limited when the default bucket's primary window is fully exhausted", () => {
    expect(isCodexLimited(codexView({
      buckets: [{
        limitId: "codex", label: "codex", cooldownUntilMs: 0,
        primary: { utilization: 1, resetAt: 0, windowMinutes: 300 },
      }],
    }))).toBe(true);
  });

  it("is not limited when only a named bucket is exhausted", () => {
    expect(isCodexLimited(codexView({
      buckets: [
        { limitId: "codex", label: "codex", cooldownUntilMs: 0, primary: { utilization: 0.2, resetAt: 0, windowMinutes: 300 } },
        {
          limitId: "codex_bengalfox", label: "gpt-5.6-sol", cooldownUntilMs: 0,
          primary: { utilization: 1, resetAt: 0, windowMinutes: 300 },
        },
      ],
    }))).toBe(false);
  });

  it("is not limited for a healthy account", () => {
    expect(isCodexLimited(codexView({
      buckets: [{ limitId: "codex", label: "codex", cooldownUntilMs: 0, primary: { utilization: 0.4, resetAt: 0, windowMinutes: 300 } }],
    }))).toBe(false);
    expect(isCodexLimited(undefined)).toBe(false);
  });
});

describe("empty window placeholders", () => {
  it("ignores a zero-width window instead of emitting a duplicate row", () => {
    // Codex sends `secondary` as an all-zero placeholder rather than omitting
    // it, so `if (bucket.secondary)` was truthy and the same bucket rendered
    // twice — both labelled "weekly", because codexWindowLabel(0) falls through
    // to its fallback.
    const rows = getCodexCapacityRows(codexView({
      buckets: [{
        limitId: "codex_bengalfox", label: "GPT-5.3-Codex-Spark", cooldownUntilMs: 0,
        primary: { utilization: 0, resetAt: Math.floor(NOW / 1000) + 600_000, windowMinutes: 10080 },
        secondary: { utilization: 0, resetAt: 0, windowMinutes: 0 },
      }],
    }), 0, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "GPT-5.3-Codex-Spark weekly" });
  });
});

describe("getCodexDefaultWindows", () => {
  it("labels each window from its own duration rather than by position", () => {
    // Codex reports the weekly window in the `primary` slot. Labelling
    // positionally (primary→5h, secondary→weekly) showed a 100% weekly
    // utilization as "5h 100%" and an empty slot as "weekly 0%".
    const windows = getCodexDefaultWindows(codexView({
      buckets: [{
        limitId: "codex", label: "codex", cooldownUntilMs: 0,
        primary: { utilization: 1, resetAt: Math.floor(NOW / 1000) + 500_000, windowMinutes: 10080 },
        secondary: { utilization: 0, resetAt: 0, windowMinutes: 0 },
      }],
    }));

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ label: "weekly", utilization: 1, kind: "weekly" });
  });

  it("keeps both windows when the account really reports two", () => {
    const windows = getCodexDefaultWindows(codexView({
      buckets: [{
        limitId: "codex", label: "codex", cooldownUntilMs: 0,
        primary: { utilization: 0.5, resetAt: 10, windowMinutes: 300 },
        secondary: { utilization: 0.2, resetAt: 20, windowMinutes: 10080 },
      }],
    }));

    expect(windows.map(w => [w.label, w.kind])).toEqual([["5h", "session"], ["weekly", "weekly"]]);
  });

  it("returns nothing when there is no default bucket or no window data", () => {
    expect(getCodexDefaultWindows(codexView({ buckets: [] }))).toEqual([]);
    expect(getCodexDefaultWindows(undefined)).toEqual([]);
    expect(getCodexDefaultWindows(codexView({
      buckets: [{ limitId: "codex", label: "codex", cooldownUntilMs: 0 }],
    }))).toEqual([]);
  });
});
