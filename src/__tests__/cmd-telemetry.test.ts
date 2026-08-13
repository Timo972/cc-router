import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const telemetry = vi.hoisted(() => ({
  getTelemetrySnapshot: vi.fn(),
  loadTelemetryState: vi.fn(),
  writeTelemetryState: vi.fn(),
  updateTelemetryConsent: vi.fn(),
}));

vi.mock("../config/telemetry.js", () => telemetry);

import { registerTelemetry } from "../cli/cmd-telemetry.js";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["DO_NOT_TRACK"];
  delete process.env["CC_ROUTER_TELEMETRY"];
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["DO_NOT_TRACK"];
  delete process.env["CC_ROUTER_TELEMETRY"];
});

async function runTelemetryStatus(): Promise<string> {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const program = new Command();
  registerTelemetry(program);

  await program.parseAsync(["node", "cc-router", "telemetry", "status"]);

  return output.mock.calls.map(([line]) => String(line)).join("\n");
}

describe("cc-router telemetry status", () => {
  it.each([
    [
      "a persisted opt-out",
      {
        state: {
          enabled: false,
          installId: "persisted-install-id",
          firstRunAt: "2026-01-01T00:00:00.000Z",
        },
        environmentDisabled: false,
        enabled: false,
      },
      "disabled (persisted)",
    ],
    [
      "an environment disablement reported by the snapshot",
      {
        state: {
          enabled: true,
          installId: "environment-install-id",
          firstRunAt: "2026-01-01T00:00:00.000Z",
        },
        environmentDisabled: true,
        enabled: false,
      },
      "disabled (by environment variable)",
    ],
  ])("renders %s from the telemetry snapshot", async (_name, snapshot, status) => {
    telemetry.getTelemetrySnapshot.mockReturnValue(snapshot);

    const output = await runTelemetryStatus();

    expect(output).toContain(`Status:     ${status}`);
    expect(output).toContain("Active:     no");
  });
});

describe("cc-router telemetry consent changes", () => {
  it.each([
    ["on", true],
    ["off", false],
  ] as const)("routes every explicit %s through the monotonic consent update", async (action, enabled) => {
    const state = {
      enabled,
      installId: "persisted-install-id",
      firstRunAt: "2026-01-01T00:00:00.000Z",
      revision: 8,
    };
    telemetry.updateTelemetryConsent.mockReturnValue(state);
    telemetry.loadTelemetryState.mockReturnValue({ ...state });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = new Command();
    registerTelemetry(program);

    await program.parseAsync(["node", "cc-router", "telemetry", action]);

    expect(telemetry.updateTelemetryConsent).toHaveBeenCalledExactlyOnceWith(enabled);
    expect(telemetry.loadTelemetryState).not.toHaveBeenCalled();
    expect(telemetry.writeTelemetryState).not.toHaveBeenCalled();
    expect(output.mock.calls.join("\n")).not.toContain("8");
  });
});
