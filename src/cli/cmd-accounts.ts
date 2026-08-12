import type { Command } from "commander";
import chalk from "chalk";
import {
  loadAccounts,
  loadOpenAIAccounts,
  accountsFileExists,
  readAccountStateDetailed,
  upsertAccountRecord,
  removeAccountRecordById,
  readConfig,
  type AccountStateReadResult,
} from "../config/manager.js";
import { saveAccounts } from "../proxy/token-refresher.js";
import { formatExpiry, redactToken } from "../utils/token-extractor.js";
import { PROXY_PORT } from "../config/paths.js";
import {
  createOpenAIAccountRecord,
  type CreateOpenAIAccountRecordInput,
  type OpenAIAccountRecord,
} from "../providers/openai/account-record.js";
import {
  loginOpenAIWithDeviceCode,
  type LoginOpenAIWithDeviceCodeOptions,
  type OpenAIDeviceCode,
} from "../providers/openai/device-oauth.js";
import type { Account, AccountRecord } from "../proxy/types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import {
  createSetupAttempt,
  classifyAccountStateReadFailure,
  isPromptCancellation,
  persistSetupAttempts,
  type CreateSetupAttemptInput,
  type SetupAttempt,
  withSetupTelemetryFlush,
} from "../telemetry/setup-diagnostics.js";
import { flushTelemetryWithin } from "../telemetry/facade.js";

export interface OpenAIManualAccountSetupDependencies {
  collectInput(): Promise<CreateOpenAIAccountRecordInput>;
  persist(record: OpenAIAccountRecord): void;
  readAccountState(): AccountStateReadResult;
  createAttempt(input: Pick<CreateSetupAttemptInput, "provider" | "method">): SetupAttempt;
  flush(deadlineMs: number): Promise<void>;
}

export interface OpenAIDeviceAccountSetupDependencies {
  collectAccountId(): Promise<string>;
  login(options: LoginOpenAIWithDeviceCodeOptions): Promise<OpenAIAccountRecord>;
  onDeviceCode(code: OpenAIDeviceCode): void;
  persist(record: OpenAIAccountRecord): void;
  readAccountState(): AccountStateReadResult;
  createAttempt(input: Pick<CreateSetupAttemptInput, "provider" | "method">): SetupAttempt;
  flush(deadlineMs: number): Promise<void>;
}

function printSetupException(error: unknown, diagnosticId: string): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(`\n✗ ${detail}`));
  console.error(chalk.gray(`  Diagnostic ID: ${diagnosticId}`));
}

async function collectOpenAIManualInput(): Promise<CreateOpenAIAccountRecordInput> {
  const { input, password } = await import("@inquirer/prompts");
  const id = await input({
    message: "OpenAI account ID:",
    default: `openai-account-${loadOpenAIAccounts().length + 1}`,
    validate: value => /^[a-zA-Z0-9_-]+$/.test(value) || "Only letters, numbers, _ and - allowed",
  });
  const accessToken = await password({
    message: "OpenAI access token:",
    mask: "*",
    validate: value => value.trim().length > 0 || "Access token is required",
  });
  const refreshToken = await password({
    message: "OpenAI refresh token:",
    mask: "*",
    validate: value => value.trim().length > 0 || "Refresh token is required",
  });
  const expiresAt = await input({
    message: "Access token expiry (Unix ms):",
    default: String(Date.now() + 60 * 60 * 1000),
    validate: value => Number.isFinite(Number(value)) && Number(value) > 0
      || "Enter a positive Unix timestamp in milliseconds",
  });
  const scopes = await input({
    message: "Scopes:",
    default: "openid profile email offline_access",
  });
  return { id, accessToken, refreshToken, expiresAt, scopes };
}

const defaultOpenAIManualDependencies: OpenAIManualAccountSetupDependencies = {
  collectInput: collectOpenAIManualInput,
  persist: upsertAccountRecord,
  readAccountState: readAccountStateDetailed,
  createAttempt: createSetupAttempt,
  flush: flushTelemetryWithin,
};

export async function runOpenAIManualAccountSetup(
  dependencies: OpenAIManualAccountSetupDependencies = defaultOpenAIManualDependencies,
): Promise<OpenAIAccountRecord | null> {
  const attempt = dependencies.createAttempt({ provider: "openai", method: "manual_token" });
  attempt.stageCompleted("credential_source_selection");
  return withSetupTelemetryFlush(async () => {
    let record: OpenAIAccountRecord;
    try {
      const state = dependencies.readAccountState();
      if (!state.ok) throw classifyAccountStateReadFailure(state.error);
      const collected = await dependencies.collectInput();
      attempt.stageCompleted("credential_read");
      record = createOpenAIAccountRecord(collected);
      attempt.stageCompleted("credential_parse");
      attempt.stageCompleted("token_validation");
    } catch (error) {
      if (isPromptCancellation(error)) {
        attempt.cancelled();
        return null;
      }
      const outcome = attempt.failed(error, "credential_parse");
      if (outcome.unexpected) printSetupException(error, outcome.diagnosticId);
      throw error;
    }

    try {
      await persistSetupAttempts([attempt], () => dependencies.persist(record));
    } catch (error) {
      printSetupException(error, attempt.diagnosticId);
      throw error;
    }
    return record;
  }, dependencies.flush);
}

async function collectOpenAIDeviceAccountId(): Promise<string> {
  const { input } = await import("@inquirer/prompts");
  return input({
    message: "OpenAI account ID:",
    default: `openai-account-${loadOpenAIAccounts().length + 1}`,
    validate: value => /^[a-zA-Z0-9_-]+$/.test(value) || "Only letters, numbers, _ and - allowed",
  });
}

function printOpenAIDeviceCode(code: OpenAIDeviceCode): void {
  console.log(chalk.bold("1. Open this URL:"));
  console.log(`   ${chalk.cyan(code.verificationUrl)}`);
  console.log(chalk.bold("2. Enter this code:"));
  console.log(`   ${chalk.cyan(code.userCode)}\n`);
  console.log(chalk.gray("Waiting for authorization..."));
}

const defaultOpenAIDeviceDependencies: OpenAIDeviceAccountSetupDependencies = {
  collectAccountId: collectOpenAIDeviceAccountId,
  login: loginOpenAIWithDeviceCode,
  onDeviceCode: printOpenAIDeviceCode,
  persist: upsertAccountRecord,
  readAccountState: readAccountStateDetailed,
  createAttempt: createSetupAttempt,
  flush: flushTelemetryWithin,
};

export async function runOpenAIDeviceAccountSetup(
  dependencies: OpenAIDeviceAccountSetupDependencies = defaultOpenAIDeviceDependencies,
): Promise<OpenAIAccountRecord | null> {
  const attempt = dependencies.createAttempt({ provider: "openai", method: "device_oauth" });
  attempt.stageCompleted("credential_source_selection");
  return withSetupTelemetryFlush(async () => {
    let record: OpenAIAccountRecord;
    try {
      const state = dependencies.readAccountState();
      if (!state.ok) throw classifyAccountStateReadFailure(state.error);
      const accountId = await dependencies.collectAccountId();
      record = await dependencies.login({
        accountId,
        onDeviceCode: dependencies.onDeviceCode,
        onStageCompleted: stage => attempt.stageCompleted(stage),
      });
    } catch (error) {
      if (isPromptCancellation(error)) {
        attempt.cancelled();
        return null;
      }
      const outcome = attempt.failed(error, "failure");
      if (outcome.unexpected) printSetupException(error, outcome.diagnosticId);
      throw error;
    }

    try {
      await persistSetupAttempts([attempt], () => dependencies.persist(record));
    } catch (error) {
      printSetupException(error, attempt.diagnosticId);
      throw error;
    }
    return record;
  }, dependencies.flush);
}

export function registerAccounts(program: Command): void {
  const accounts = program
    .command("accounts")
    .description("Manage Claude Max accounts in the token pool");

  // ── accounts list ────────────────────────────────────────────────────────
  accounts
    .command("list")
    .description("List all configured accounts and their status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      // Try to get live stats from the running proxy first
      const liveStats = await fetchLiveStats();

      if (!accountsFileExists()) {
        console.log(chalk.yellow("No accounts configured. Run: cc-router setup"));
        return;
      }

      const stored = loadAccounts();
      const openAIStored = loadOpenAIAccounts();
      if (stored.length === 0 && openAIStored.length === 0) {
        console.log(chalk.yellow("accounts.json is empty. Run: cc-router setup"));
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(liveStats ?? buildStoredAccountsJson(stored, openAIStored), null, 2));
        return;
      }

      console.log(chalk.bold(`\n  Accounts (${stored.length + openAIStored.length} configured)\n`));

      if (liveStats) {
        console.log(chalk.green("  ● Proxy is running — showing live stats\n"));
        for (const s of liveStats) {
          const provider = s.provider === "openai_subscription"
            ? chalk.cyan("openai".padEnd(9))
            : chalk.gray("claude".padEnd(9));
          const status = s.healthy
            ? chalk.green("✓ healthy")
            : chalk.red("✗ unhealthy");
          const busy = s.busy ? chalk.yellow(" [busy]") : "";
          const exp = s.expiresInMs > 0
            ? chalk.yellow(formatMs(s.expiresInMs))
            : chalk.red("EXPIRED");
          console.log(
            `  ${chalk.bold(s.id.padEnd(24))}` +
            `  ${provider}` +
            `  ${status}${busy}` +
            `  requests: ${chalk.cyan(String(s.requestCount).padStart(5))}` +
            `  errors: ${chalk.red(String(s.errorCount).padStart(3))}` +
            `  expires: ${exp}`
          );
        }
      } else {
        console.log(chalk.gray("  (Proxy not running — showing stored configuration)\n"));
        for (const a of stored) {
          const exp = formatExpiry(a.tokens.expiresAt);
          const expColor = a.tokens.expiresAt > Date.now()
            ? chalk.yellow(exp)
            : chalk.red(exp);
          console.log(
            `  ${chalk.bold(a.id.padEnd(24))}` +
            `  ${redactToken(a.tokens.accessToken).padEnd(26)}` +
            `  expires: ${expColor}` +
            `  scopes: ${chalk.gray(a.tokens.scopes.join(" "))}`
          );
        }
        for (const a of openAIStored) {
          const exp = a.expiresAt > Date.now()
            ? chalk.yellow(formatExpiry(a.expiresAt))
            : chalk.red("EXPIRED");
          console.log(
            `  ${chalk.bold(a.id.padEnd(24))}` +
            `  ${chalk.magenta("openai".padEnd(10))}` +
            `  ${redactToken(a.accessToken).padEnd(26)}` +
            `  expires: ${exp}`
          );
        }
      }

      console.log();
    });

  // ── accounts add ─────────────────────────────────────────────────────────
  accounts
    .command("add")
    .description("Add a new Claude Max account interactively")
    .action(async () => {
      await withSetupTelemetryFlush(async () => {
        const { setupSingleAccountDetailed } = await import("./cmd-setup.js");

        const existing = accountsFileExists() ? loadAccounts() : [];
        const setup = await setupSingleAccountDetailed(existing.length + 1);
        const account = setup.account;

        if (!account) {
          console.log(chalk.yellow("\nNo account added.\n"));
          return;
        }

        // Merge: replace by ID if already exists, otherwise append
        const merged = [
          ...existing.filter(a => a.id !== account.id),
          account,
        ];

        try {
          await persistSetupAttempts([setup.attempt], () => saveAccounts(merged));
        } catch (error) {
          printSetupException(error, setup.attempt.diagnosticId);
          throw error;
        }
        console.log(chalk.green(`\n✓ Account "${account.id}" added (${merged.length} total).\n`));
        console.log(chalk.gray("  Restart the proxy to load the new account: cc-router start\n"));
      });
    });

  // ── accounts add-openai ──────────────────────────────────────────────────
  accounts
    .command("add-openai")
    .description("Add an OpenAI ChatGPT/Codex subscription account manually")
    .action(async () => {
      const record = await runOpenAIManualAccountSetup();
      if (!record) return;

      console.log(chalk.green(`\n✓ OpenAI account "${record.id}" saved.\n`));
      console.log(chalk.gray("  Restart the proxy to load the new account: cc-router start\n"));
      console.log(chalk.yellow("  Treat this as experimental until the OAuth login wizard lands.\n"));
    });

  // ── accounts login-openai ────────────────────────────────────────────────
  accounts
    .command("login-openai")
    .description("Sign in to an OpenAI ChatGPT/Codex subscription account with device code")
    .action(async () => {
      console.log(chalk.cyan("\nOpenAI Codex device login"));
      console.log(chalk.gray("This will open no local callback server. You will approve the login in your browser.\n"));
      const record = await runOpenAIDeviceAccountSetup();
      if (!record) return;

      console.log(chalk.green(`\n✓ OpenAI account "${record.id}" saved via device login.\n`));
      console.log(chalk.gray("  Restart the proxy to load the new account: cc-router start\n"));
    });

  // ── accounts remove ───────────────────────────────────────────────────────
  accounts
    .command("remove <id>")
    .description("Remove an account by its ID")
    .action(async (id: string) => {
      if (!accountsFileExists()) {
        console.log(chalk.yellow("No accounts configured."));
        return;
      }

      const anthropicAccounts = loadAccounts();
      const openAIAccounts = loadOpenAIAccounts();
      const existingIds = [
        ...anthropicAccounts.map(a => a.id),
        ...openAIAccounts.map(a => a.id),
      ];

      if (!existingIds.includes(id)) {
        console.log(chalk.red(`✗ Account "${id}" not found.`));
        console.log(chalk.gray(`  Available: ${existingIds.join(", ")}`));
        process.exit(1);
      }

      const { confirm } = await import("@inquirer/prompts");
      const sure = await confirm({
        message: `Remove "${id}"? This cannot be undone.`,
        default: false,
      });
      if (!sure) { console.log(chalk.gray("Cancelled.")); return; }

      const isOpenAI = openAIAccounts.some(account => account.id === id);
      try {
        await removeAccountRuntimeAware(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`✗ Could not remove "${id}": ${message}`));
        process.exit(1);
      }

      const remaining = loadAccounts().length + loadOpenAIAccounts().length;
      const providerLabel = isOpenAI ? "OpenAI account" : "Account";

      console.log(chalk.green(`✓ Removed ${providerLabel} "${id}". ${remaining} account(s) remaining.`));
      if (remaining === 0) {
        console.log(chalk.yellow("  No accounts left. Run: cc-router setup"));
      }
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function buildStoredAccountsJson(
  anthropicAccounts: Account[],
  openAIAccounts: OpenAISubscriptionAccount[],
): Array<{
  id: string;
  provider: "anthropic_subscription" | "openai_subscription";
  enabled: boolean;
  expiresAt: number;
  scopes?: string[];
}> {
  return [
    ...anthropicAccounts.map(a => ({
      id: a.id,
      provider: "anthropic_subscription" as const,
      enabled: a.enabled,
      expiresAt: a.tokens.expiresAt,
      scopes: a.tokens.scopes,
    })),
    ...openAIAccounts.map(a => ({
      id: a.id,
      provider: "openai_subscription" as const,
      enabled: a.enabled !== false,
      expiresAt: a.expiresAt,
    })),
  ];
}

export interface LiveAccountRemovalOptions {
  baseUrl?: string;
  authToken?: string;
  fetch?: typeof globalThis.fetch;
}

/** Return false only when no running proxy can be reached; HTTP errors remain authoritative. */
export async function tryRemoveAccountFromRunningProxy(
  id: string,
  options: LiveAccountRemovalOptions = {},
): Promise<boolean> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? `http://localhost:${PROXY_PORT}`).replace(/\/+$/, "");
  const authToken = options.authToken ?? readConfig().proxySecret;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/cc-router/accounts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    return false;
  }
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json() as { error?: unknown };
      if (typeof payload.error === "string") detail = `: ${payload.error}`;
    } catch { /* best effort */ }
    throw new Error(`HTTP ${response.status}${detail}`);
  }
  return true;
}

export interface RuntimeAwareRemovalDependencies {
  tryRemoveLive(id: string): Promise<boolean>;
  removeStored(id: string): AccountRecord | null;
}

export async function removeAccountRuntimeAware(
  id: string,
  dependencies: RuntimeAwareRemovalDependencies = {
    tryRemoveLive: tryRemoveAccountFromRunningProxy,
    removeStored: removeAccountRecordById,
  },
): Promise<{ mode: "live" } | { mode: "stored"; removed: AccountRecord }> {
  if (await dependencies.tryRemoveLive(id)) return { mode: "live" };
  const removed = dependencies.removeStored(id);
  if (!removed) throw new Error(`Account "${id}" disappeared before it could be removed`);
  return { mode: "stored", removed };
}

async function fetchLiveStats(): Promise<null | Array<{
  id: string; provider?: string; healthy: boolean; busy: boolean;
  requestCount: number; errorCount: number; expiresInMs: number;
}>> {
  try {
    const res = await fetch(`http://localhost:${PROXY_PORT}/cc-router/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { accounts: unknown[] };
    return data.accounts as typeof fetchLiveStats extends () => Promise<null | Array<infer T>> ? T[] : never;
  } catch {
    return null;
  }
}

function formatMs(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
