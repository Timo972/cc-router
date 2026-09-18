import { describe, expect, it, vi } from "vitest";
import { browserCommandFor, openInBrowser } from "../utils/browser.js";

describe("browserCommandFor", () => {
  it("maps platforms to their opener", () => {
    expect(browserCommandFor("darwin", "https://x")).toEqual({ command: "open", args: ["https://x"] });
    expect(browserCommandFor("linux", "https://x")).toEqual({ command: "xdg-open", args: ["https://x"] });
    expect(browserCommandFor("win32", "https://x")).toEqual({ command: "cmd", args: ["/c", "start", "", "https://x"] });
  });
});

describe("openInBrowser", () => {
  it("resolves true when the opener exits cleanly", async () => {
    const execFile = vi.fn((_c: string, _a: string[], cb: (err: Error | null) => void) => cb(null)) as never;
    await expect(openInBrowser("https://x", { execFile, platform: "linux", env: {} })).resolves.toBe(true);
  });

  it("resolves false instead of throwing when the opener fails", async () => {
    const execFile = vi.fn((_c: string, _a: string[], cb: (err: Error | null) => void) => cb(new Error("ENOENT"))) as never;
    await expect(openInBrowser("https://x", { execFile, platform: "linux", env: {} })).resolves.toBe(false);
  });

  it("does nothing when CC_ROUTER_NO_BROWSER=1", async () => {
    const execFile = vi.fn() as never;
    await expect(
      openInBrowser("https://x", { execFile, platform: "darwin", env: { CC_ROUTER_NO_BROWSER: "1" } }),
    ).resolves.toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });
});
