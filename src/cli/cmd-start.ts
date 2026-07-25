import type { Command } from "commander";
import { select, confirm, password as passwordPrompt } from "@inquirer/prompts";
import chalk from "chalk";
import { PROXY_PORT, LITELLM_PORT, ACCOUNTS_PATH } from "../config/paths.js";
import {
  accountsFileExists,
  readConfig,
  writeConfig,
  generateProxySecret,
  type RunPreferences,
} from "../config/manager.js";
import { writeClaudeSettings } from "../utils/claude-config.js";
import { checkForUpdate, performUpdate } from "../utils/self-update.js";
import { launchDaemon } from "../daemon/launcher.js";
import { isProxyRunning } from "../daemon/pid.js";
import { installService } from "../daemon/service.js";
import { getLocalIPs } from "../utils/network.js";

export function registerStart(program: Command): void {
  program
    .command("start")
    .description("Start the proxy server")
    .option("--foreground", "Run in the foreground (stay in this terminal)")
    .option("--port <port>", "Port to listen on", String(PROXY_PORT))
    .option("--litellm [url]", "Forward to LiteLLM instead of Anthropic directly")
    .option("--accounts <path>", "Path to accounts.json", ACCOUNTS_PATH)
    .option("--reconfigure", "Re-ask run preferences (forget saved preferences)")
    .action(async (opts: {
      foreground?: boolean;
      port: string;
      litellm?: string | boolean;
      accounts: string;
      reconfigure?: boolean;
    }) => {
      // ── Step 0: Check for updates ──────────────────────────────────────────
      await maybeUpdate();

      // ── Step 1: Ensure accounts exist ──────────────────────────────────────
      if (!accountsFileExists(opts.accounts !== ACCOUNTS_PATH ? opts.accounts : undefined)) {
        console.log(chalk.yellow("\n  No accounts configured yet.\n"));
        const runSetup = await confirm({
          message: "Run the setup wizard now?",
          default: true,
        });
        if (runSetup) {
          const { runSetupWizard } = await import("./cmd-setup.js");
          await runSetupWizard({ addMode: false });
          // After setup, re-check
          if (!accountsFileExists()) {
            console.log(chalk.red("\n✗ Setup did not produce accounts. Cannot start.\n"));
            process.exit(1);
          }
        } else {
          console.log(chalk.gray("  Run 'cc-router setup' when you're ready.\n"));
          return;
        }
      }

      // ── Step 2: Resolve run preferences ────────────────────────────────────
      const cfg = readConfig();

      // --foreground flag overrides everything
      if (opts.foreground) {
        await startForeground(opts);
        return;
      }

      // --reconfigure: forget saved preferences
      if (opts.reconfigure) {
        delete cfg.runPreferences;
        writeConfig(cfg);
      }

      let prefs = cfg.runPreferences;

      if (!prefs) {
        // First time — ask the user
        prefs = await askRunPreferences();
        cfg.runPreferences = prefs;
        writeConfig(cfg);
      }

      // ── Step 3: Handle server mode setup ───────────────────────────────────
      if (prefs.serverMode && !cfg.proxySecret) {
        await maybeSetupPassword(cfg);
      }

      // ── Step 4: Configure Claude Code if not already done ──────────────────
      await ensureClaudeCodeConfigured(prefs, cfg);

      // ── Step 5: Start according to preferences ─────────────────────────────
      const port = parseInt(opts.port, 10) || prefs.port;
      const litellmUrl = opts.litellm
        ? (typeof opts.litellm === "string" ? opts.litellm : `http://localhost:${LITELLM_PORT}`)
        : undefined;

      if (opts.litellm && typeof opts.litellm !== "string") {
        await ensureLiteLLMRunning();
      }

      if (prefs.mode === "foreground") {
        await startForeground(opts);
        return;
      }

      if (prefs.mode === "service") {
        await installService(prefs.serverMode);
      } else {
        // background mode
        await launchDaemon({
          port,
          litellmUrl,
          accountsPath: opts.accounts !== ACCOUNTS_PATH ? opts.accounts : undefined,
          serverMode: prefs.serverMode,
        });
      }

      // ── Step 6: Print server mode instructions ─────────────────────────────
      if (prefs.serverMode) {
        printServerModeInstructions(port, cfg.proxySecret);
      }
    });
}

// ─── Interactive preferences ─────────────────────────────────────────────────

async function askRunPreferences(): Promise<RunPreferences> {
  console.log(chalk.bold(`\n${"━".repeat(40)}\n  First-time setup\n${"━".repeat(40)}\n`));

  const mode = await select({
    message: "How do you want to run CC-Router?",
    choices: [
      { name: "In the background  (recommended — runs silently, auto-restarts)", value: "background" as const },
      { name: "In the foreground  (stays in this terminal, Ctrl+C to stop)", value: "foreground" as const },
    ],
  });

  let autoStart = false;
  if (mode === "background") {
    autoStart = await confirm({
      message: "Start automatically when your computer boots?",
      default: true,
    });
  }

  const serverMode = await confirm({
    message: "Will this machine serve other devices on the network? (server mode)",
    default: false,
  });

  // For local (non-server) mode, ask about auto-configuring Claude Code
  let configureClaudeCode = true;
  if (!serverMode) {
    configureClaudeCode = await confirm({
      message: "Configure Claude Code to use the proxy automatically? (recommended)",
      default: true,
    });
  }

  const prefs: RunPreferences = {
    mode: autoStart ? "service" : mode,
    serverMode,
    port: PROXY_PORT,
    configureClaudeCode,
  };

  console.log(chalk.green(`\n  ✓ Preferences saved. Next time 'cc-router start' will use these automatically.`));
  console.log(chalk.gray(`    Change anytime with: cc-router start --reconfigure\n`));

  return prefs;
}

async function maybeSetupPassword(cfg: ReturnType<typeof readConfig>): Promise<void> {
  console.log(chalk.yellow(
    "\n  Server mode binds the proxy to the network. A password is REQUIRED —" +
    "\n  without it, anyone who can reach the port could use your accounts.\n",
  ));

  const pwChoice = await select({
    message: "Set a proxy password?",
    choices: [
      { name: "Generate automatically  (recommended)", value: "generate" },
      { name: "Enter my own password", value: "manual" },
    ],
  });

  if (pwChoice === "manual") {
    const raw = await passwordPrompt({
      message: "Enter proxy password:",
      validate: (v) => v.trim().length >= 8 || "Minimum 8 characters",
    });
    cfg.proxySecret = raw.trim();
    writeConfig(cfg);
    console.log(chalk.green("  ✓ Password saved.\n"));
    return;
  }

  const secret = generateProxySecret();
  cfg.proxySecret = secret;
  writeConfig(cfg);
  console.log(chalk.yellow("\n  *** Save this password — you cannot recover it later ***"));
  console.log("      " + chalk.bold(secret));
  console.log(chalk.gray("  Clients will need this to connect.\n"));
}

async function ensureClaudeCodeConfigured(
  prefs: RunPreferences,
  cfg: ReturnType<typeof readConfig>,
): Promise<void> {
  // Skip if user opted out (server mode always skips — clients configure themselves)
  if (prefs.configureClaudeCode === false || prefs.serverMode) return;

  try {
    const { readClaudeProxySettings } = await import("../utils/claude-config.js");
    const current = readClaudeProxySettings();
    if (current.baseUrl) return; // already configured

    writeClaudeSettings(prefs.port, `http://localhost:${prefs.port}`);
    console.log(chalk.green("  ✓ Claude Code configured to use the proxy"));
  } catch (err) {
    console.warn(chalk.yellow(`  ⚠ Could not configure Claude Code: ${(err as Error).message}`));
    console.warn(chalk.gray(`    Configure manually: cc-router configure`));
  }
}

// ─── Update check ────────────────────────────────────────────────────────────

async function maybeUpdate(): Promise<void> {
  let check;
  try {
    check = await checkForUpdate(true);  // force fresh check, skip disk cache
    if (!check.updateAvailable) return;
  } catch {
    return; // network check is non-critical
  }

  // From here, errors should be visible
  if (check.diff === "major") {
    console.log(chalk.yellow(`\n  New major version available: v${check.current} → v${check.latest}`));
    console.log(chalk.gray(`  Update manually: npm i -g ai-cc-router@${check.latest}\n`));
    return;
  }

  console.log(chalk.cyan(`\n  Update available: v${check.current} → v${check.latest} (${check.diff})`));
  const doUpdate = await confirm({
    message: "Update now?",
    default: true,
  });
  if (!doUpdate) return;

  try {
    const ok = await performUpdate(check.latest);
    if (ok) {
      console.log(chalk.green("  ✓ Updated. Restarting with new version...\n"));
      const { spawn } = await import("child_process");
      const child = spawn(process.execPath, process.argv.slice(1), {
        stdio: "inherit",
        env: process.env,
      });
      child.on("exit", (code) => process.exit(code ?? 0));
      child.on("error", (err) => {
        console.error(chalk.red(`  Failed to restart after update: ${err.message}`));
        process.exit(1);
      });
      await new Promise(() => {});
    }
  } catch (err) {
    console.error(chalk.yellow(`  ⚠ Update failed: ${(err as Error).message}`));
    console.log(chalk.gray("  Continuing with current version.\n"));
  }
}

// ─── Server mode instructions ────────────────────────────────────────────────

function printServerModeInstructions(port: number, secret?: string): void {
  const ips = getLocalIPs();
  const ip = ips[0] ?? "<your-ip>";

  console.log(chalk.bold.cyan(`\n  ┌${"─".repeat(56)}┐`));
  console.log(chalk.bold.cyan(`  │  Server mode active — clients can connect with:      │`));
  console.log(chalk.bold.cyan(`  ├${"─".repeat(56)}┤`));
  console.log(chalk.cyan(`  │                                                        │`));
  console.log(chalk.cyan(`  │  ${chalk.white(`cc-router client connect http://${ip}:${port}`)}${" ".repeat(Math.max(0, 38 - ip.length - String(port).length))}│`));
  if (secret) {
    console.log(chalk.cyan(`  │    ${chalk.gray(`--secret ${secret}`)}${" ".repeat(Math.max(0, 43 - secret.length))}│`));
  }
  console.log(chalk.cyan(`  │                                                        │`));
  console.log(chalk.cyan(`  │  Or manually in ~/.claude/settings.json:               │`));
  console.log(chalk.cyan(`  │  ${chalk.gray(`{`)}                                                     │`));
  console.log(chalk.cyan(`  │    ${chalk.gray(`"env": {`)}                                             │`));
  console.log(chalk.cyan(`  │      ${chalk.gray(`"ANTHROPIC_BASE_URL": "http://${ip}:${port}"`)}${" ".repeat(Math.max(0, 30 - ip.length - String(port).length))}│`));
  if (secret) {
    console.log(chalk.cyan(`  │      ${chalk.gray(`"ANTHROPIC_AUTH_TOKEN": "${secret}"`)}${" ".repeat(Math.max(0, 30 - secret.length))}│`));
  } else {
    console.log(chalk.cyan(`  │      ${chalk.gray(`"ANTHROPIC_AUTH_TOKEN": "proxy-managed"`)}            │`));
  }
  console.log(chalk.cyan(`  │    ${chalk.gray(`}`)}                                                    │`));
  console.log(chalk.cyan(`  │  ${chalk.gray(`}`)}                                                      │`));
  console.log(chalk.bold.cyan(`  └${"─".repeat(56)}┘\n`));

  // Plaintext-HTTP warning: the proxy speaks HTTP only. Over a non-loopback
  // link the proxy secret and every prompt/response travel in the clear.
  console.log(chalk.yellow.bold("  ⚠ This link is plain HTTP — not encrypted."));
  console.log(chalk.yellow(
    `    The password above and all prompts/responses are sent in cleartext and\n` +
    `    can be read by anyone on the network path. For anything beyond a trusted\n` +
    `    LAN, put CC-Router behind a TLS-terminating reverse proxy (Caddy, nginx,\n` +
    `    Cloudflare Tunnel) and hand clients the https:// URL.\n` +
    `    See: docs/security.md → "Transport security (TLS)".\n`,
  ));
}

// ─── Foreground start (direct server import) ────────────────────────────────

async function startForeground(opts: {
  port: string;
  litellm?: string | boolean;
  accounts: string;
}): Promise<void> {
  const litellmUrl = opts.litellm
    ? (typeof opts.litellm === "string" ? opts.litellm : `http://localhost:${LITELLM_PORT}`)
    : undefined;

  if (opts.litellm && typeof opts.litellm !== "string") {
    await ensureLiteLLMRunning();
  }

  // Apply server mode env if configured
  const cfg = readConfig();
  if (cfg.runPreferences?.serverMode && !process.env["HOST"]) {
    process.env["HOST"] = "0.0.0.0";
  }

  const { startServer } = await import("../proxy/server.js");
  await startServer({
    port: parseInt(opts.port, 10),
    litellmUrl,
    accountsPath: opts.accounts !== ACCOUNTS_PATH ? opts.accounts : undefined,
  });
}

// ─── LiteLLM Docker helper ──────────────────────────────────────────────────

async function ensureLiteLLMRunning(): Promise<void> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const litellmUrl = `http://localhost:${LITELLM_PORT}`;
  try {
    const res = await fetch(`${litellmUrl}/health`, { signal: AbortSignal.timeout(1_000) });
    if (res.ok) {
      console.log(chalk.green(`✓ LiteLLM already running at ${litellmUrl}`));
      return;
    }
  } catch { /* not running */ }

  console.log(chalk.cyan("Starting LiteLLM via Docker..."));
  try {
    await execFileAsync("docker", ["info"]);
  } catch {
    console.error(chalk.red("✗ Docker is not running. Start Docker Desktop first."));
    console.error(chalk.gray("  Or pass a custom LiteLLM URL: cc-router start --litellm http://your-host:4000"));
    process.exit(1);
  }

  try {
    const { spawn } = await import("child_process");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["compose", "up", "-d", "litellm"], { stdio: "inherit" });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    });
    console.log(chalk.green(`✓ LiteLLM starting at ${litellmUrl}/ui`));
  } catch (err) {
    console.error(chalk.red("✗ Failed to start LiteLLM:"), (err as Error).message);
    process.exit(1);
  }
}
