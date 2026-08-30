import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitForHealth } from "../daemon/launcher.js";

describe("waitForHealth", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("resolves true as soon as the proxy answers its health endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    expect(await waitForHealth(3456, 2_000)).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://localhost:3456/cc-router/health",
      expect.anything(),
    );
  });

  it("resolves false when nothing ever answers", async () => {
    // This is the case service-mode start previously never checked: launchd
    // rejected the bootstrap, nothing was listening, and start still reported
    // success.
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await waitForHealth(3456, 600)).toBe(false);
  });

  it("keeps polling past a non-ok response until the proxy is ready", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValue({ ok: true } as Response);

    expect(await waitForHealth(3456, 2_000)).toBe(true);
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(1);
  });
});

describe("service start health budget", () => {
  it("outlasts launchd's respawn throttle plus daemon startup", async () => {
    // A stop→start restart re-bootstraps a label whose process exited
    // moments earlier; launchd throttles that spawn by up to ~10s (default
    // ThrottleInterval) before the daemon even begins starting. A budget
    // that only covers instant spawns reports "nothing answering" for a
    // service that comes up seconds later.
    const { SERVICE_HEALTH_TIMEOUT_MS } = await import("../cli/cmd-start.js");
    vi.useFakeTimers();
    try {
      const bootAt = Date.now() + 12_000; // throttle (~10s) + node startup
      vi.stubGlobal("fetch", vi.fn(async () => {
        if (Date.now() < bootAt) throw new Error("ECONNREFUSED");
        return { ok: true } as Response;
      }));

      const result = waitForHealth(3456, SERVICE_HEALTH_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(SERVICE_HEALTH_TIMEOUT_MS);
      await expect(result).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
