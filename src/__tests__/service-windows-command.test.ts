import { exec } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildWindowsAutostartCommand } from "../daemon/service.js";

/**
 * `set VAR=value && next` keeps the space before `&&` in the value, so the
 * Windows service used to run with CC_ROUTER_SERVICE="1 " (never recognised,
 * no PID file) and, in server mode, HOST="0.0.0.0 " (listen fails ENOTFOUND).
 */
describe("buildWindowsAutostartCommand", () => {
  it("sets the env values without trailing spaces", () => {
    expect(buildWindowsAutostartCommand(false, "X")).toBe('cmd /c "set CC_ROUTER_SERVICE=1&& X"');
    expect(buildWindowsAutostartCommand(true, "X"))
      .toBe('cmd /c "set HOST=0.0.0.0&& set CC_ROUTER_SERVICE=1&& X"');
  });

  it.runIf(process.platform === "win32")("passes exact values through cmd.exe", async () => {
    const probe = `"${process.execPath}" -p "[process.env.HOST, process.env.CC_ROUTER_SERVICE].join('|') + '|'"`;
    const env = { ...process.env, HOST: undefined, CC_ROUTER_SERVICE: undefined };
    const run = async (serverMode: boolean) =>
      (await promisify(exec)(buildWindowsAutostartCommand(serverMode, probe), { env })).stdout.trim();
    expect(await run(true)).toBe("0.0.0.0|1|");
    expect(await run(false)).toBe("|1|");
  });
});
