import { spawn, execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { createRequire } from "module";
import chalk from "chalk";
import { CONFIG_DIR } from "../config/paths.js";
import { removePid } from "../daemon/pid.js";

const PKG_NAME = "ai-cc-router";
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const CHECK_CACHE_PATH = join(CONFIG_DIR, "update-check.json");
const LAST_GOOD_PATH = join(CONFIG_DIR, "last-good-version.json");
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ─── Version helpers ─────────────────────────────────────────────────────────

// Strict semver. The registry response is untrusted input: it is interpolated
// into the `npm install ai-cc-router@<version>` argument, so any value that is
// not a clean semver string must be rejected before it reaches a child process.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isValidVersion(value: unknown): value is string {
  return typeof value === "string" && SEMVER_RE.test(value);
}

export function getCurrentVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../../package.json") as { version: string };
  return pkg.version;
}

/** Simple semver diff: returns "major" | "minor" | "patch" | null */
function semverDiff(current: string, latest: string): "major" | "minor" | "patch" | null {
  const c = current.split(".").map(Number);
  const l = latest.split(".").map(Number);
  if (l[0] > c[0]) return "major";
  if (l[1] > c[1]) return "minor";
  if (l[2] > c[2]) return "patch";
  return null;
}

// ─── Check for update ────────────────────────────────────────────────────────

interface UpdateCheckResult {
  current: string;
  latest: string;
  diff: "major" | "minor" | "patch" | null;
  updateAvailable: boolean;
}

interface CachedCheck {
  latest: string;
  checkedAt: number;
}

function readCache(): CachedCheck | null {
  try {
    if (!existsSync(CHECK_CACHE_PATH)) return null;
    return JSON.parse(readFileSync(CHECK_CACHE_PATH, "utf-8")) as CachedCheck;
  } catch {
    return null;
  }
}

function writeCache(latest: string): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CHECK_CACHE_PATH, JSON.stringify({ latest, checkedAt: Date.now() }), "utf-8");
  } catch { /* non-critical */ }
}

/** Check npm registry for a newer version. Uses a 6h disk cache. */
export async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  const current = getCurrentVersion();

  // Use cache if fresh enough
  if (!force) {
    const cached = readCache();
    if (cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
      const diff = semverDiff(current, cached.latest);
      return { current, latest: cached.latest, diff, updateAvailable: diff !== null };
    }
  }

  // Fetch from registry
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { current, latest: current, diff: null, updateAvailable: false };
    const data = (await res.json()) as { version: string };
    // Reject anything that is not a clean semver string — a malicious or
    // compromised registry response must never flow into the install command.
    if (!isValidVersion(data.version)) {
      return { current, latest: current, diff: null, updateAvailable: false };
    }
    writeCache(data.version);
    const diff = semverDiff(current, data.version);
    return { current, latest: data.version, diff, updateAvailable: diff !== null };
  } catch {
    return { current, latest: current, diff: null, updateAvailable: false };
  }
}

// ─── Install prefix detection ────────────────────────────────────────────────
// Detect from process.argv[1] (the actual script), NOT from `npm config get prefix`
// which can return a wrong path under nvm/volta/fnm.

function detectInstallPrefix(): string {
  try {
    const scriptPath = realpathSync(process.argv[1]);
    // scriptPath is like: /prefix/lib/node_modules/ai-cc-router/dist/cli/index.js
    // We need to walk up to the prefix root.
    const marker = join("node_modules", PKG_NAME);
    const idx = scriptPath.indexOf(marker);
    if (idx !== -1) {
      // Walk up from .../lib/node_modules/ai-cc-router → .../
      const libDir = scriptPath.slice(0, idx); // .../lib/
      return resolve(libDir, "..");
    }
  } catch { /* fallback */ }

  // Fallback: ask npm (less reliable but better than nothing)
  try {
    return execFileSync("npm", ["config", "get", "prefix"], { encoding: "utf-8" }).trim();
  } catch {
    return "/usr/local";
  }
}

// ─── Perform update ──────────────────────────────────────────────────────────

export async function performUpdate(targetVersion: string): Promise<boolean> {
  // Defense in depth: never build an install command from an unvalidated
  // version, even if a caller bypassed checkForUpdate.
  if (!isValidVersion(targetVersion)) {
    console.error(chalk.red(`✗ Refusing to update: "${targetVersion}" is not a valid version`));
    return false;
  }

  const prefix = detectInstallPrefix();

  console.log(chalk.cyan(`\nUpdating ${PKG_NAME} to v${targetVersion}...`));
  console.log(chalk.gray(`  prefix: ${prefix}`));

  return new Promise((resolve) => {
    // No shell: pass argv directly. On Windows npm is a .cmd shim, so invoke it
    // by name without shell:true (which would re-parse the joined string through
    // cmd.exe and turn the version arg into a command-injection sink).
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(
      npmBin,
      ["install", "-g", `${PKG_NAME}@${targetVersion}`, `--prefix=${prefix}`],
      { stdio: "inherit" },
    );

    child.on("error", (err) => {
      console.error(chalk.red(`✗ Update failed: ${err.message}`));
      resolve(false);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        console.log(chalk.green(`✓ Updated to v${targetVersion}`));
        writeLastGood(targetVersion);
        resolve(true);
      } else {
        console.error(chalk.red(`✗ npm install exited with code ${code}`));
        resolve(false);
      }
    });
  });
}

// ─── Restart ─────────────────────────────────────────────────────────────────

/** Detect if running under an OS-level service manager or PM2. */
function isRunningAsService(): boolean {
  // Custom env var set by our own service definitions (launchd/systemd)
  if (process.env["CC_ROUTER_SERVICE"] === "1") return true;
  // PM2 (legacy — users who haven't migrated yet)
  if (process.env["PM2_HOME"] || process.env["pm_id"]) return true;
  return false;
}

/**
 * Restart the process.
 * - Under a service manager (launchd/systemd/PM2) → exit and let the manager restart us.
 * - Standalone daemon → spawn a replacement, then exit.
 * - Foreground → spawn a replacement, then exit.
 */
export function restartSelf(): void {
  if (isRunningAsService()) {
    console.log(chalk.gray("Restarting via service manager..."));
    // Clean up PID file before exit
    removePid();
    // Exit with non-zero so KeepAlive/Restart=on-failure triggers a restart.
    // Note: exit(1) is intentional — launchd's SuccessfulExit=false and
    // systemd's Restart=on-failure both require a non-zero exit to restart.
    // A cleaner approach (custom exit code or env-based signal) would avoid
    // polluting logs with "FAILURE" entries, but requires service file changes.
    process.exit(1);
    return;
  }

  console.log(chalk.gray("Restarting..."));
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CC_ROUTER_UPDATED: "1" },
  });
  child.unref();
  process.exit(0);
}

// ─── Last good version (rollback safety) ─────────────────────────────────────

function writeLastGood(version: string): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(LAST_GOOD_PATH, JSON.stringify({ version, ts: Date.now() }), "utf-8");
  } catch { /* non-critical */ }
}

export function getLastGoodVersion(): string | null {
  try {
    if (!existsSync(LAST_GOOD_PATH)) return null;
    const data = JSON.parse(readFileSync(LAST_GOOD_PATH, "utf-8")) as { version: string };
    return data.version;
  } catch {
    return null;
  }
}

// ─── High-level: check + update + restart ────────────────────────────────────

/** Background auto-update check. Only patches/minor. Returns true if update was started. */
export async function autoUpdateIfAvailable(): Promise<boolean> {
  const check = await checkForUpdate();
  if (!check.updateAvailable || check.diff === "major") return false;

  console.log(chalk.cyan(`\nNew version available: v${check.current} → v${check.latest}`));
  const ok = await performUpdate(check.latest);
  if (ok) {
    restartSelf();
    return true;
  }
  return false;
}

// ─── Notification banner (for interactive CLI) ──────────────────────────────

export function printUpdateBanner(check: UpdateCheckResult): void {
  if (!check.updateAvailable) return;

  const border = "─".repeat(50);
  console.log();
  console.log(chalk.yellow(border));
  console.log(
    chalk.yellow("  Update available: ") +
    chalk.gray(`v${check.current}`) +
    chalk.yellow(" → ") +
    chalk.green.bold(`v${check.latest}`),
  );
  console.log(
    chalk.yellow("  Run: ") +
    chalk.cyan("cc-router update") +
    chalk.yellow("  or  ") +
    chalk.cyan(`npm i -g ${PKG_NAME}@${check.latest}`),
  );
  console.log(chalk.yellow(border));
  console.log();
}
