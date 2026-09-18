import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { browserCommandFor, openInBrowser } from "../utils/browser.js";

describe("browserCommandFor", () => {
  it("maps platforms to their opener", () => {
    expect(browserCommandFor("darwin", "https://x")).toEqual({ command: "open", args: ["https://x"] });
    expect(browserCommandFor("linux", "https://x")).toEqual({ command: "xdg-open", args: ["https://x"] });
    expect(browserCommandFor("win32", "https://x")).toEqual({ command: "cmd", args: ["/c", "start", "", "https://x"] });
  });
});

/** A fake child: emits `event` on the next tick and never exits. */
function fakeSpawn(event: "spawn" | "error") {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const spawn = vi.fn((command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    setImmediate(() => child.emit(event, event === "error" ? new Error("ENOENT") : undefined));
    return child;
  }) as never;
  return { spawn, calls };
}

describe("openInBrowser", () => {
  it("resolves true once the opener has launched, without waiting for it to exit", async () => {
    const { spawn, calls } = fakeSpawn("spawn");
    await expect(openInBrowser("https://x", { spawn, platform: "linux", env: {} })).resolves.toBe(true);
    expect(calls[0]).toMatchObject({ command: "xdg-open", args: ["https://x"], options: { detached: true, stdio: "ignore" } });
  });

  it("resolves false instead of throwing when the opener cannot be spawned", async () => {
    const { spawn } = fakeSpawn("error");
    await expect(openInBrowser("https://x", { spawn, platform: "linux", env: {} })).resolves.toBe(false);
  });

  it("resolves false when spawn itself throws", async () => {
    const spawn = vi.fn(() => { throw new Error("boom"); }) as never;
    await expect(openInBrowser("https://x", { spawn, platform: "darwin", env: {} })).resolves.toBe(false);
  });

  it("does nothing when CC_ROUTER_NO_BROWSER=1", async () => {
    const spawn = vi.fn() as never;
    await expect(
      openInBrowser("https://x", { spawn, platform: "darwin", env: { CC_ROUTER_NO_BROWSER: "1" } }),
    ).resolves.toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
