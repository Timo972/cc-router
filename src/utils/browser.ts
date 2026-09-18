import { spawn as nodeSpawn } from "node:child_process";

export function browserCommandFor(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Best-effort: a headless box, a missing opener or an odd desktop must never
 * fail a sign-in. The caller always prints the URL as well.
 *
 * Resolves as soon as the opener has been launched, never when it exits:
 * on some Linux desktops `xdg-open` blocks until the browser it started
 * closes, and a sign-in that awaited that would never reach its polling
 * loop while the operator was approving it in that very browser.
 */
export function openInBrowser(
  url: string,
  deps: { spawn?: typeof nodeSpawn; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (env.CC_ROUTER_NO_BROWSER === "1") return Promise.resolve(false);
  const { command, args } = browserCommandFor(deps.platform ?? process.platform, url);
  const spawn = deps.spawn ?? nodeSpawn;
  return new Promise(resolve => {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.once("spawn", () => resolve(true));
      child.once("error", () => resolve(false));
      // Let the process exit without waiting on the opener.
      child.unref();
    } catch {
      resolve(false);
    }
  });
}
