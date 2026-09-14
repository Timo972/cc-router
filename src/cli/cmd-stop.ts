import type { Command } from "commander";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { removeClaudeSettings, readClaudeProxySettings } from "../utils/claude-config.js";
import { removeCodexRouterConfig, readCodexRouterConfig } from "../utils/codex-config.js";
import { PROXY_PORT } from "../config/paths.js";
import { stopDaemon } from "../daemon/launcher.js";
import { isProxyRunning } from "../daemon/pid.js";
import { isServiceInstalled, uninstallService } from "../daemon/service.js";
import { readConfig, writeConfig } from "../config/manager.js";

export function registerStop(program: Command): void {
  program
    .command("stop")
    .description("Stop the proxy and optionally clean up service / Claude Code config")
    .option("--keep-config", "Stop the proxy but keep all configuration")
    .option("--full", "Stop, remove auto-start, and revert Claude Code config (no prompts)")
    .action(async (opts: { keepConfig?: boolean; full?: boolean }) => {
      await stopProxy(opts);
    });
}

export function registerRevert(program: Command): void {
  program
    .command("revert")
    .description("Restore Claude Code to its normal authentication (removes proxy config)")
    .action(async () => {
      await stopProxy({ full: true });
    });
}

// ─── Core logic ──────────────────────────────────────────────────────────────

async function stopProxy(opts: { keepConfig?: boolean; full?: boolean }): Promise<void> {
  let anythingDone = false;

  // 1. Stop the proxy process
  const wasRunning = await isProxyRunning();
  if (wasRunning) {
    const stopped = await stopDaemon(PROXY_PORT);
    if (stopped) {
      console.log(chalk.green("✓ Proxy process stopped"));
      anythingDone = true;
    } else {
      console.log(chalk.yellow("⚠ Could not stop proxy automatically."));
      console.log(chalk.gray("  If it's running in a terminal, press Ctrl+C there."));
      console.log(chalk.gray(`  Or kill manually: kill $(lsof -ti:${PROXY_PORT})`));
    }
  } else {
    console.log(chalk.gray("  Proxy is not running."));
  }

  if (opts.keepConfig) {
    printDone(anythingDone);
    return;
  }

  // 2. Service cleanup
  const hasService = isServiceInstalled();
  if (hasService) {
    let removeService = opts.full ?? false;
    if (!opts.full) {
      removeService = await confirm({
        message: "CC-Router is configured to start on boot. Remove auto-start?",
        default: false,
      });
    }
    if (removeService) {
      await uninstallService();
      // Also clear the service preference so next `start` re-asks
      const cfg = readConfig();
      if (cfg.runPreferences?.mode === "service") {
        cfg.runPreferences.mode = "background";
        writeConfig(cfg);
      }
      anythingDone = true;
    }
  }

  // 3. Claude Code config cleanup
  const current = readClaudeProxySettings();
  if (current.baseUrl) {
    let removeSettings = opts.full ?? false;
    if (!opts.full) {
      removeSettings = await confirm({
        message: "Remove proxy settings from Claude Code? (Claude will use normal auth)",
        default: false,
      });
    }
    if (removeSettings) {
      removeClaudeSettings();
      console.log(chalk.green("✓ Removed proxy settings from ~/.claude/settings.json"));
      console.log(chalk.gray("  Claude Code will use its normal authentication on next launch."));
      anythingDone = true;
    }
  }

  // 4. Codex CLI config cleanup
  const codex = readCodexRouterConfig();
  if (codex.configured) {
    let removeCodex = opts.full ?? false;
    if (!opts.full) {
      removeCodex = await confirm({
        message: "Remove proxy settings from Codex CLI? (Codex will use native OpenAI auth)",
        default: false,
      });
    }
    if (removeCodex) {
      removeCodexRouterConfig();
      console.log(chalk.green(`✓ Removed proxy settings from ${codex.path}`));
      console.log(chalk.gray("  Codex CLI will use its native OpenAI authentication on next launch."));
      anythingDone = true;
    }
  }

  printDone(anythingDone);
}

function printDone(anythingDone: boolean): void {
  if (!anythingDone) {
    console.log(chalk.gray("\nNothing to do — proxy was not running and config was not set."));
  } else {
    console.log(chalk.green("\n✓ Done."));
    console.log(chalk.gray("  To re-enable: cc-router start"));
    console.log(chalk.gray("  To reconfigure: cc-router start --reconfigure\n"));
  }
}
