import type { Command } from "commander";
import { select, input, confirm, password } from "@inquirer/prompts";
import chalk from "chalk";
import { detectPlatform, isMacos } from "../utils/platform.js";
import {
  extractFromKeychainDetailed,
  extractFromCredentialsFileDetailed,
  formatExpiry,
  redactToken,
  type CredentialExtractionResult,
} from "../utils/token-extractor.js";
import { validateToken, type ValidationResult } from "../utils/token-validator.js";
import { writeClaudeSettings, readClaudeProxySettings } from "../utils/claude-config.js";
import { saveAccounts } from "../proxy/token-refresher.js";
import {
  loadAccounts,
  accountsFileExists,
  readAccountStateDetailed,
  readConfig,
  writeConfig,
  generateProxySecret,
  type AccountStateReadResult,
  type ClientConfig,
} from "../config/manager.js";
import { PROXY_PORT } from "../config/paths.js";
import type { Account, OAuthTokens } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS, ACCOUNT_USER_DEFAULTS } from "../proxy/types.js";
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
import {
  SetupDiagnosticError,
  classifyAccountStateReadFailure,
  createSetupAttempt,
  isPromptCancellation,
  persistSetupAttempts,
  type CreateSetupAttemptInput,
  type SetupAttempt,
  withSetupTelemetryFlush,
} from "../telemetry/setup-diagnostics.js";
import { flushTelemetryWithin } from "../telemetry/facade.js";

// ─── Public registration ──────────────────────────────────────────────────────

export interface SetupCommandDependencies {
  runWizard(options: { addMode: boolean }): Promise<number | undefined>;
  flush(deadlineMs: number): Promise<void>;
}

const defaultSetupCommandDependencies: SetupCommandDependencies = {
  runWizard: runSetupWizard,
  flush: flushTelemetryWithin,
};

export async function runSetupCommand(
  options: { addMode: boolean },
  dependencies: SetupCommandDependencies = defaultSetupCommandDependencies,
): Promise<void> {
  const exitCode = await withSetupTelemetryFlush(
    () => dependencies.runWizard(options),
    dependencies.flush,
  );
  if (exitCode !== undefined && exitCode !== 0) process.exitCode = exitCode;
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Interactive wizard: extract tokens and configure Claude Code automatically")
    .option("--add", "Add a new account to an existing configuration (skip intro questions)")
    .action(async (opts: { add?: boolean }) => {
      await runSetupCommand({ addMode: opts.add ?? false });
    });
}

// ─── Shared single-account setup (also used by `accounts add`) ───────────────

type ExtractionMethod = "keychain" | "credentials" | "manual";

export interface SetupSingleAccountDependencies {
  chooseMethod(): Promise<ExtractionMethod>;
  extractKeychain(): Promise<CredentialExtractionResult>;
  extractCredentials(): CredentialExtractionResult;
  promptManualTokens(): Promise<OAuthTokens | null>;
  promptAccountId(defaultId: string): Promise<string>;
  confirmRetry(kind: "keychain" | "credentials"): Promise<boolean>;
  confirmSaveInvalid(result: Extract<ValidationResult, { valid: false }>): Promise<boolean>;
  validateToken(accessToken: string): Promise<ValidationResult>;
  readAccountState(): AccountStateReadResult;
  createAttempt(input: Pick<CreateSetupAttemptInput, "provider" | "method">): SetupAttempt;
}

export interface SetupSingleAccountResult {
  account: Account | null;
  attempt: SetupAttempt;
}

async function chooseExtractionMethod(): Promise<ExtractionMethod> {
  const choices: { name: string; value: ExtractionMethod }[] = [];
  if (isMacos()) {
    choices.push({ name: "Extract automatically from macOS Keychain  (recommended)", value: "keychain" });
  }
  choices.push({ name: "Read from ~/.claude/.credentials.json", value: "credentials" });
  choices.push({ name: "Paste tokens manually", value: "manual" });
  return select<ExtractionMethod>({
    message: "How do you want to add the tokens?",
    choices,
  });
}

const defaultSetupSingleAccountDependencies: SetupSingleAccountDependencies = {
  chooseMethod: chooseExtractionMethod,
  extractKeychain: extractFromKeychainDetailed,
  extractCredentials: extractFromCredentialsFileDetailed,
  promptManualTokens,
  promptAccountId: defaultId => input({
    message: "Account ID (press Enter to accept default):",
    default: defaultId,
    validate: value => /^[a-zA-Z0-9_-]+$/.test(value) || "Only letters, numbers, _ and - allowed",
  }),
  confirmRetry: kind => confirm({
    message: kind === "keychain" ? "Try another extraction method?" : "Paste tokens manually instead?",
    default: true,
  }),
  confirmSaveInvalid: () => confirm({ message: "Save this account anyway?", default: false }),
  validateToken,
  readAccountState: readAccountStateDetailed,
  createAttempt: createSetupAttempt,
};

function telemetryMethod(method: ExtractionMethod): "macos_keychain" | "claude_credentials_file" | "manual_token" {
  switch (method) {
    case "keychain": return "macos_keychain";
    case "credentials": return "claude_credentials_file";
    case "manual": return "manual_token";
  }
}

function printUnexpectedSetupFailure(error: unknown, diagnosticId: string): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(`  Unexpected setup failure: ${detail}`));
  console.error(chalk.gray(`  Diagnostic ID: ${diagnosticId}`));
}

export async function setupSingleAccountDetailed(
  index: number,
  dependencies: SetupSingleAccountDependencies = defaultSetupSingleAccountDependencies,
): Promise<SetupSingleAccountResult> {
  const method = await dependencies.chooseMethod();
  const attempt = dependencies.createAttempt({ provider: "anthropic", method: telemetryMethod(method) });
  attempt.stageCompleted("credential_source_selection");
  let tokens: OAuthTokens | null = null;

  try {
    const state = dependencies.readAccountState();
    if (!state.ok) throw classifyAccountStateReadFailure(state.error);

    if (method === "keychain") {
      process.stdout.write(chalk.gray("  Extracting from Keychain... "));
      const extraction = await dependencies.extractKeychain();
      if (!extraction.ok) {
        console.log(chalk.red("✗"));
        console.log(chalk.yellow("  Could not read usable credentials from Keychain."));
        const retry = await dependencies.confirmRetry("keychain");
        if (retry) {
          const outcome = attempt.failed(extraction.error, extraction.error.classification.stage);
          if (outcome.unexpected) printUnexpectedSetupFailure(extraction.error, outcome.diagnosticId);
          return setupSingleAccountDetailed(index, dependencies);
        }
        const outcome = attempt.stageFailed(extraction.error, extraction.error.classification.stage);
        if (outcome.unexpected) printUnexpectedSetupFailure(extraction.error, outcome.diagnosticId);
        attempt.cancelled();
        return { account: null, attempt };
      }
      tokens = extraction.tokens;
      for (const stage of extraction.completedStages) attempt.stageCompleted(stage);
      console.log(chalk.green("✓"));
      console.log(chalk.gray(`  Token: ${redactToken(tokens.accessToken)}`));
      console.log(chalk.gray(`  Expiry: ${formatExpiry(tokens.expiresAt)}`));
    } else if (method === "credentials") {
      const extraction = dependencies.extractCredentials();
      if (!extraction.ok) {
        console.log(chalk.red("  ✗ ~/.claude/.credentials.json not found or unreadable."));
        const retry = await dependencies.confirmRetry("credentials");
        if (retry) {
          const outcome = attempt.failed(extraction.error, extraction.error.classification.stage);
          if (outcome.unexpected) printUnexpectedSetupFailure(extraction.error, outcome.diagnosticId);
          return setupSingleAccountDetailed(index, {
            ...dependencies,
            chooseMethod: async () => "manual",
          });
        }
        const outcome = attempt.stageFailed(extraction.error, extraction.error.classification.stage);
        if (outcome.unexpected) printUnexpectedSetupFailure(extraction.error, outcome.diagnosticId);
        attempt.cancelled();
        return { account: null, attempt };
      }
      tokens = extraction.tokens;
      for (const stage of extraction.completedStages) attempt.stageCompleted(stage);
      console.log(chalk.green("  ✓ Found Claude credentials"));
      console.log(chalk.gray(`    Token: ${redactToken(tokens.accessToken)}`));
      console.log(chalk.gray(`    Expiry: ${formatExpiry(tokens.expiresAt)}`));
    } else {
      tokens = await dependencies.promptManualTokens();
      if (!tokens) {
        attempt.cancelled();
        return { account: null, attempt };
      }
      attempt.stageCompleted("credential_read");
      attempt.stageCompleted("credential_parse");
    }

    const accountId = await dependencies.promptAccountId(`max-account-${index}`);
    process.stdout.write(chalk.gray("  Validating tokens against Anthropic... "));
    const validation = await dependencies.validateToken(tokens.accessToken);

    if (validation.valid) {
      attempt.stageCompleted("token_validation");
      console.log(chalk.green("✓ Valid"));
    } else {
      console.log(chalk.red("✗ Invalid"));
      console.log(chalk.yellow(`  Reason: ${validation.reason}`));
      const outcome = attempt.stageFailed(validation.diagnostic, "token_validation");
      if (outcome.unexpected) printUnexpectedSetupFailure(validation.diagnostic, outcome.diagnosticId);
      console.log(chalk.gray("  The token will be saved but may not work until refreshed."));
      const keepAnyway = await dependencies.confirmSaveInvalid(validation);
      if (!keepAnyway) {
        attempt.cancelled();
        return { account: null, attempt };
      }
    }

    return {
      account: {
        id: accountId,
        tokens,
        healthy: validation.valid,
        busy: false,
        requestCount: 0,
        errorCount: 0,
        lastUsed: 0,
        lastRefresh: 0,
        consecutiveErrors: 0,
        rateLimits: { ...DEFAULT_RATE_LIMITS },
        ...ACCOUNT_USER_DEFAULTS,
      },
      attempt,
    };
  } catch (error) {
    if (isPromptCancellation(error)) {
      attempt.cancelled();
      return { account: null, attempt };
    }
    const outcome = attempt.failed(error, "failure");
    if (outcome.unexpected) printUnexpectedSetupFailure(error, outcome.diagnosticId);
    throw error;
  }
}

export async function setupSingleAccount(index: number): Promise<Account | null> {
  return (await setupSingleAccountDetailed(index)).account;
}

// ─── Full wizard ──────────────────────────────────────────────────────────────

export async function runSetupWizard({ addMode }: { addMode: boolean }): Promise<number | undefined> {
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
      return runClientSetupFromWizard();
    }
  }

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
    }
  }

  if (!addMode && isMacos()) {
    console.log(chalk.cyan("  Tip: to add multiple accounts, you need to:"));
    console.log(chalk.gray("  1. Log in to Claude Code with account 1 (already done if you use CC normally)"));
    console.log(chalk.gray("  2. Extract tokens → log out → log in with account 2 → extract → repeat\n"));
  }

  let numAccounts = 1;
  if (!addMode) {
    const { number } = await import("@inquirer/prompts");
    numAccounts = await number({
      message: "How many accounts do you want to configure now?",
      default: 1,
      min: 1,
      max: 20,
    }) ?? 1;
  }

  const newAccounts: Account[] = [];
  const newAccountAttempts: SetupAttempt[] = [];

  for (let i = 0; i < numAccounts; i++) {
    const label = numAccounts > 1 ? `${i + 1}/${numAccounts}` : "";
    console.log(chalk.bold(`\n${"━".repeat(40)}\n  Account ${label}\n${"━".repeat(40)}\n`));

    if (i > 0 && isMacos()) {
      console.log(chalk.yellow(
        `  Before extracting account ${i + 1}:\n` +
        `  1. Run: ${chalk.white("claude logout")}\n` +
        `  2. Run: ${chalk.white("claude login")}  (log in with your next Max account)\n`
      ));
      await confirm({ message: "Ready?", default: true });
    }

    const existingCount = hasExisting ? loadAccounts().length : 0;
    const setup = await setupSingleAccountDetailed(i + 1 + existingCount);
    const account = setup.account;
    if (account) {
      newAccounts.push(account);
      newAccountAttempts.push(setup.attempt);
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
  const existingAccounts = (hasExisting && !addMode) ? [] : (hasExisting ? loadAccounts() : []);
  const merged = [
    ...existingAccounts.filter(a => !newAccounts.some(n => n.id === a.id)),
    ...newAccounts,
  ];

  console.log(chalk.bold(`\n${"━".repeat(40)}\n  Saving\n${"━".repeat(40)}\n`));

  try {
    await persistSetupAttempts(newAccountAttempts, () => saveAccounts(merged));
  } catch (error) {
    for (const attempt of newAccountAttempts) printUnexpectedSetupFailure(error, attempt.diagnosticId);
    throw error;
  }
  console.log(chalk.green(`  ✓ ${merged.length} account(s) saved to ~/.cc-router/accounts.json`));

  // ─── Post-setup interactive flow ─────────────────────────────────────────
  await runPostSetupFlow(merged.length);
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
  console.log(`  Add more accounts: ${chalk.cyan("cc-router setup --add")}`);
  console.log(`  Dashboard:         ${chalk.cyan("cc-router status")}\n`);
}

// ─── Manual token input ───────────────────────────────────────────────────────

export function parseManualTokenExpiry(raw: string): number {
  const value = raw.trim();
  const expiresAt = /^\d+$/.test(value)
    ? Number(value)
    : /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0 || Number.isNaN(new Date(expiresAt).getTime())) {
    throw new SetupDiagnosticError("expiresAt must be a valid ISO date or positive Unix millisecond timestamp", {
      stage: "credential_parse",
      reason: "malformed_credentials",
      expected: true,
    });
  }
  return expiresAt;
}

async function promptManualTokens(): Promise<OAuthTokens | null> {
  console.log(chalk.gray(
    "\n  You can find your tokens by running:\n" +
    "    macOS:         security find-generic-password -s 'Claude Code-credentials' -w\n" +
    "    Linux/Windows: cat ~/.claude/.credentials.json\n" +
    "    Missing or stale credentials: claude login\n"
  ));

  const accessToken = await password({
    message: "Paste accessToken (sk-ant-oat01-...):",
    mask: "•",
    validate: (v) =>
      v.startsWith("sk-ant-oat01-") || v.startsWith("sk-ant-")
        ? true
        : "Must start with sk-ant-oat01-",
  });

  const refreshToken = await password({
    message: "Paste refreshToken (sk-ant-ort01-...):",
    mask: "•",
    validate: (v) =>
      v.startsWith("sk-ant-ort01-") || v.startsWith("sk-ant-")
        ? true
        : "Must start with sk-ant-ort01-",
  });

  const useDefaultExpiry = await confirm({
    message: "Use default expiry (8 hours from now)?",
    default: true,
  });

  const expiresAt = useDefaultExpiry
    ? Date.now() + 8 * 60 * 60 * 1000
    : parseManualTokenExpiry(await input({ message: "Paste expiresAt (ISO date or ms timestamp):" }));

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scopes: ["user:inference", "user:profile"],
  };
}

// ─── Client-mode setup (from wizard) ─────────────────────────────────────────

export interface ClientSetupDependencies {
  promptServerUrl(): Promise<string>;
  promptSecret(): Promise<string>;
  fetchImpl: typeof fetch;
}

const defaultClientSetupDependencies: ClientSetupDependencies = {
  promptServerUrl: () => input({
    message: "CC-Router server URL (e.g. 192.168.1.50:3456):",
  }),
  promptSecret: () => input({
    message: "Proxy secret (leave empty if none):",
    transformer: (v) => (v ? "•".repeat(v.length) : ""),
  }),
  fetchImpl: (request, init) => fetch(request, init),
};

export async function runClientSetupFromWizard(
  dependencies: ClientSetupDependencies = defaultClientSetupDependencies,
): Promise<number | undefined> {
  console.log(chalk.bold("\n🔗 Client Mode — Connect to a CC-Router server\n"));

  const rawUrl = await dependencies.promptServerUrl();
  let url = rawUrl.trim().replace(/\/+$/, "");
  if (!url.startsWith("http://") && !url.startsWith("https://")) url = `http://${url}`;

  const secret = (await dependencies.promptSecret()) || undefined;

  // Test connection
  console.log(chalk.gray(`\nTesting connection to ${url}...`));
  let accounts: number | undefined;
  try {
    const headers: Record<string, string> = {};
    if (secret) headers["authorization"] = `Bearer ${secret}`;
    const res = await dependencies.fetchImpl(`${url}/cc-router/health`, {
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
    return 1;
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
