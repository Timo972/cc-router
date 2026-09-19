import type { Command } from "commander";
import { select, input, confirm, password } from "@inquirer/prompts";
import chalk from "chalk";
import { detectPlatform, isMacos } from "../utils/platform.js";
import { writeClaudeSettings, readClaudeProxySettings } from "../utils/claude-config.js";
import { saveAccounts } from "../proxy/token-refresher.js";
import { loadAccounts, accountsFileExists, readConfig, writeConfig, generateProxySecret, type ClientConfig } from "../config/manager.js";
import { PROXY_PORT } from "../config/paths.js";
import type { Account } from "../proxy/types.js";
import { existsSync } from "fs";
import {
  checkMitmproxyInstalled,
  isCaCertInstalled,
  generateCaCert,
  installCaCert,
  writeAddonScript,
  getNetworkExtensionStatus,
  openNetworkExtensionSettings,
} from "../interceptor/mitmproxy-manager.js";
import { printDesktopSupportExplainer, printNetworkExtensionInstructions } from "./cmd-client.js";
import { collectClaudeAccount } from "./account-flows.js";
import { accountToRecord } from "./account-flows.js";
import { addAccountRuntimeAware, isAccountApiReachable, tryAddAccountToRunningProxy } from "./cmd-accounts.js";
import {
  withSetupTelemetryFlush,
  type SetupAttempt,
  type SetupFailureOutcome,
} from "../telemetry/setup-diagnostics.js";

// ─── Public registration ──────────────────────────────────────────────────────

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Interactive wizard: extract tokens and configure Claude Code automatically")
    .option("--add", "Add a new account to an existing configuration (skip intro questions)")
    .action(async (opts: { add?: boolean }) => {
      await withSetupTelemetryFlush(() => runSetupWizard({ addMode: opts.add ?? false }));
    });
}

/** Only an unexpected failure gets a diagnostic ID worth quoting in a bug report. */
function printDiagnosticId(outcome: SetupFailureOutcome): void {
  if (!outcome.unexpected) return;
  console.log(chalk.gray(`  Diagnostic ID: ${outcome.diagnosticId}`));
}

// ─── Full wizard ──────────────────────────────────────────────────────────────

export async function runSetupWizard({ addMode }: { addMode: boolean }): Promise<void> {
  const platform = detectPlatform();
  const hasExisting = accountsFileExists();
  const existingClient = readConfig().client;

  printBanner();
  console.log(chalk.gray(`Platform: ${platform}\n`));

  // ── Mode selection (only when nothing is configured yet) ─────────────────
  // If there are no accounts and no existing client config, ask whether the
  // user wants to host cc-router (server mode) or connect to an existing one
  // (client mode). In client mode we skip account setup entirely.
  if (!hasExisting && !existingClient && !addMode) {
    const mode = await select({
      message: "What do you want to do?",
      choices: [
        {
          name: "Host CC-Router on this machine  (manage tokens and accounts here)",
          value: "server" as const,
        },
        {
          name: "Connect to an existing CC-Router server  (client mode)",
          value: "client" as const,
        },
      ],
    });

    if (mode === "client") {
      await runClientSetupFromWizard();
      return;
    }
  }

  let replaceExisting = false;
  let includeExisting = addMode;
  if (hasExisting && !addMode) {
    const existing = loadAccounts();
    console.log(chalk.yellow(`  Found ${existing.length} existing account(s).\n`));
    const action = await select({
      message: "What do you want to do?",
      choices: [
        { name: "Add more accounts to the existing configuration", value: "add" },
        { name: "Start fresh (replace all accounts)", value: "replace" },
        { name: "Cancel", value: "cancel" },
      ],
    });
    if (action === "cancel") {
      console.log(chalk.gray("\nCancelled.\n"));
      return;
    }
    if (action === "replace") {
      const sure = await confirm({
        message: chalk.red("This will delete all existing accounts. Are you sure?"),
        default: false,
      });
      if (!sure) { console.log(chalk.gray("\nCancelled.\n")); return; }
      replaceExisting = true;
    } else {
      includeExisting = true;
    }
  }

  let numAccounts = 1;
  if (!addMode) {
    console.log(chalk.gray("  Tip: each account can be signed in directly with the browser method — no logging Claude Code out between them.\n"));
    const { number } = await import("@inquirer/prompts");
    numAccounts = await number({
      message: "How many accounts do you want to configure now?",
      default: 1,
      min: 1,
      max: 20,
    }) ?? 1;
  }

  const newAccounts: Account[] = [];
  const savedAttempts: SetupAttempt[] = [];

  for (let i = 0; i < numAccounts; i++) {
    const label = numAccounts > 1 ? `${i + 1}/${numAccounts}` : "";
    console.log(chalk.bold(`\n${"━".repeat(40)}\n  Account ${label}\n${"━".repeat(40)}\n`));

    const existingCount = hasExisting ? loadAccounts().length : 0;
    const { account, attempt } = await collectClaudeAccount({ index: i + 1 + existingCount });
    if (account) {
      newAccounts.push(account);
      savedAttempts.push(attempt);
      console.log(chalk.green(`\n  ✓ Account "${account.id}" ready.\n`));
    } else {
      console.log(chalk.yellow(`  ↷ Skipped account ${i + 1}.\n`));
    }
  }

  if (newAccounts.length === 0) {
    console.log(chalk.red("\n✗ No accounts configured. Run cc-router setup again.\n"));
    return;
  }

  // Merge: existing accounts minus any overwritten by ID, plus new ones
  const existingAccounts = hasExisting && includeExisting ? loadAccounts() : [];
  const merged = [
    ...existingAccounts.filter(a => !newAccounts.some(n => n.id === a.id)),
    ...newAccounts,
  ];

  console.log(chalk.bold(`\n${"━".repeat(40)}\n  Saving\n${"━".repeat(40)}\n`));

  let persistenceMode: "live" | "stored";
  try {
    persistenceMode = await persistSetupAccountsRuntimeAware({
      newAccounts,
      merged,
      replaceExisting,
    });
  } catch (error) {
    const outcomes = savedAttempts.map(attempt => attempt.failed(error, "persistence"));
    if (outcomes[0]) printDiagnosticId(outcomes[0]);
    throw error;
  }
  console.log(chalk.green(`  ✓ ${merged.length} account(s) saved to ~/.cc-router/accounts.json`));
  if (persistenceMode === "live") {
    console.log(chalk.gray("  Loaded into the running proxy — available now, no restart needed."));
  }

  for (const attempt of savedAttempts) {
    attempt.stageCompleted("persistence");
    attempt.succeeded();
  }

  // ─── Post-setup interactive flow ─────────────────────────────────────────
  await runPostSetupFlow(merged.length);
}

export interface SetupAccountPersistenceDependencies {
  isLive(): Promise<boolean>;
  tryAddLive(record: ReturnType<typeof accountToRecord>): Promise<boolean>;
  saveStored(accounts: Account[]): void;
}

export async function persistSetupAccountsRuntimeAware(
  input: { newAccounts: Account[]; merged: Account[]; replaceExisting: boolean },
  dependencies: SetupAccountPersistenceDependencies = {
    isLive: isAccountApiReachable,
    // The wizard merges by id, so a re-collected account must upsert live the
    // way `saveAccounts(merged)` upserts on disk; without `replace` the daemon
    // answers 409 and discards the login the operator just completed.
    tryAddLive: live => tryAddAccountToRunningProxy(live, { replace: true }),
    saveStored: saveAccounts,
  },
): Promise<"live" | "stored"> {
  if (input.replaceExisting) {
    if (await dependencies.isLive()) {
      throw new Error(
        "Cannot replace all accounts while the proxy is running. Stop it first: cc-router stop --keep-config",
      );
    }
    dependencies.saveStored(input.merged);
    return "stored";
  }
  for (const account of input.newAccounts) {
    const { mode } = await addAccountRuntimeAware(accountToRecord(account), {
      tryAddLive: dependencies.tryAddLive,
      addStored: () => dependencies.saveStored(input.merged),
    });
    if (mode === "stored") return "stored";
  }
  return "live";
}

// ─── Post-setup interactive flow ─────────────────────────────────────────────

async function runPostSetupFlow(accountCount: number): Promise<void> {
  console.log(chalk.bold(`\n${"━".repeat(40)}\n  Configure this machine\n${"━".repeat(40)}\n`));

  // 1. Configure Claude Code on this machine
  const currentSettings = readClaudeProxySettings();
  const alreadyConfigured = currentSettings.baseUrl?.includes("localhost");

  const configureLocal = await confirm({
    message: alreadyConfigured
      ? `Claude Code is already pointing to ${currentSettings.baseUrl}. Reconfigure?`
      : "Configure Claude Code on this machine to use the proxy?",
    default: true,
  });

  if (configureLocal) {
    // Ask if this is a local proxy or a remote one
    const proxyLocation = await select({
      message: "Where will cc-router run?",
      choices: [
        { name: `On this machine  (localhost:${PROXY_PORT})`, value: "local" },
        { name: "On another machine / VPS  (I'll enter the address)", value: "remote" },
      ],
    });

    let proxyHost = `http://localhost:${PROXY_PORT}`;

    if (proxyLocation === "remote") {
      const remoteHost = await input({
        message: "Proxy URL (e.g. http://192.168.1.50:3456 or https://cc-router.example.com):",
        validate: (v) => {
          try { new URL(v); return true; }
          catch { return "Enter a valid URL (http:// or https://)"; }
        },
      });
      proxyHost = remoteHost.replace(/\/$/, ""); // strip trailing slash
    }

    const port = proxyLocation === "local"
      ? PROXY_PORT
      : parseInt(new URL(proxyHost).port || "80", 10);

    // ── Password setup for remote proxy ───────────────────────────────────────
    if (proxyLocation === "remote") {
      const pwChoice = await select({
        message: "Set a proxy password? (strongly recommended for internet-exposed proxies)",
        choices: [
          { name: "Generate automatically  (recommended)", value: "generate" },
          { name: "Enter my own password",                 value: "manual" },
          { name: "Skip — no password protection",         value: "skip" },
        ],
      });

      let chosenSecret: string | undefined;

      if (pwChoice === "generate") {
        chosenSecret = generateProxySecret();
        writeConfig({ ...readConfig(), proxySecret: chosenSecret });
      } else if (pwChoice === "manual") {
        const raw = await password({
          message: "Enter proxy password:",
          validate: (v) => v.trim().length >= 8 || "Minimum 8 characters",
        });
        chosenSecret = raw.trim();
        writeConfig({ ...readConfig(), proxySecret: chosenSecret });
      }

      writeClaudeSettings(port, proxyHost);

      if (chosenSecret) {
        console.log(chalk.yellow("\n  *** Save this password — you cannot recover it later ***"));
        console.log("      " + chalk.bold(chosenSecret));
        console.log(chalk.gray("  Claude Code has been configured to use it automatically."));
        console.log(chalk.gray("  Other machines: cc-router configure --set-password <value>"));
      } else {
        console.log(chalk.green(`\n  ✓ ~/.claude/settings.json updated`));
        console.log(chalk.gray(`      ANTHROPIC_BASE_URL  = ${proxyHost}`));
        console.log(chalk.gray(`      ANTHROPIC_AUTH_TOKEN = proxy-managed`));
      }

      console.log(chalk.cyan(`\n  On the remote machine, start cc-router with:`));
      console.log(chalk.white(`    HOST=0.0.0.0 cc-router start`));
      console.log(chalk.cyan(`  Or as a service:`));
      console.log(chalk.white(`    cc-router service install\n`));
      // Nothing more to do on this machine
      printDone(accountCount);
      return;
    }

    writeClaudeSettings(port, proxyHost);
    console.log(chalk.green(`\n  ✓ ~/.claude/settings.json updated`));
    console.log(chalk.gray(`      ANTHROPIC_BASE_URL  = ${proxyHost}`));
    console.log(chalk.gray(`      ANTHROPIC_AUTH_TOKEN = proxy-managed`));
  }

  printDone(accountCount);
}


// ─── Done banner ──────────────────────────────────────────────────────────────

function printDone(accountCount: number): void {
  console.log(chalk.bold(`\n${"━".repeat(40)}\n  All done — ${accountCount} account(s) ready\n${"━".repeat(40)}\n`));
  console.log(`  Start the proxy:   ${chalk.cyan("cc-router start")}`);
  console.log(`  Add more accounts: ${chalk.cyan("cc-router accounts login")} or ${chalk.cyan("cc-router setup --add")}`);
  console.log(`  Dashboard:         ${chalk.cyan("cc-router status")}\n`);
}

// ─── Client-mode setup (from wizard) ─────────────────────────────────────────

async function runClientSetupFromWizard(): Promise<void> {
  console.log(chalk.bold("\n🔗 Client Mode — Connect to a CC-Router server\n"));

  const rawUrl = await input({
    message: "CC-Router server URL (e.g. 192.168.1.50:3456):",
  });
  let url = rawUrl.trim().replace(/\/+$/, "");
  if (!url.startsWith("http://") && !url.startsWith("https://")) url = `http://${url}`;

  const secret =
    (await input({
      message: "Proxy secret (leave empty if none):",
      transformer: (v) => (v ? "•".repeat(v.length) : ""),
    })) || undefined;

  // Test connection
  console.log(chalk.gray(`\nTesting connection to ${url}...`));
  let accounts: number | undefined;
  try {
    const headers: Record<string, string> = {};
    if (secret) headers["authorization"] = `Bearer ${secret}`;
    const res = await fetch(`${url}/cc-router/health`, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { status?: string; accounts?: unknown[] };
    accounts = data.accounts?.length;
    console.log(chalk.green(`✓ Connected — ${accounts ?? "?"} accounts on server\n`));
  } catch (e) {
    console.error(chalk.red(`\n✗ Cannot reach CC-Router at ${url}`));
    console.error(chalk.yellow(`  Error: ${(e as Error).message}`));
    console.error(chalk.gray("  Make sure the server is running and the URL is correct.\n"));
    process.exit(1);
  }

  // Save config
  const clientCfg: ClientConfig = { remoteUrl: url };
  if (secret) clientCfg.remoteSecret = secret;
  writeConfig({ ...readConfig(), client: clientCfg });

  // Configure Claude Code
  writeClaudeSettings(0, url, secret ?? "proxy-managed");
  console.log(chalk.green("✓ Claude Code configured"));
  console.log(chalk.gray(`  ANTHROPIC_BASE_URL → ${url}\n`));

  // ── Claude Desktop (Cowork / Agent mode) ─────────────────────────────────
  const desktopInstalled = isMacos() && existsSync("/Applications/Claude.app");
  if (desktopInstalled) {
    printDesktopSupportExplainer();
    const wantsDesktop = await confirm({
      message: "Route Claude Desktop's Cowork / Agent-mode traffic through CC-Router?",
      default: false,
    });
    if (wantsDesktop) {
      await setupDesktopFromWizard(url, secret);
      const current = readConfig();
      if (current.client) {
        current.client = { ...current.client, desktopEnabled: true };
        writeConfig(current);
      }
    }
  }

  console.log(chalk.bold.green(`\n${"━".repeat(40)}\n  Client mode active\n${"━".repeat(40)}\n`));
  console.log(`  Check status:       ${chalk.cyan("cc-router client status")}`);
  console.log(`  Disconnect:         ${chalk.cyan("cc-router client disconnect")}`);
  if (readConfig().client?.desktopEnabled) {
    console.log(`  Start Desktop:      ${chalk.cyan("cc-router client start-desktop")}`);
  }
  console.log();
}

async function setupDesktopFromWizard(target: string, secret?: string): Promise<void> {
  console.log(chalk.bold("\n🖥  Claude Desktop — Cowork / Agent Setup\n"));

  // 1. Check mitmproxy
  if (!(await checkMitmproxyInstalled())) {
    console.log(chalk.yellow("mitmproxy is required but not installed."));
    if (isMacos()) {
      console.log(chalk.cyan("  Install:  brew install mitmproxy\n"));
    } else {
      console.log(chalk.cyan("  Install:  pip install mitmproxy\n"));
    }
    const proceed = await confirm({ message: "Have you installed mitmproxy now?", default: false });
    if (!proceed || !(await checkMitmproxyInstalled())) {
      console.log(chalk.red("Skipping Desktop setup. Re-run with: cc-router client start-desktop\n"));
      return;
    }
  }
  console.log(chalk.green("✓ mitmproxy found"));

  // 2. CA cert
  if (!isCaCertInstalled()) {
    console.log(chalk.gray("Generating mitmproxy CA certificate (one-time)..."));
    try {
      await generateCaCert();
      console.log(chalk.green("✓ CA certificate generated"));
    } catch (e) {
      console.log(chalk.red(`✗ CA generation failed: ${(e as Error).message}`));
      return;
    }
  } else {
    console.log(chalk.green("✓ CA certificate already present"));
  }

  console.log(chalk.yellow("\nThe CA certificate must be installed in your OS trust store (requires admin)."));
  const doInstall = await confirm({ message: "Install CA certificate now?", default: true });
  if (doInstall) {
    const ok = await installCaCert();
    if (ok) {
      console.log(chalk.green("✓ CA certificate installed in system trust store"));
    } else {
      console.log(chalk.red("✗ CA install failed."));
      console.log(chalk.gray("  Install manually: sudo security add-trusted-cert -d -r trustRoot \\"));
      console.log(chalk.gray("    -k /Library/Keychains/System.keychain ~/.mitmproxy/mitmproxy-ca-cert.pem"));
    }
  }

  // 3. Addon (with secret so intercepted requests authenticate against the proxy)
  writeAddonScript(target, secret);
  console.log(chalk.green("✓ Redirect addon configured"));

  // 4. Network Extension walkthrough (macOS)
  if (isMacos()) {
    printNetworkExtensionInstructions();

    const status = await getNetworkExtensionStatus();
    if (status === "not_installed") {
      console.log(chalk.gray(
        "  The extension will be installed on first `cc-router client start-desktop`.\n" +
        "  macOS will show a popup — follow the steps above to approve it.\n"
      ));
    } else if (status === "waiting") {
      console.log(chalk.red("  ⚠  Extension is installed but NOT approved.\n"));
      const openNow = await confirm({ message: "Open System Settings to approve it now?", default: true });
      if (openNow) {
        await openNetworkExtensionSettings();
        console.log(chalk.gray("  System Settings should be open. Toggle 'Mitmproxy Redirector' ON.\n"));
        await confirm({ message: "Done? Press Enter when the toggle is ON", default: true });
        const newStatus = await getNetworkExtensionStatus();
        console.log(newStatus === "enabled"
          ? chalk.green("  ✓ Network Extension enabled")
          : chalk.yellow(`  Still not enabled (status: ${newStatus}) — you can fix later`)
        );
      }
    } else if (status === "enabled") {
      console.log(chalk.green("  ✓ Network Extension already enabled — you're all set\n"));
    }

    // Remind to restart Claude Desktop
    console.log(chalk.bold.yellow("  Remember:"));
    console.log(chalk.gray("  After starting the interceptor, " + chalk.bold("quit and relaunch Claude Desktop") + " (⌘Q)"));
    console.log(chalk.gray("  so mitmproxy can hook into the new process.\n"));
  }
}

function printBanner(): void {
  console.log(chalk.cyan(
    "\n╔══════════════════════════════════════════╗\n" +
    "║  CC-Router — Setup                       ║\n" +
    "╚══════════════════════════════════════════╝\n"
  ));
}
