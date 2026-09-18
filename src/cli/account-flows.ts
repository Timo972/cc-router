/**
 * Every interactive "get me a credential for this provider" flow, in one place.
 *
 * These functions collect an account and hand it back — they never persist.
 * The commands that call them decide where the record goes (disk, a running
 * proxy, or both), which is what lets `setup`, `accounts add`, the dashboard's
 * add-account key and the re-authentication path all share one sign-in.
 */
import { select, input, confirm, password } from "@inquirer/prompts";
import chalk from "chalk";
import { isMacos } from "../utils/platform.js";
import {
  extractFromKeychainDetailed,
  extractFromCredentialsFileDetailed,
  formatExpiry,
  redactToken,
} from "../utils/token-extractor.js";
import { validateToken } from "../utils/token-validator.js";
import { serialize, loadOpenAIAccounts, loadXaiAccounts } from "../config/manager.js";
import type { Account, AccountRecord, OAuthTokens } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS, ACCOUNT_USER_DEFAULTS } from "../proxy/types.js";
import {
  loginWithClaudeCli,
  createLongLivedTokenWithClaudeCli,
  LONG_LIVED_TOKEN_TTL_MS,
} from "../providers/anthropic/claude-cli.js";
import { createOpenAIAccountRecord, type OpenAIAccountRecord } from "../providers/openai/account-record.js";
import { loginOpenAIWithDeviceCode } from "../providers/openai/device-oauth.js";
import { importGrokCliAuth } from "../providers/xai/import-auth.js";
import { loginXaiWithDeviceCode } from "../providers/xai/device-oauth.js";
import {
  createSetupAttempt,
  failAttemptFromError,
  type SetupAttempt,
  type SetupFailureOutcome,
} from "../telemetry/setup-diagnostics.js";
import type { SetupMethod, SetupStage } from "../telemetry/contracts.js";

// ─── Claude (Anthropic subscription) ─────────────────────────────────────────

export type ClaudeMethod = "cli_login" | "setup_token" | "keychain" | "credentials" | "manual";

export interface ClaudeFlowOptions {
  /** 1-based position used for the default id `max-account-N`. */
  index: number;
  /** Re-auth: id is fixed, no prompt. */
  fixedId?: string;
  /** Prefilled into `claude auth login --email`. */
  email?: string;
  /** Skip the picker. */
  method?: ClaudeMethod;
  /** Which methods the picker offers. Default "all". */
  offer?: "login" | "import" | "all";
}

/**
 * The only place a Claude sign-in method is translated into a telemetry method
 * name. Keeping the map here means a new method cannot reach the wire under an
 * ad-hoc string.
 */
const CLAUDE_METHOD_TELEMETRY: Record<ClaudeMethod, SetupMethod> = {
  cli_login: "claude_cli_login",
  setup_token: "claude_setup_token",
  keychain: "macos_keychain",
  credentials: "claude_credentials_file",
  manual: "manual_token",
};

function claudeMethodChoices(offer: "login" | "import" | "all"): Array<{ name: string; value: ClaudeMethod }> {
  const login: Array<{ name: string; value: ClaudeMethod }> = [
    { name: "Sign in with the browser  (claude auth login — recommended)", value: "cli_login" },
    { name: "Create a long-lived token (claude setup-token — does not change Claude Code's login)", value: "setup_token" },
  ];
  const imports: Array<{ name: string; value: ClaudeMethod }> = [
    ...(isMacos() ? [{ name: "Extract automatically from macOS Keychain", value: "keychain" as const }] : []),
    { name: "Read from ~/.claude/.credentials.json", value: "credentials" },
    { name: "Paste tokens manually", value: "manual" },
  ];
  return offer === "login" ? login : offer === "import" ? imports : [...login, ...imports];
}

/** Only an unexpected failure gets a diagnostic ID worth quoting in a bug report. */
function printDiagnosticId(outcome: SetupFailureOutcome): void {
  if (!outcome.unexpected) return;
  console.log(chalk.gray(`  Diagnostic ID: ${outcome.diagnosticId}`));
}

/**
 * Collect one Claude account. Also hands back the setup attempt so the caller
 * can mark the `persistence` stage and the final outcome once the account is
 * written.
 */
export async function collectClaudeAccount(
  options: ClaudeFlowOptions,
): Promise<{ account: Account | null; attempt: SetupAttempt }> {
  const method = options.method ?? await select<ClaudeMethod>({
    message: "How do you want to add the account?",
    choices: claudeMethodChoices(options.offer ?? "all"),
  });

  const attempt = createSetupAttempt({ provider: "anthropic", method: CLAUDE_METHOD_TELEMETRY[method] });
  attempt.stageCompleted("credential_source_selection");
  // Shared by reference: the file-extraction fallback swaps in a manual-token attempt.
  const current = { attempt };
  let reached: SetupStage = "credential_read";
  try {
    return await collectAnthropicAccount(options, method, current, stage => { reached = stage; });
  } catch (error) {
    // A thrown prompt or extraction error must still close the funnel record.
    const outcome = failAttemptFromError(current.attempt, error, reached);
    if (outcome) printDiagnosticId(outcome);
    throw error;
  }
}

async function collectAnthropicAccount(
  options: ClaudeFlowOptions,
  method: ClaudeMethod,
  current: { attempt: SetupAttempt },
  reached: (stage: SetupStage) => void,
): Promise<{ account: Account | null; attempt: SetupAttempt }> {
  let attempt = current.attempt;
  let tokens: OAuthTokens | null = null;

  if (method === "cli_login") {
    console.log(chalk.gray("\n  Handing the terminal to Claude Code. Sign in with the account you want to add.\n"));
    tokens = await loginWithClaudeCli({ email: options.email }, undefined);
    console.log(chalk.green(`  ✓ Signed in — token ${redactToken(tokens.accessToken)}, expires ${formatExpiry(tokens.expiresAt)}`));
    console.log(chalk.gray("  Note: Claude Code on this machine is now logged in as this account."));
  }

  if (method === "setup_token") {
    console.log(chalk.gray("\n  Handing the terminal to Claude Code to create a long-lived token.\n"));
    const captured = await createLongLivedTokenWithClaudeCli(undefined);
    let accessToken = captured?.accessToken;
    if (!accessToken) {
      console.log(chalk.yellow("\n  Could not read the token from claude setup-token's output."));
      accessToken = await password({
        message: "Paste the token (sk-ant-oat01-...):",
        mask: "•",
        validate: v => v.startsWith("sk-ant-oat01-") || "Must start with sk-ant-oat01-",
      });
    }
    const useDefaultExpiry = await confirm({ message: "Token valid for 1 year (default)?", default: true });
    const expiresAt = useDefaultExpiry
      ? Date.now() + LONG_LIVED_TOKEN_TTL_MS
      : new Date(await input({ message: "Paste expiresAt (ISO date or ms timestamp):" })).getTime();
    tokens = { accessToken, refreshToken: undefined, expiresAt, scopes: ["user:inference"] };
    console.log(chalk.gray("  This token has no refresh token and the inference scope only: usage and identity metadata are unavailable for it."));
  }

  if (method === "keychain") {
    process.stdout.write(chalk.gray("  Extracting from Keychain... "));
    const extraction = await extractFromKeychainDetailed();
    if (extraction.ok) {
      tokens = extraction.tokens;
      console.log(chalk.green("✓"));
      console.log(chalk.gray(`  Token: ${redactToken(tokens.accessToken)}`));
      console.log(chalk.gray(`  Expiry: ${formatExpiry(tokens.expiresAt)}`));
    } else {
      console.log(chalk.red("✗"));
      console.log(chalk.yellow("  Could not find credentials in Keychain."));
      console.log(chalk.gray("  Make sure Claude Code is logged in: run `claude login` first."));
      printDiagnosticId(attempt.stageFailed(extraction.error, "credential_read"));
      const retry = await confirm({ message: "Try another extraction method?", default: true });
      attempt.cancelled();
      if (!retry) return { account: null, attempt };
      return collectClaudeAccount({ ...options, method: undefined });
    }
  }

  if (method === "credentials") {
    const extraction = extractFromCredentialsFileDetailed();
    if (extraction.ok) {
      tokens = extraction.tokens;
      console.log(chalk.green(`  ✓ Found credentials in ~/.claude/.credentials.json`));
      console.log(chalk.gray(`    Token: ${redactToken(tokens.accessToken)}`));
      console.log(chalk.gray(`    Expiry: ${formatExpiry(tokens.expiresAt)}`));
    } else {
      console.log(chalk.red("  ✗ ~/.claude/.credentials.json not found or unreadable."));
      console.log(chalk.gray("  Make sure Claude Code is installed and you've run `claude login`."));
      const retry = await confirm({ message: "Paste tokens manually instead?", default: true });
      if (!retry) {
        printDiagnosticId(attempt.stageFailed(extraction.error, "credential_read"));
        attempt.cancelled();
        return { account: null, attempt };
      }
      // The file-based attempt failed; the pasted tokens are a manual-token setup.
      printDiagnosticId(attempt.failed(extraction.error, "credential_read"));
      attempt = createSetupAttempt({ provider: "anthropic", method: "manual_token" });
      current.attempt = attempt;
      attempt.stageCompleted("credential_source_selection");
      tokens = await promptManualTokens();
    }
  }

  if (method === "manual") {
    tokens = await promptManualTokens();
  }

  if (!tokens) {
    attempt.cancelled();
    return { account: null, attempt };
  }

  attempt.stageCompleted("credential_read");
  attempt.stageCompleted("credential_parse");
  reached("token_validation");

  const accountId = options.fixedId ?? await input({
    message: "Account ID (press Enter to accept default):",
    default: `max-account-${options.index}`,
    validate: v => /^[a-zA-Z0-9_-]+$/.test(v) || "Only letters, numbers, _ and - allowed",
  });

  process.stdout.write(chalk.gray("  Validating tokens against Anthropic... "));
  const validation = await validateToken(tokens.accessToken);

  if (validation.valid) {
    console.log(chalk.green("✓ Valid"));
    attempt.stageCompleted("token_validation");
  } else {
    console.log(chalk.red("✗ Invalid"));
    console.log(chalk.yellow(`  Reason: ${validation.reason}`));
    printDiagnosticId(attempt.stageFailed(validation.diagnostic, "token_validation"));
    console.log(chalk.gray("  The token will be saved but may not work until refreshed."));
    const keepAnyway = await confirm({ message: "Save this account anyway?", default: false });
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
}

// ─── Manual token input ───────────────────────────────────────────────────────

/**
 * The refresh token stays required here: a pasted long-lived `setup-token`
 * credential has none, and it has its own method rather than this one.
 */
async function promptManualTokens(): Promise<OAuthTokens | null> {
  console.log(chalk.gray(
    "\n  You can find your tokens by running:\n" +
    "    macOS:         security find-generic-password -s 'Claude Code-credentials' -w\n" +
    "    Linux/Windows: cat ~/.claude/.credentials.json\n"
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
    : new Date(await input({ message: "Paste expiresAt (ISO date or ms timestamp):" })).getTime();

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scopes: ["user:inference", "user:profile"],
  };
}

// ─── OpenAI (ChatGPT / Codex subscription) ───────────────────────────────────

export interface OpenAILoginOptions {
  /** Fixed id (re-auth). Prompted with the `openai-account-N` default when absent. */
  accountId?: string;
  /** Prefilled into the device page as `login_hint`. */
  email?: string;
}

function promptOpenAIAccountId(fixed: string | undefined): Promise<string> {
  if (fixed) return Promise.resolve(fixed);
  return input({
    message: "OpenAI account ID:",
    default: `openai-account-${loadOpenAIAccounts().length + 1}`,
    validate: (v) => /^[a-zA-Z0-9_-]+$/.test(v) || "Only letters, numbers, _ and - allowed",
  });
}

/** Device-code sign-in. The browser is opened by the device flow itself. */
export async function loginOpenAIAccount(
  options: OpenAILoginOptions = {},
): Promise<{ record: OpenAIAccountRecord; attempt: SetupAttempt }> {
  const attempt = createSetupAttempt({ provider: "openai", method: "device_oauth" });
  let reached: SetupStage = "device_code_request";

  try {
    const accountId = await promptOpenAIAccountId(options.accountId);

    console.log(chalk.cyan("\nOpenAI Codex device login"));
    console.log(chalk.gray("This will open no local callback server. You will approve the login in your browser.\n"));

    const record = await loginOpenAIWithDeviceCode({
      accountId,
      ...(options.email ? { loginHint: options.email } : {}),
      onDeviceCode: (code) => {
        console.log(chalk.bold("1. Open this URL (opening it for you if possible):"));
        console.log(`   ${chalk.cyan(code.verificationUrl)}`);
        console.log(chalk.bold("2. Enter this code if the page does not fill it in:"));
        console.log(`   ${chalk.cyan(code.userCode)}`);
        if (options.email) console.log(chalk.bold(`3. Sign in as ${chalk.cyan(options.email)}`));
        console.log(chalk.gray("\nWaiting for authorization..."));
      },
      onStageCompleted: (stage) => {
        attempt.stageCompleted(stage);
        reached = stage;
      },
    });

    return { record, attempt };
  } catch (error) {
    endFailedAttempt(attempt, error, reached);
    throw error;
  }
}

/** Hand-pasted OpenAI credentials, for when the device flow is not an option. */
export async function importOpenAIAccount(
  options: { accountId?: string } = {},
): Promise<{ record: OpenAIAccountRecord; attempt: SetupAttempt }> {
  const attempt = createSetupAttempt({ provider: "openai", method: "manual_token" });
  attempt.stageCompleted("credential_source_selection");
  let reached: SetupStage = "credential_read";

  try {
    const id = await promptOpenAIAccountId(options.accountId);
    const accessToken = await password({
      message: "OpenAI access token:",
      mask: "*",
      validate: (v) => v.trim().length > 0 || "Access token is required",
    });
    const refreshToken = await password({
      message: "OpenAI refresh token:",
      mask: "*",
      validate: (v) => v.trim().length > 0 || "Refresh token is required",
    });
    const expiresAt = await input({
      message: "Access token expiry (Unix ms):",
      default: String(Date.now() + 60 * 60 * 1000),
      validate: (v) => Number.isFinite(Number(v)) && Number(v) > 0 || "Enter a positive Unix timestamp in milliseconds",
    });
    const scopes = await input({
      message: "Scopes:",
      default: "openid profile email offline_access",
    });
    attempt.stageCompleted("credential_read");

    reached = "credential_parse";
    const record = createOpenAIAccountRecord({ id, accessToken, refreshToken, expiresAt, scopes });
    attempt.stageCompleted("credential_parse");

    return { record, attempt };
  } catch (error) {
    endFailedAttempt(attempt, error, reached);
    throw error;
  }
}

// ─── Grok / xAI ───────────────────────────────────────────────────────────────

function promptGrokAccountId(fixed: string | undefined, fallback: string): Promise<string> {
  if (fixed) return Promise.resolve(fixed);
  return input({
    message: "Grok account ID:",
    default: fallback,
    validate: (v) => /^[a-zA-Z0-9_-]+$/.test(v) || "Only letters, numbers, _ and - allowed",
  });
}

/** Device-code sign-in for a Grok / xAI account. */
export async function loginGrokAccount(options: { accountId?: string } = {}): Promise<AccountRecord> {
  const accountId = await promptGrokAccountId(
    options.accountId,
    loadXaiAccounts().length === 0 ? "grok" : `grok-${loadXaiAccounts().length + 1}`,
  );

  console.log(chalk.cyan("\nGrok device login"));
  console.log(chalk.gray("Approve the login in your browser. No local callback server is used.\n"));

  return loginXaiWithDeviceCode({
    accountId,
    onDeviceCode: (code) => {
      console.log(chalk.bold("1. Open this URL:"));
      console.log(`   ${chalk.cyan(code.verificationUrl)}`);
      console.log(chalk.bold("2. Enter this code if the page does not fill it in:"));
      console.log(`   ${chalk.cyan(code.userCode)}\n`);
      console.log(chalk.gray("Waiting for authorization..."));
    },
  });
}

/** Copy an existing Grok CLI login out of ~/.grok/auth.json. */
export async function importGrokAccount(options: { accountId?: string } = {}): Promise<AccountRecord> {
  let imported;
  try {
    imported = importGrokCliAuth();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`\n✗ ${message}\n`));
    console.log(chalk.gray("  Or sign in here: cc-router accounts login-grok\n"));
    process.exit(1);
  }

  const id = await promptGrokAccountId(options.accountId, imported.id);
  return { ...imported, id };
}

// ─── Re-authentication ────────────────────────────────────────────────────────

export interface ReauthTarget {
  id: string;
  provider: "anthropic_subscription" | "openai_subscription";
  email?: string;
}

/** Runs the provider's login with the id fixed. Returns null when the operator cancels. */
export async function collectReauthRecord(
  target: ReauthTarget,
  options: { longLived?: boolean } = {},
): Promise<{ record: AccountRecord; attempt: SetupAttempt } | null> {
  console.log(chalk.cyan(`\nRe-authenticating "${target.id}" (${target.provider === "openai_subscription" ? "openai" : "claude"})`
    + (target.email ? ` — sign in as ${chalk.bold(target.email)}` : "") + "\n"));
  if (target.provider === "openai_subscription") {
    const { record, attempt } = await loginOpenAIAccount({
      accountId: target.id,
      ...(target.email ? { email: target.email } : {}),
    });
    return { record, attempt };
  }
  const { account, attempt } = await collectClaudeAccount({
    index: 1,
    fixedId: target.id,
    ...(target.email ? { email: target.email } : {}),
    offer: "login",
    ...(options.longLived ? { method: "setup_token" as const } : {}),
  });
  return account ? { record: accountToRecord(account), attempt } : null;
}

/** The on-disk form of a collected Claude account. */
export function accountToRecord(account: Account): AccountRecord {
  return serialize([account])[0]!;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Close a setup attempt that ended in a thrown error. A cancelled prompt is a
 * user decision, not a failure, and only an unexpected failure gets a
 * diagnostic ID worth quoting in a bug report.
 */
function endFailedAttempt(attempt: SetupAttempt, error: unknown, fallbackStage: SetupStage): void {
  const outcome = failAttemptFromError(attempt, error, fallbackStage);
  if (outcome?.unexpected) {
    console.log(chalk.gray(`  Diagnostic ID: ${outcome.diagnosticId}`));
  }
}
