import { describe, expect, it } from "vitest";
import { pnpmInvocation } from "../../scripts/ci-pnpm.mjs";

describe("CI pnpm invocation", () => {
  it("invokes the Windows PowerShell shim without joining arguments into shell source", () => {
    const invocation = pnpmInvocation(
      [
        "--offline",
        "--config.inject-workspace-packages=true",
        "--filter",
        "@timo972/cc-router",
        "deploy",
        "--prod",
        "C:\\work & audit\\production;install",
      ],
      { platform: "win32", pnpmHome: "C:\\pnpm home" },
    );

    expect(invocation).toEqual({
      file: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\pnpm home\\bin\\pnpm.ps1",
        "--offline",
        "--config.inject-workspace-packages=true",
        "--filter",
        "@timo972/cc-router",
        "deploy",
        "--prod",
        "C:\\work & audit\\production;install",
      ],
    });
  });

  it("invokes pnpm directly with the original argument vector on POSIX", () => {
    const args = ["--offline", "install"];

    expect(pnpmInvocation(args, { platform: "linux" })).toEqual({ file: "pnpm", args });
  });
});
