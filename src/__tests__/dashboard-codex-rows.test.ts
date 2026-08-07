import { describe, expect, it } from "vitest";
import { getCodexCapacityRows, type CodexRateLimitsView } from "../ui/Dashboard.js";

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

  it("marks cooling buckets and appends the global cooldown row", () => {
    const rows = getCodexCapacityRows(codexView({
      buckets: [{ limitId: "codex_x", label: "gpt-5.6-terra", cooldownUntilMs: NOW + 30_000 }],
    }), NOW + 60_000, NOW);

    expect(rows[0]).toMatchObject({ label: "gpt-5.6-terra", state: "bucket cooldown", color: "yellow" });
    expect(rows[rows.length - 1]).toMatchObject({ label: "cooldown", state: "global", color: "red" });
  });
});
