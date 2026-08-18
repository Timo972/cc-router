import { describe, it, expect } from "vitest";
import { killPortAndWait, type PortKillDeps } from "../daemon/launcher.js";

/**
 * Fake process table. `diesAfterSignals` models a graceful shutdown that takes
 * a few polls; `immortal` never dies, even on SIGKILL.
 */
function fakeProcesses(options: {
  pids: number[];
  survivesTermPolls?: number;
  immortal?: boolean;
}) {
  const signals: Array<{ pid: number; signal: string }> = [];
  let pollsLeft = options.survivesTermPolls ?? 0;
  let terminated = false;
  let clock = 0;

  const deps: PortKillDeps = {
    listPids: async () => options.pids,
    kill: (pid, signal) => {
      signals.push({ pid, signal: String(signal) });
      if (signal === "SIGKILL" && !options.immortal) terminated = true;
      if (signal === "SIGTERM" && pollsLeft === 0 && !options.immortal) terminated = true;
    },
    isAlive: () => {
      if (terminated) return false;
      if (pollsLeft > 0) { pollsLeft--; return true; }
      return options.immortal ? true : (terminated = true, false);
    },
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
  };

  return { deps, signals };
}

describe("killPortAndWait", () => {
  it("reports success only after the process has actually exited", async () => {
    // Two polls' worth of graceful shutdown before the process is gone.
    const { deps, signals } = fakeProcesses({ pids: [4242], survivesTermPolls: 2 });

    const ok = await killPortAndWait(3456, deps);

    expect(ok).toBe(true);
    expect(signals[0]).toEqual({ pid: 4242, signal: "SIGTERM" });
  });

  it("escalates to SIGKILL when SIGTERM is ignored past the deadline", async () => {
    const { deps, signals } = fakeProcesses({ pids: [4242], survivesTermPolls: 1_000 });

    const ok = await killPortAndWait(3456, deps, 1_000);

    expect(ok).toBe(true);
    expect(signals.map(s => s.signal)).toContain("SIGKILL");
  });

  it("reports failure when the process survives even SIGKILL", async () => {
    const { deps } = fakeProcesses({ pids: [4242], immortal: true });

    expect(await killPortAndWait(3456, deps, 1_000)).toBe(false);
  });

  it("reports failure when nothing is listening on the port", async () => {
    const { deps, signals } = fakeProcesses({ pids: [] });

    expect(await killPortAndWait(3456, deps)).toBe(false);
    expect(signals).toHaveLength(0);
  });

  it("signals every pid holding the port", async () => {
    const { deps, signals } = fakeProcesses({ pids: [1, 2, 3] });

    await killPortAndWait(3456, deps);

    expect(signals.filter(s => s.signal === "SIGTERM").map(s => s.pid)).toEqual([1, 2, 3]);
  });
});
