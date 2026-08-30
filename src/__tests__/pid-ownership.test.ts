import { describe, it, expect } from "vitest";
import { managesPidFile } from "../daemon/pid.js";

describe("managesPidFile", () => {
  it("claims the PID file when launched as a background daemon", () => {
    expect(managesPidFile({ CC_ROUTER_DAEMON: "1" })).toBe(true);
  });

  it("claims the PID file when launched by the OS service manager", () => {
    // The LaunchAgent/systemd unit sets CC_ROUTER_SERVICE, not CC_ROUTER_DAEMON.
    // Without this, a service-managed proxy leaves no PID file, so `cc-router
    // stop` falls back to killing by port — which does not wait for the process
    // to actually exit.
    expect(managesPidFile({ CC_ROUTER_SERVICE: "1" })).toBe(true);
  });

  it("does not claim the PID file for a plain foreground run", () => {
    // `cc-router start --foreground` in a terminal is the user's process to
    // Ctrl+C; it must not overwrite the managed instance's PID file.
    expect(managesPidFile({})).toBe(false);
    expect(managesPidFile({ CC_ROUTER_DAEMON: "0", CC_ROUTER_SERVICE: "" })).toBe(false);
  });
});
