import { describe, expect, it } from "vitest";
import { publicLimitResets } from "../proxy/public-limit-resets.js";
import type { LimitResetGrant } from "../proxy/types.js";

const g = (over: Partial<LimitResetGrant>): LimitResetGrant => ({
  id: "grant-a", resetsLeft: 1, endsAt: 1_792_684_800, clears: ["five_hour", "seven_day"],
  usableNow: true, useRequiresLimit: false, paused: false, ...over,
});

describe("publicLimitResets", () => {
  it("summarises the next grant without exposing any grant id", () => {
    const view = publicLimitResets({ eligible: true, grants: [g({}), g({ id: "grant-b", resetsLeft: 2 })], nextGrantId: "grant-a", cooldownUntil: 0 });
    expect(view).toEqual({ eligible: true, available: 3, usableNow: true, requiresLimit: false, useBy: 1_792_684_800, clears: ["five_hour", "seven_day"] });
    expect(JSON.stringify(view)).not.toContain("grant-");
  });
  it("excludes paused grants from the count and clamps to 99", () => {
    expect(publicLimitResets({ eligible: true, grants: [g({ paused: true }), g({ id: "b", resetsLeft: 500 })], nextGrantId: "b", cooldownUntil: 0 }).available).toBe(99);
  });
  it("reports an ineligible account with no usable grant", () => {
    expect(publicLimitResets({ eligible: false, ineligibleReason: "cli_version", grants: [], cooldownUntil: 0 }))
      .toEqual({ eligible: false, ineligibleReason: "cli_version", available: 0, usableNow: false, requiresLimit: true, useBy: 0, clears: [] });
  });
});
