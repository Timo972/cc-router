import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import os from "os";
import chalk from "chalk";
import { LOG_PATH } from "../config/paths.js";
import { detectPlatform } from "../utils/platform.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_ENTRY = join(__dirname, "..", "cli", "bootstrap.js");

// ─── Platform paths ──────────────────────────────────────────────────────────

const LAUNCHD_LABEL = "com.cc-router.proxy";
const LAUNCHD_PLIST = join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_DIR = join(os.homedir(), ".config", "systemd", "user");
const SYSTEMD_SERVICE = join(SYSTEMD_DIR, "cc-router.service");
const WINDOWS_REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_REG_NAME = "CC-Router";

// ─── Public API ──────────────────────────────────────────────────────────────

export async function installService(serverMode: boolean): Promise<void> {
  const platform = detectPlatform();
  switch (platform) {
    case "macos":  return installMacOS(serverMode);
    case "linux":  return installLinux(serverMode);
    case "windows": return installWindows(serverMode);
  }
}

export async function uninstallService(): Promise<void> {
  const platform = detectPlatform();
  switch (platform) {
    case "macos":  return uninstallMacOS();
    case "linux":  return uninstallLinux();
    case "windows": return uninstallWindows();
  }
}

export function isServiceInstalled(): boolean {
  const platform = detectPlatform();
  switch (platform) {
    case "macos":  return existsSync(LAUNCHD_PLIST);
    case "linux":  return existsSync(SYSTEMD_SERVICE);
    case "windows": return isWindowsServiceInstalled();
  }
}

// ─── macOS LaunchAgent ───────────────────────────────────────────────────────

function buildPlist(serverMode: boolean): string {
  const envVars = serverMode
    ? `    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}</string>
      <key>HOST</key>
      <string>0.0.0.0</string>
      <key>CC_ROUTER_SERVICE</key>
      <string>1</string>
    </dict>`
    : `    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}</string>
      <key>CC_ROUTER_SERVICE</key>
      <string>1</string>
    </dict>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${CLI_ENTRY}</string>
        <string>start</string>
        <string>--foreground</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_PATH}</string>
    <key>WorkingDirectory</key>
    <string>${os.homedir()}</string>
${envVars}
</dict>
</plist>
`;
}

/** Runs `launchctl <args>`; resolves on success, throws on a non-zero exit. */
export type LaunchctlRunner = (args: string[]) => Promise<void>;

export interface BootstrapAfterTeardownOptions {
  uid: string;
  label: string;
  plistPath: string;
  run: LaunchctlRunner;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Total budget for teardown + bootstrap. Default 10s. */
  timeoutMs?: number;
}

const TEARDOWN_POLL_MS = 200;
const TEARDOWN_TIMEOUT_MS = 10_000;

/**
 * Load a LaunchAgent that may have just been booted out.
 *
 * `launchctl bootout` returns as soon as launchd accepts the request, not once
 * the job is gone. Bootstrapping the same label during that window fails with
 * "Bootstrap failed: 5: Input/output error" — and the legacy `load` fallback
 * fails the same way, so retrying through it does not help. That is what made
 * `cc-router start` need a second invocation after a restart: the first one
 * raced launchd's teardown, warned, and left nothing running.
 *
 * So: poll until launchd no longer knows the label, then bootstrap, retrying
 * until a shared deadline because launchd can still reject briefly after the
 * job disappears from `print`.
 */
export async function bootstrapAfterTeardown(
  opts: BootstrapAfterTeardownOptions,
): Promise<boolean> {
  const { uid, label, plistPath, run, sleep, now } = opts;
  const deadline = now() + (opts.timeoutMs ?? TEARDOWN_TIMEOUT_MS);

  // Phase 1 — wait for launchd to forget the old job.
  for (;;) {
    let stillLoaded: boolean;
    try {
      await run(["print", `gui/${uid}/${label}`]);
      stillLoaded = true;
    } catch {
      stillLoaded = false; // `print` fails once the label is gone
    }
    if (!stillLoaded) break;
    if (now() >= deadline) return false;
    await sleep(TEARDOWN_POLL_MS);
  }

  // Phase 2 — bootstrap, retrying while launchd finishes releasing the label.
  for (;;) {
    try {
      await run(["bootstrap", `gui/${uid}`, plistPath]);
      return true;
    } catch {
      if (now() >= deadline) return false;
      await sleep(TEARDOWN_POLL_MS);
    }
  }
}

const launchctlRun: LaunchctlRunner = async (args) => {
  await execFileAsync("launchctl", args);
};

function sleepMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function installMacOS(serverMode: boolean): Promise<void> {
  // Ensure LaunchAgents dir exists
  const launchAgentsDir = dirname(LAUNCHD_PLIST);
  if (!existsSync(launchAgentsDir)) mkdirSync(launchAgentsDir, { recursive: true });

  // Unload existing if present (ignore errors)
  if (existsSync(LAUNCHD_PLIST)) {
    await launchctlUnload();
  }

  writeFileSync(LAUNCHD_PLIST, buildPlist(serverMode), "utf-8");

  const uid = String(process.getuid?.() ?? 501);
  const loaded = await bootstrapAfterTeardown({
    uid,
    label: LAUNCHD_LABEL,
    plistPath: LAUNCHD_PLIST,
    run: launchctlRun,
    sleep: sleepMs,
    now: Date.now,
  });

  if (!loaded) {
    // Last resort for hosts where `bootstrap` is unavailable rather than busy.
    try {
      await execFileAsync("launchctl", ["load", LAUNCHD_PLIST]);
    } catch (err) {
      console.log(chalk.yellow(`⚠ Could not auto-load the LaunchAgent: ${(err as Error).message}`));
      console.log(chalk.gray(`  Load manually: launchctl load ${LAUNCHD_PLIST}`));
      return;
    }
  }
  console.log(chalk.green("✓ Auto-start on boot configured (macOS LaunchAgent)"));
}

async function uninstallMacOS(): Promise<void> {
  if (!existsSync(LAUNCHD_PLIST)) return;
  await launchctlUnload();
  try { unlinkSync(LAUNCHD_PLIST); } catch { /* ok */ }
  if (isServiceInstalled()) {
    console.log(chalk.yellow("  ⚠ Service may still be installed — check manually"));
  } else {
    console.log(chalk.green("  ✓ Auto-start removed"));
  }
}

async function launchctlUnload(): Promise<void> {
  const uid = String(process.getuid?.() ?? 501);
  try {
    await execFileAsync("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
  } catch {
    try {
      await execFileAsync("launchctl", ["unload", LAUNCHD_PLIST]);
    } catch { /* already unloaded */ }
  }
}

// ─── Linux systemd user service ──────────────────────────────────────────────

function buildSystemdUnit(serverMode: boolean): string {
  const envLine = serverMode
    ? `Environment=PATH=${process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}\nEnvironment=HOST=0.0.0.0\nEnvironment=CC_ROUTER_SERVICE=1`
    : `Environment=PATH=${process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}\nEnvironment=CC_ROUTER_SERVICE=1`;

  return `[Unit]
Description=CC-Router — round-robin proxy for Claude Max
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${CLI_ENTRY} start --foreground
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5
${envLine}

[Install]
WantedBy=default.target
`;
}

async function installLinux(serverMode: boolean): Promise<void> {
  if (!existsSync(SYSTEMD_DIR)) mkdirSync(SYSTEMD_DIR, { recursive: true });

  writeFileSync(SYSTEMD_SERVICE, buildSystemdUnit(serverMode), "utf-8");

  try {
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    await execFileAsync("systemctl", ["--user", "enable", "cc-router"]);
    await execFileAsync("systemctl", ["--user", "start", "cc-router"]);
    console.log(chalk.green("✓ Auto-start on boot configured (systemd user service)"));
    console.log(chalk.gray("  Logs: journalctl --user-unit cc-router -f"));
    console.log(chalk.gray("  Tip for headless servers: loginctl enable-linger $(whoami)"));
  } catch (err) {
    console.log(chalk.yellow(`⚠ systemd setup issue: ${(err as Error).message}`));
    console.log(chalk.gray(`  Enable manually: systemctl --user enable --now cc-router`));
  }
}

async function uninstallLinux(): Promise<void> {
  if (!existsSync(SYSTEMD_SERVICE)) return;
  try {
    await execFileAsync("systemctl", ["--user", "stop", "cc-router"]);
    await execFileAsync("systemctl", ["--user", "disable", "cc-router"]);
  } catch { /* may already be stopped */ }
  try { unlinkSync(SYSTEMD_SERVICE); } catch { /* ok */ }
  try { await execFileAsync("systemctl", ["--user", "daemon-reload"]); } catch { /* ok */ }
  if (isServiceInstalled()) {
    console.log(chalk.yellow("  ⚠ Service may still be installed — check manually"));
  } else {
    console.log(chalk.green("  ✓ Auto-start removed"));
  }
}

// ─── Windows Registry ────────────────────────────────────────────────────────

function buildWindowsCommand(): string {
  return `"${process.execPath}" "${CLI_ENTRY}" start --foreground`;
}

async function installWindows(serverMode: boolean): Promise<void> {
  const cmd = serverMode
    ? `cmd /c "set HOST=0.0.0.0 && set CC_ROUTER_SERVICE=1 && ${buildWindowsCommand()}"`
    : `cmd /c "set CC_ROUTER_SERVICE=1 && ${buildWindowsCommand()}"`;

  try {
    await execFileAsync("reg", [
      "add", WINDOWS_REG_KEY,
      "/v", WINDOWS_REG_NAME,
      "/t", "REG_SZ",
      "/d", cmd,
      "/f",
    ]);
    console.log(chalk.green("✓ Auto-start on login configured (Windows Registry)"));
  } catch (err) {
    console.log(chalk.yellow(`⚠ Registry write failed: ${(err as Error).message}`));
    console.log(chalk.gray(`  Add manually via Task Scheduler or registry editor.`));
  }
}

async function uninstallWindows(): Promise<void> {
  try {
    await execFileAsync("reg", [
      "delete", WINDOWS_REG_KEY,
      "/v", WINDOWS_REG_NAME,
      "/f",
    ]);
  } catch { /* not installed */ }
  if (isServiceInstalled()) {
    console.log(chalk.yellow("  ⚠ Service may still be installed — check manually"));
  } else {
    console.log(chalk.green("  ✓ Auto-start removed"));
  }
}

function isWindowsServiceInstalled(): boolean {
  try {
    execFileSync("reg", ["query", WINDOWS_REG_KEY, "/v", WINDOWS_REG_NAME]);
    return true;
  } catch {
    return false;
  }
}
