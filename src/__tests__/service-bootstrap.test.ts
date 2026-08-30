import { describe, it, expect } from "vitest";
import { bootstrapAfterTeardown, type LaunchctlRunner } from "../daemon/service.js";

const UID = "501";
const LABEL = "com.cc-router.proxy";
const PLIST = "/Users/test/Library/LaunchAgents/com.cc-router.proxy.plist";

/**
 * Fake launchd. `jobAliveForCalls` models the window after `bootout` returns
 * during which launchd still knows about the label and rejects a bootstrap of
 * the same label with "Bootstrap failed: 5: Input/output error".
 */
function fakeLaunchctl(options: { printSucceedsTimes: number; bootstrapFailsTimes?: number }) {
  const calls: string[][] = [];
  let printsLeft = options.printSucceedsTimes;
  let bootstrapFailsLeft = options.bootstrapFailsTimes ?? 0;

  const run: LaunchctlRunner = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "print") {
      // Succeeds while the job still exists; throws once launchd has forgotten it.
      if (printsLeft-- > 0) return;
      throw new Error("Could not find service");
    }
    if (args[0] === "bootstrap") {
      if (bootstrapFailsLeft-- > 0) throw new Error("Bootstrap failed: 5: Input/output error");
      return;
    }
  };

  return { run, calls };
}

function deps(runner: { run: LaunchctlRunner }) {
  let clock = 0;
  return {
    run: runner.run,
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
  };
}

describe("bootstrapAfterTeardown", () => {
  it("waits for the old job to disappear before bootstrapping", async () => {
    // launchd still reports the job for the first three polls after bootout.
    const launchctl = fakeLaunchctl({ printSucceedsTimes: 3 });

    const ok = await bootstrapAfterTeardown({
      uid: UID, label: LABEL, plistPath: PLIST, ...deps(launchctl),
    });

    expect(ok).toBe(true);
    const verbs = launchctl.calls.map(c => c[0]);
    // Every poll happens before the single bootstrap — no bootstrap is attempted
    // while launchd still knows about the label.
    expect(verbs).toEqual(["print", "print", "print", "print", "bootstrap"]);
  });

  it("retries a bootstrap launchd rejects while it finishes tearing down", async () => {
    const launchctl = fakeLaunchctl({ printSucceedsTimes: 0, bootstrapFailsTimes: 2 });

    const ok = await bootstrapAfterTeardown({
      uid: UID, label: LABEL, plistPath: PLIST, ...deps(launchctl),
    });

    expect(ok).toBe(true);
    expect(launchctl.calls.filter(c => c[0] === "bootstrap")).toHaveLength(3);
  });

  it("gives up and reports failure when the job never goes away", async () => {
    // The job outlives the deadline — bootstrap must not be attempted forever.
    const launchctl = fakeLaunchctl({ printSucceedsTimes: Number.MAX_SAFE_INTEGER });

    const ok = await bootstrapAfterTeardown({
      uid: UID, label: LABEL, plistPath: PLIST, timeoutMs: 1_000, ...deps(launchctl),
    });

    expect(ok).toBe(false);
  });

  it("bootstraps immediately when no old job is present", async () => {
    const launchctl = fakeLaunchctl({ printSucceedsTimes: 0 });

    const ok = await bootstrapAfterTeardown({
      uid: UID, label: LABEL, plistPath: PLIST, ...deps(launchctl),
    });

    expect(ok).toBe(true);
    expect(launchctl.calls.map(c => c[0])).toEqual(["print", "bootstrap"]);
  });
});
