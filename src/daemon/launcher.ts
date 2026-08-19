import { spawn } from "child_process";
import { openSync, closeSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import chalk from "chalk";
import { LOG_PATH, PROXY_PORT } from "../config/paths.js";
import { ensureConfigDir } from "../config/manager.js";
import { writePid, getRunningPid, isProcessAlive, removePid, isProxyRunning } from "./pid.js";
import { isWindows } from "../utils/platform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_ENTRY = join(__dirname, "..", "cli", "index.js");

export interface LaunchOptions {
  port?: number;
  litellmUrl?: string;
  accountsPath?: string;
  serverMode?: boolean;
}

/** Launch cc-router as a detached background process. */
export async function launchDaemon(opts: LaunchOptions = {}): Promise<boolean> {
  const port = opts.port ?? PROXY_PORT;

  // Already running?
  if (await isProxyRunning(port)) {
    console.log(chalk.green(`✓ CC-Router is already running on port ${port}`));
    console.log(chalk.gray(`  Logs: cc-router logs  |  Stop: cc-router stop`));
    return true;
  }

  ensureConfigDir();

  // Build args
  const args = [CLI_ENTRY, "start", "--foreground", "--port", String(port)];
  if (opts.litellmUrl) args.push("--litellm", opts.litellmUrl);
  if (opts.accountsPath) args.push("--accounts", opts.accountsPath);

  // Build env
  const env: Record<string, string | undefined> = { ...process.env, CC_ROUTER_DAEMON: "1" };
  if (opts.serverMode) env["HOST"] = "0.0.0.0";

  // Open log file (append mode) for stdout+stderr redirection
  let logFd: number;
  try {
    logFd = openSync(LOG_PATH, "a");
  } catch (err) {
    console.error(chalk.red(`✗ Cannot open log file: ${LOG_PATH}`));
    console.error(chalk.gray(`  ${(err as Error).message}`));
    return false;
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
    windowsHide: true,
  });

  if (!child.pid) {
    console.error(chalk.red("✗ Failed to start background process"));
    return false;
  }

  writePid(child.pid);
  child.unref();
  closeSync(logFd);

  // Wait for health endpoint to respond
  console.log(chalk.gray("  Starting CC-Router in background..."));
  const healthy = await waitForHealth(port, 5_000);

  if (healthy) {
    console.log(chalk.green(`✓ CC-Router running in background on port ${port}`));
    return true;
  } else {
    console.log(chalk.yellow(`⚠ Process started (PID ${child.pid}) but not yet responding.`));
    console.log(chalk.gray(`  Check logs: cc-router logs`));
    return false;
  }
}

/** Stop the cc-router daemon process. */
export async function stopDaemon(port = PROXY_PORT): Promise<boolean> {
  // Try PID-based stop first
  const pid = getRunningPid();
  if (pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already dead
      removePid();
      return true;
    }

    // Wait for graceful shutdown (up to 5s)
    const died = await waitForDeath(pid, 5_000);
    if (!died) {
      // Force kill
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      // Verify it actually died
      await new Promise(r => setTimeout(r, 500));
      if (isProcessAlive(pid)) {
        console.log(chalk.yellow(`  ⚠ Could not kill process ${pid}`));
        return false; // don't remove PID file — process is still alive
      }
    }
    removePid();
    return true;
  }

  // Fallback: kill by port (handles foreground processes or legacy PM2)
  return killByPort(port);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Poll the proxy's health endpoint until it answers or the budget runs out. */
export async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/cc-router/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await sleep(300);
  }
  return false;
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(200);
  }
  return false;
}

export interface PortKillDeps {
  listPids: (port: number) => Promise<number[]>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Terminate whatever holds `port` and wait until it is actually gone.
 *
 * The previous implementation returned `true` as soon as SIGTERM was sent, so
 * `cc-router stop` reported "✓ Proxy process stopped" while the process was
 * still shutting down. A `start` issued immediately afterwards then raced that
 * teardown. The PID-based path already waited (`waitForDeath`); this is the
 * fallback taken when no PID file exists, and it now waits too.
 */
export async function killPortAndWait(
  port: number,
  deps: PortKillDeps,
  timeoutMs = 5_000,
): Promise<boolean> {
  const pids = await deps.listPids(port);
  if (pids.length === 0) return false;

  for (const pid of pids) deps.kill(pid, "SIGTERM");

  const deadline = deps.now() + timeoutMs;
  const anyAlive = () => pids.some(pid => deps.isAlive(pid));

  while (anyAlive()) {
    if (deps.now() >= deadline) {
      for (const pid of pids) {
        if (deps.isAlive(pid)) deps.kill(pid, "SIGKILL");
      }
      await deps.sleep(POST_KILL_GRACE_MS);
      return !anyAlive();
    }
    await deps.sleep(DEATH_POLL_MS);
  }
  return true;
}

const DEATH_POLL_MS = 200;
const POST_KILL_GRACE_MS = 500;

/**
 * PIDs that should die when the proxy on `port` is killed by port: the
 * process LISTENING on it — never connected clients. A bare `lsof -ti :port`
 * lists BOTH ends of every connection, which included the stop CLI itself
 * (its health-check fetch leaves a keep-alive socket open) and any live
 * Claude Code / Codex session talking to the proxy; `cc-router stop` then
 * SIGTERMed all of them, itself included (`zsh: terminated`).
 */
export async function listListeningPids(port: number): Promise<number[]> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  try {
    if (isWindows()) {
      const { stdout } = await execFileAsync("netstat", ["-ano"]);
      const match = stdout
        .split("\n")
        .find(line => line.includes(`:${port}`) && line.includes("LISTENING"));
      if (!match) return [];
      const pid = Number(match.trim().split(/\s+/).at(-1));
      return Number.isNaN(pid) ? [] : [pid];
    }
    const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
    return stdout.trim().split("\n").filter(Boolean).map(Number)
      .filter(n => !Number.isNaN(n))
      // Belt and braces: whatever the listing says, killing by port must
      // never target the process doing the killing.
      .filter(pid => pid !== process.pid);
  } catch {
    return [];
  }
}

async function killByPort(port: number): Promise<boolean> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  try {
    return await killPortAndWait(port, {
      listPids: listListeningPids,
      // Windows has no signals: taskkill /F is the only lever, so both the
      // graceful and forced step map onto it.
      kill: (pid, signal) => {
        if (isWindows()) {
          void execFileAsync("taskkill", ["/PID", String(pid), "/F"]).catch(() => {});
          return;
        }
        try { process.kill(pid, signal); } catch { /* already gone */ }
      },
      isAlive: isProcessAlive,
      sleep,
      now: Date.now,
    });
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
