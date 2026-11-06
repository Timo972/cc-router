import { describe, it, expect } from "vitest";
import { canPromptForUpdate } from "../cli/cmd-start.js";

/**
 * `cc-router start` asks "Update now?" when npm has a newer version. The
 * background daemon (`launchDaemon`) and the OS service start the same
 * `start --foreground` command with stdin ignored, so that prompt cannot be
 * answered: inquirer rejects on the closed stdin and the daemon dies before it
 * binds. The proxy then fails to start the moment an update is published.
 */
describe("canPromptForUpdate", () => {
  it("offers the update in an interactive terminal start", () => {
    expect(canPromptForUpdate({}, true)).toBe(true);
  });

  it("never prompts inside the background daemon", () => {
    expect(canPromptForUpdate({ CC_ROUTER_DAEMON: "1" }, true)).toBe(false);
  });

  it("never prompts under the OS service manager", () => {
    expect(canPromptForUpdate({ CC_ROUTER_SERVICE: "1" }, true)).toBe(false);
  });

  it("never prompts when stdin is not a terminal", () => {
    expect(canPromptForUpdate({}, false)).toBe(false);
    expect(canPromptForUpdate({}, undefined)).toBe(false);
  });
});
