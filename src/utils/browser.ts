import { execFile as nodeExecFile } from "node:child_process";

export function browserCommandFor(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Best-effort: a headless box, a missing opener or an odd desktop must never
 * fail a sign-in. The caller always prints the URL as well.
 */
export function openInBrowser(
  url: string,
  deps: { execFile?: typeof nodeExecFile; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (env.CC_ROUTER_NO_BROWSER === "1") return Promise.resolve(false);
  const { command, args } = browserCommandFor(deps.platform ?? process.platform, url);
  const execFile = deps.execFile ?? nodeExecFile;
  return new Promise(resolve => {
    try {
      execFile(command, args, error => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}
