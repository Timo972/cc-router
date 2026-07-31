import { describe, expect, it } from "vitest";
import { getAccountCapacityRows, getVisibleModelWindow } from "../ui/Dashboard.js";

describe("getVisibleModelWindow", () => {
  it("scrolls the visible model window to keep the selected model in view", () => {
    const models = Array.from({ length: 30 }, (_, i) => ({ id: `model-${i}` }));

    const window = getVisibleModelWindow(models, 20, 16);

    expect(window.start).toBe(5);
    expect(window.rows.map(model => model.id)).toContain("model-20");
    expect(window.rows[15].id).toBe("model-20");
  });

  it("keeps the first page when the selected model is already visible", () => {
    const models = Array.from({ length: 30 }, (_, i) => ({ id: `model-${i}` }));

    const window = getVisibleModelWindow(models, 4, 16);

    expect(window.start).toBe(0);
    expect(window.rows[0].id).toBe("model-0");
  });
});

describe("getAccountCapacityRows", () => {
  it("renders dynamic model rows and compact state labels without fixed model names", () => {
    const rows = getAccountCapacityRows({
      rateLimits: {
        status: "allowed", fiveHourUtil: 0, fiveHourReset: 0,
        sevenDayUtil: 0, sevenDayReset: 0, claim: "", plan: "",
        requestsLimit: 0, lastUpdated: 0,
        usage: {
          modelLimits: [
            { displayName: "Claude Fable", modelFamily: "fable", utilization: 0.3, resetAt: 0, active: true, severity: "" },
            { displayName: "Claude Future", modelFamily: "future", utilization: 1, resetAt: 1_900_000_000, active: true, severity: "critical" },
          ],
          extraUsage: { enabled: true, spendLimitReached: false },
          fetchedAt: 1_700_000_000_000,
          fetchStatus: "fresh",
        },
      },
      globalCooldownUntilMs: 1_800_000_000_000,
      modelCooldowns: [{ modelFamily: "future", untilMs: 1_800_000_100_000 }],
    });

    expect(rows).toEqual([
      expect.objectContaining({ label: "Claude Fable", state: "included available", color: "green" }),
      expect.objectContaining({ label: "Claude Future", state: "paid extra active · requested-model cooldown", color: "yellow" }),
      expect.objectContaining({ label: "cooldown", state: "global", color: "red" }),
    ]);
  });

  it("keeps the account compact when no model-scoped data exists", () => {
    expect(getAccountCapacityRows({
      rateLimits: {
        status: "unknown", fiveHourUtil: 0, fiveHourReset: 0,
        sevenDayUtil: 0, sevenDayReset: 0, claim: "", plan: "",
        requestsLimit: 0, lastUpdated: 0,
        usage: { modelLimits: [], fetchedAt: 1, fetchStatus: "stale" },
      },
    })).toEqual([]);

    expect(getAccountCapacityRows({ rateLimits: undefined })).toEqual([]);
  });
});
