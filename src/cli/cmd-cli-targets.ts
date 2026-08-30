import type { Command } from "commander";
import chalk from "chalk";
import { readConfig } from "../config/manager.js";
import { PROXY_PORT } from "../config/paths.js";
import { isProxyRunning } from "../daemon/pid.js";
import {
  readClaudeRouting,
  readCodexRouting,
  setClaudeRouting,
  setCodexRouting,
} from "../utils/cli-routing.js";

interface TargetActionOpts {
  port?: string;
  model?: string;
  json?: boolean;
}

function configuredPort(): number {
  return readConfig().runPreferences?.port ?? PROXY_PORT;
}

function parsePort(opts: TargetActionOpts): number {
  return opts.port ? parseInt(opts.port, 10) : configuredPort();
}

async function warnIfProxyDown(port: number): Promise<void> {
  if (readConfig().client?.remoteUrl) return;
  if (await isProxyRunning(port)) return;
  console.log(chalk.yellow(`  Proxy is not running on port ${port}.`));
  console.log(chalk.gray("  Start it with: cc-router start"));
}

function printRestartHint(cliName: string): void {
  console.log(chalk.gray(`  Restart any running ${cliName} process to pick this up.`));
}

function printClaudeStatus(opts: { json?: boolean } = {}): void {
  const current = readClaudeRouting();
  if (opts.json) {
    console.log(JSON.stringify(current, null, 2));
    return;
  }
  if (current.enabled) {
    console.log(chalk.green("  Claude Code is routing through cc-router"));
    console.log(`    ANTHROPIC_BASE_URL  = ${chalk.cyan(current.baseUrl)}`);
    if (current.model) console.log(`    model               = ${current.model}`);
  } else {
    console.log(chalk.yellow("  Claude Code is using native Anthropic auth"));
    console.log(chalk.gray("  Enable with: cc-router cli claude start"));
  }
}

function printCodexStatus(opts: { json?: boolean } = {}): void {
  const current = readCodexRouting();
  if (opts.json) {
    console.log(JSON.stringify(current, null, 2));
    return;
  }
  if (current.enabled) {
    console.log(chalk.green("  Codex CLI is routing through cc-router"));
    if (current.baseUrl) console.log(`    base_url       = ${chalk.cyan(current.baseUrl)}`);
    console.log(`    model_provider = ${current.modelProvider ?? "cc-router"}`);
    if (current.model) console.log(`    model          = ${current.model}`);
  } else {
    console.log(chalk.yellow("  Codex CLI is using native OpenAI auth"));
    console.log(chalk.gray("  Enable with: cc-router cli codex start"));
  }
}

function printBothStatus(opts: { json?: boolean } = {}): void {
  if (opts.json) {
    console.log(JSON.stringify({
      claude: readClaudeRouting(),
      codex: readCodexRouting(),
    }, null, 2));
    return;
  }
  printClaudeStatus();
  console.log("");
  printCodexStatus();
}

async function enableClaude(opts: TargetActionOpts): Promise<void> {
  const port = parsePort(opts);
  const result = setClaudeRouting(true, { port, model: opts.model });
  console.log(chalk.green(`✓ Claude Code → ${result.baseUrl ?? "proxy"}`));
  if (opts.model) console.log(chalk.gray(`  model = ${opts.model}`));
  printRestartHint("Claude Code");
  await warnIfProxyDown(port);
}

function disableClaude(): void {
  const result = setClaudeRouting(false);
  if (!result.changed) {
    console.log(chalk.gray("  Claude Code is already using native Anthropic auth."));
    return;
  }
  console.log(chalk.green("✓ Claude Code → native Anthropic auth"));
  printRestartHint("Claude Code");
}

async function enableCodex(opts: TargetActionOpts): Promise<void> {
  const port = parsePort(opts);
  const result = setCodexRouting(true, { port, model: opts.model });
  console.log(chalk.green(`✓ Codex CLI → ${result.baseUrl ?? "proxy"}`));
  if (result.path) console.log(chalk.gray(`  config = ${result.path}`));
  if (opts.model) console.log(chalk.gray(`  model  = ${opts.model}`));
  printRestartHint("Codex");
  await warnIfProxyDown(port);
}

function disableCodex(): void {
  const result = setCodexRouting(false);
  if (!result.changed) {
    console.log(chalk.gray("  Codex CLI is already using native OpenAI auth."));
    return;
  }
  console.log(chalk.green("✓ Codex CLI → native OpenAI auth"));
  if (result.path) console.log(chalk.gray(`  removed managed block from ${result.path}`));
  printRestartHint("Codex");
}

function registerTargetCommands(
  parent: Command,
  spec: {
    startDescription: string;
    stopDescription: string;
    resumeDescription: string;
    statusDescription: string;
    enable: (opts: TargetActionOpts) => Promise<void>;
    disable: () => void;
    status: (opts: { json?: boolean }) => void;
  },
): void {
  const startOpts = (command: Command) => command
    .option("--port <port>", "Proxy port to point at")
    .option("--model <model>", "Optional default model for this CLI");

  startOpts(
    parent
      .command("start")
      .description(spec.startDescription),
  ).action(async (opts: TargetActionOpts) => {
    await spec.enable(opts);
  });

  parent
    .command("stop")
    .description(spec.stopDescription)
    .action(() => {
      spec.disable();
    });

  startOpts(
    parent
      .command("resume")
      .description(spec.resumeDescription),
  ).action(async (opts: TargetActionOpts) => {
    await spec.enable(opts);
  });

  parent
    .command("status", { isDefault: true })
    .description(spec.statusDescription)
    .option("--json", "Output current routing state as JSON")
    .action((opts: { json?: boolean }) => {
      spec.status(opts);
    });
}

const CLAUDE_SPEC = {
  startDescription: "Point Claude Code at the running proxy",
  stopDescription: "Restore Claude Code to native Anthropic auth (proxy keeps running)",
  resumeDescription: "Re-enable Claude Code routing (same as start)",
  statusDescription: "Show whether Claude Code is routing through the proxy",
  enable: enableClaude,
  disable: disableClaude,
  status: printClaudeStatus,
};

const CODEX_SPEC = {
  startDescription: "Point Codex CLI at the running proxy",
  stopDescription: "Restore Codex CLI to native OpenAI auth (proxy keeps running)",
  resumeDescription: "Re-enable Codex CLI routing (same as start)",
  statusDescription: "Show whether Codex CLI is routing through the proxy",
  enable: enableCodex,
  disable: disableCodex,
  status: printCodexStatus,
};

function registerClaudeAndCodex(parent: Command): void {
  registerTargetCommands(
    parent.command("claude").description("Claude Code routing"),
    CLAUDE_SPEC,
  );
  registerTargetCommands(
    parent.command("codex").description("Codex CLI routing"),
    CODEX_SPEC,
  );
}

export function registerCliTargets(program: Command): void {
  const cli = program
    .command("cli")
    .description("Enable or disable Claude Code / Codex routing without stopping the proxy");

  cli
    .command("status", { isDefault: true })
    .description("Show routing state for Claude Code and Codex CLI")
    .option("--json", "Output current routing state as JSON")
    .action((opts: { json?: boolean }) => {
      printBothStatus(opts);
    });

  registerClaudeAndCodex(cli);

  // Short aliases for on-the-fly use. Hidden so top-level help stays
  // `start`/`stop` = proxy and `cli` = per-CLI routing.
  registerTargetCommands(
    program.command("claude", { hidden: true }).description("Alias of cc-router cli claude"),
    CLAUDE_SPEC,
  );
  registerTargetCommands(
    program.command("codex", { hidden: true }).description("Alias of cc-router cli codex"),
    CODEX_SPEC,
  );
}
