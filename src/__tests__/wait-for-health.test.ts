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
