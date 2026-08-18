import { execFileSync } from "node:child_process";
import { win32 } from "node:path";

export function pnpmInvocation(
  args,
  { platform = process.platform, pnpmHome = process.env.PNPM_HOME } = {},
) {
  if (platform !== "win32") return { file: "pnpm", args };
  if (!pnpmHome) {
    throw new Error("PNPM_HOME is required to invoke pnpm safely on Windows");
  }
  return {
    file: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      win32.join(pnpmHome, "bin", "pnpm.ps1"),
      ...args,
    ],
  };
}

export function runPnpm(args, cwd) {
  const invocation = pnpmInvocation(args);
  try {
    return execFileSync(invocation.file, invocation.args, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const stdout = error?.stdout === undefined ? "" : String(error.stdout);
    const stderr = error?.stderr === undefined ? "" : String(error.stderr);
    const renderedArgs = invocation.args.map(argument => JSON.stringify(argument)).join(" ");
    throw new Error(
      `${invocation.file} ${renderedArgs} failed\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      { cause: error },
    );
  }
}
