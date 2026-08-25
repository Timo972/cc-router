import { beforeEach, describe, expect, it, vi } from "vitest";

const telemetry = vi.hoisted(() => ({
  annotateActiveSpan: vi.fn(),
  recordSafeLog: vi.fn(),
  recordUnexpectedException: vi.fn(),
  withTelemetrySpan: vi.fn((_operation: unknown, _attributes: unknown, callback: () => unknown) => callback()),
}));

vi.mock("../telemetry/facade.js", () => telemetry);

import { UsageRefresher } from "../proxy/usage-refresher.js";

describe("UsageRefresher telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a thrown usage fetch once without reclassifying its cancellation fallback", async () => {
    const account = { id: "a" };
    const applyResult = vi.fn();
    const refresher = new UsageRefresher({
      getAll: () => [account],
      findById: id => id === account.id ? account : null,
    }, {
      fetchUsage: async () => { throw new TypeError("private usage failure"); },
      applyResult,
      cancelledResult: () => ({ ok: false as const, reason: "network" as const }),
      telemetry: {
        provider: "anthropic",
        classifyResult: result => ({
          outcome: "upstream_error",
          reason: result.reason === "network" ? "network_failure" : "other",
        }),
      },
    });

    await expect(refresher.refreshNow(account)).resolves.toEqual({ ok: false, reason: "network" });

    expect(telemetry.recordUnexpectedException).toHaveBeenCalledTimes(1);
    expect(telemetry.recordSafeLog).toHaveBeenCalledTimes(1);
    expect(telemetry.recordSafeLog).toHaveBeenCalledWith(expect.objectContaining({
      reason: "other",
      outcome: "upstream_error",
      severity: "error",
    }));
    expect(applyResult).toHaveBeenCalledWith(account, { ok: false, reason: "network" });
  });
});
