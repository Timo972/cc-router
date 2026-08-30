import { describe, expect, it } from "vitest";
import {
  getAccountCapacityRows,
  getGlobalCapacityView,
  getVisibleModelWindow,
} from "../ui/Dashboard.js";

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
    const now = Date.now();
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
          extraUsage: { enabled: true, spendLimitReached: false, usable: true },
          fetchedAt: 1_700_000_000_000,
          fetchStatus: "fresh",
        },
      },
      globalCooldownUntilMs: now + 60_000,
      modelCooldowns: [{ modelFamily: "future", untilMs: now + 120_000 }],
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

  it("does not present stale model entries as available or paid capacity", () => {
    const rows = getAccountCapacityRows({
      rateLimits: {
        status: "allowed", fiveHourUtil: 0.1, fiveHourReset: 0,
        sevenDayUtil: 0.1, sevenDayReset: 0, claim: "", plan: "",
        requestsLimit: 0, lastUpdated: 0,
        usage: {
          modelLimits: [{
            displayName: "Claude Future",
            modelFamily: "future",
            utilization: 1,
            resetAt: 1_900_000_000,
            active: true,
            severity: "",
          }],
          extraUsage: { enabled: true, spendLimitReached: false, usable: true },
          fetchedAt: 1_700_000_000_000,
          fetchStatus: "stale",
        },
      },
    });

    expect(rows).toEqual([expect.objectContaining({
      label: "Claude Future",
      state: "usage stale",
      color: "yellow",
    })]);
    expect(rows[0].state).not.toContain("available");
    expect(rows[0].state).not.toContain("paid extra");
  });

  it.each([
    ["stale", true, "usage stale · requested-model cooldown"],
    ["unavailable", true, "usage unavailable · requested-model cooldown"],
    ["fresh", false, "inactive · requested-model cooldown"],
  ] as const)(
    "keeps a live requested-model cooldown visible for %s usage with active=%s",
    (fetchStatus, active, expectedState) => {
      const rows = getAccountCapacityRows({
        rateLimits: {
          status: "allowed", fiveHourUtil: 0.1, fiveHourReset: 0,
          sevenDayUtil: 0.1, sevenDayReset: 0, claim: "", plan: "",
          requestsLimit: 0, lastUpdated: 0,
          usage: {
            modelLimits: [{
              displayName: "Claude Future",
              modelFamily: "future",
              utilization: 0.4,
              resetAt: 1_900_000_000,
              active,
              severity: "",
            }],
            fetchedAt: 1_700_000_000_000,
            fetchStatus,
          },
        },
        modelCooldowns: [{ modelFamily: "future", untilMs: Date.now() + 60_000 }],
      });

      expect(rows).toEqual([expect.objectContaining({
        label: "Claude Future",
        state: expectedState,
        color: "yellow",
      })]);
    },
  );
});

describe("getGlobalCapacityView", () => {
  it("prefers newer response-header windows and marks the older snapshot stale", () => {
    const view = getGlobalCapacityView({
      status: "allowed",
      fiveHourUtil: 0.8,
      fiveHourReset: 800,
      sevenDayUtil: 0.7,
      sevenDayReset: 700,
      claim: "",
      plan: "",
      requestsLimit: 0,
      lastUpdated: 200,
      usage: {
        fiveHour: { utilization: 0.1, resetAt: 100 },
        sevenDay: { utilization: 0.2, resetAt: 200 },
        modelLimits: [],
        fetchedAt: 100,
        fetchStatus: "fresh",
      },
    });

    expect(view).toEqual({
      fiveHour: { utilization: 0.8, resetAt: 800 },
      sevenDay: { utilization: 0.7, resetAt: 700 },
      usageFetchStatus: "stale",
    });
  });

  it("uses snapshot windows when they are at least as new as the headers", () => {
    const view = getGlobalCapacityView({
      status: "allowed",
      fiveHourUtil: 0.8,
      fiveHourReset: 800,
      sevenDayUtil: 0.7,
      sevenDayReset: 700,
      claim: "",
      plan: "",
      requestsLimit: 0,
      lastUpdated: 200,
      usage: {
        fiveHour: { utilization: 0.1, resetAt: 100 },
        sevenDay: { utilization: 0.2, resetAt: 200 },
        modelLimits: [],
        fetchedAt: 200,
        fetchStatus: "fresh",
      },
    });

    expect(view).toEqual({
      fiveHour: { utilization: 0.1, resetAt: 100 },
      sevenDay: { utilization: 0.2, resetAt: 200 },
      usageFetchStatus: "fresh",
    });
  });
});
