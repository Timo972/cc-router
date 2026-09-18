import type { Command } from "commander";
import chalk from "chalk";
import { loadAccounts, loadOpenAIAccounts, loadXaiAccounts, accountsFileExists, upsertAccountRecord, removeAccountRecordById, renameAccountRecordById, readConfig } from "../config/manager.js";
import { saveAccounts } from "../proxy/token-refresher.js";
import { formatExpiry, redactToken } from "../utils/token-extractor.js";
import { PROXY_PORT } from "../config/paths.js";
import { isValidAccountId } from "../proxy/account-rename.js";
import {
  failAttemptFromError,
  withSetupTelemetryFlush,
  type SetupAttempt,
} from "../telemetry/setup-diagnostics.js";
import type { SetupStage } from "../telemetry/contracts.js";
import type { Account, AccountRecord } from "../proxy/types.js";
import { isTokenOnly } from "../proxy/types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { ReauthTarget } from "./account-flows.js";
import { sanitizeAccountInfo, formatAccountInfo, type AccountInfo } from "../providers/account-info.js";
import { needsReauthentication } from "../providers/auth-state.js";
import { CliUsageError } from "./cli-errors.js";

export function registerAccounts(program: Command): void {
  const accounts = program
    .command("accounts")
    .description("Manage Claude Max, ChatGPT/Codex, and Grok accounts");

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
      const xaiStored = loadXaiAccounts();
      if (stored.length === 0 && openAIStored.length === 0 && xaiStored.length === 0) {
        console.log(chalk.yellow("accounts.json is empty. Run: cc-router setup"));
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(liveStats ?? buildStoredAccountsJson(stored, openAIStored, xaiStored), null, 2));
        return;
      }

      // The count has to describe the rows printed below it. Taking it from
      // disk while listing the proxy's live pool made drift invisible — the
      // header claimed four accounts above six rows.
      console.log(chalk.bold(
        liveStats
          ? `\n  Accounts (${liveStats.length} in the running proxy)\n`
          : `\n  Accounts (${stored.length + openAIStored.length + xaiStored.length} configured)\n`,
      ));

      /**
       * Accounts only re-authentication can restore. Just the ids: `accounts
       * reauth <id>` resolves the provider itself, so the hint no longer has
       * to pick a per-provider sign-in command — getting that wrong re-added
       * the id under the wrong provider entirely.
       */
      const reauthNeeded: string[] = [];

      if (liveStats) {
        console.log(chalk.green("  ● Proxy is running — showing live stats\n"));
        for (const s of liveStats) {
          const provider = s.provider === "openai_subscription"
            ? chalk.cyan("openai".padEnd(9))
            : s.provider === "xai_subscription"
              ? chalk.magenta("grok".padEnd(9))
              : chalk.gray("claude".padEnd(9));
          // "unhealthy" covers everything from a five-minute network blip to a
          // permanently rejected refresh token. Only the latter needs the
          // operator, so it gets its own label rather than hiding in the crowd.
          if (needsReauthentication(s)) reauthNeeded.push(s.id);
          const status = needsReauthentication(s)
            ? chalk.red("✗ re-auth required")
            : s.healthy
              ? chalk.green("✓ healthy")
              : chalk.red("✗ unhealthy");
          const busy = s.busy ? chalk.yellow(" [busy]") : "";
          // A `claude setup-token` account has no refresh token, so it never
          // refreshes and carries the inference scope only. Saying so here is
          // what stops "expires" reading as a bug rather than a deadline.
          const tokenOnly = s.tokenOnly ? chalk.gray(" token-only") : "";
          const exp = s.expiresInMs > 0
            ? chalk.yellow(formatMs(s.expiresInMs))
            : chalk.red("EXPIRED");
          console.log(
            `  ${chalk.bold(s.id.padEnd(24))}` +
            `  ${provider}` +
            `  ${status}${busy}${tokenOnly}` +
            `  requests: ${chalk.cyan(String(s.requestCount).padStart(5))}` +
            `  errors: ${chalk.red(String(s.errorCount).padStart(3))}` +
            `  expires: ${exp}`
          );
          const info = formatAccountInfo(s.accountInfo);
          if (info) console.log(chalk.gray(`    ${info}`));
        }

        // The proxy reads accounts.json once at startup, so anything that
        // rewrites the file afterwards leaves the two out of step. Silence
        // here is how an account can be routing live while its refresh token
        // exists nowhere on disk — one restart from having to authenticate it
        // again.
        const { unpersisted, unloaded } = accountDrift(
          liveStats.map(s => s.id),
          [...stored.map(a => a.id), ...openAIStored.map(a => a.id), ...xaiStored.map(a => a.id)],
        );
        if (unpersisted.length > 0) {
          console.log(chalk.red(
            `\n  ⚠ Not in accounts.json: ${unpersisted.join(", ")}`,
          ));
          console.log(chalk.gray(
            "    These live only in the running proxy. Restarting it loses their\n"
            + "    credentials — re-add them, or update any one account to make the\n"
            + "    proxy write its pool back to disk.",
          ));
        }
        if (unloaded.length > 0) {
          console.log(chalk.yellow(
            `\n  ⚠ In accounts.json but not loaded: ${unloaded.join(", ")}`,
          ));
          console.log(chalk.gray("    Restart the proxy to pick them up: cc-router start"));
        }
      } else {
        console.log(chalk.gray("  (Proxy not running — showing stored configuration)\n"));
        for (const a of stored) {
          const exp = formatExpiry(a.tokens.expiresAt);
          const expColor = a.tokens.expiresAt > Date.now()
            ? chalk.yellow(exp)
            : chalk.red(exp);
          // `authExpired` is persisted, so the dead state is knowable without
          // the proxy running — and this is exactly when an operator looks.
          if (needsReauthentication(a)) reauthNeeded.push(a.id);
          console.log(
            `  ${chalk.bold(a.id.padEnd(24))}` +
            `  ${redactToken(a.tokens.accessToken).padEnd(26)}` +
            `  expires: ${expColor}` +
            (isTokenOnly(a.tokens)
              ? `  ${chalk.gray("token-only")}`
              : `  scopes: ${chalk.gray(a.tokens.scopes.join(" "))}`) +
            (needsReauthentication(a) ? `  ${chalk.red("✗ re-auth required")}` : "")
          );
        }
        for (const a of openAIStored) {
          const exp = a.expiresAt > Date.now()
            ? chalk.yellow(formatExpiry(a.expiresAt))
            : chalk.red("EXPIRED");
          if (needsReauthentication(a)) reauthNeeded.push(a.id);
          console.log(
            `  ${chalk.bold(a.id.padEnd(24))}` +
            `  ${chalk.magenta("openai".padEnd(10))}` +
            `  ${redactToken(a.accessToken).padEnd(26)}` +
            `  expires: ${exp}` +
            (needsReauthentication(a) ? `  ${chalk.red("✗ re-auth required")}` : "")
          );
        }
        for (const a of xaiStored) {
          const exp = a.expiresAt > Date.now()
            ? chalk.yellow(formatExpiry(a.expiresAt))
            : chalk.red("EXPIRED");
          console.log(
            `  ${chalk.bold(a.id.padEnd(24))}` +
            `  ${chalk.magenta("grok".padEnd(10))}` +
            `  ${redactToken(a.accessToken).padEnd(26)}` +
            `  expires: ${exp}`
          );
        }
      }

      // A dead refresh token is the one failure the router cannot work its way
      // out of: the refresh loop has deliberately stopped retrying, so nothing
      // changes until someone re-authenticates. Say so, and say how.
      if (reauthNeeded.length > 0) {
        console.log(chalk.red(
          `\n  ⚠ Needs re-authentication: ${reauthNeeded.join(", ")}`,
        ));
        console.log(chalk.gray(
          "    The provider rejected these refresh tokens permanently; they cannot\n"
          + "    be recovered and the refresh loop has stopped retrying them. Sign in\n"
          + "    again under the same account id to resume routing — the existing\n"
          + "    account is replaced, so there is nothing to remove first:",
        ));
        for (const id of reauthNeeded) {
          console.log(chalk.gray(`      ${reauthCommand(id)}`));
        }
      }

      console.log();
    });

  // ── accounts login ───────────────────────────────────────────────────────
  accounts
    .command("login [provider]")
    .description("Sign in to a Claude, OpenAI or Grok account in the browser (provider: claude | openai | grok)")
    .option("--id <id>", "Account id to store the credentials under")
    .option("--email <email>", "Email to prefill on the sign-in page")
    .option("--long-lived", "Claude only: create a long-lived token with claude setup-token instead of a full sign-in")
    .action(async (providerArg: string | undefined, opts: { id?: string; email?: string; longLived?: boolean }) =>
      withSetupTelemetryFlush(async () => {
        const provider = await chooseProvider(providerArg);
        const flows = await import("./account-flows.js");

        if (provider === "claude") {
          const { account, attempt } = await flows.collectClaudeAccount({
            index: (accountsFileExists() ? loadAccounts().length : 0) + 1,
            fixedId: opts.id,
            email: opts.email,
            offer: "login",
            ...(opts.longLived ? { method: "setup_token" as const } : {}),
          });
          if (!account) { console.log(chalk.yellow("\nNo account added.\n")); return; }
          await persistClaude(account, attempt);
          return;
        }

        if (provider === "openai") {
          // The id prompt (with its `openai-account-N` default) lives in the
          // flow, so an absent --id is a prompt rather than a guessed name.
          const { record, attempt } = await flows.loginOpenAIAccount({ accountId: opts.id, email: opts.email });
          await persistRecord(record, attempt, "OpenAI account");
          return;
        }

        const record = await flows.loginGrokAccount({ accountId: opts.id });
        upsertAccountRecord(record);
        console.log(chalk.green(`\n✓ Grok account "${record.id}" saved via device login.\n`));
        printAddOutcome("stored");
      }));

  // ── accounts add ─────────────────────────────────────────────────────────
  accounts
    .command("add [provider]")
    .description("Import credentials that already exist: Claude Keychain / credentials file / pasted tokens, OpenAI tokens, or ~/.grok")
    .option("--id <id>", "Account id to store the credentials under")
    .action(async (providerArg: string | undefined, opts: { id?: string }) =>
      withSetupTelemetryFlush(async () => {
        const provider = await chooseProvider(providerArg);
        const flows = await import("./account-flows.js");

        if (provider === "claude") {
          const { account, attempt } = await flows.collectClaudeAccount({
            index: (accountsFileExists() ? loadAccounts().length : 0) + 1,
            fixedId: opts.id,
            offer: "import",
          });
          if (!account) { console.log(chalk.yellow("\nNo account added.\n")); return; }
          await persistClaude(account, attempt);
          return;
        }

        if (provider === "openai") {
          const { record, attempt } = await flows.importOpenAIAccount({ accountId: opts.id });
          await persistRecord(record, attempt, "OpenAI account");
          return;
        }

        const record = await flows.importGrokAccount({ accountId: opts.id });
        upsertAccountRecord(record);
        console.log(chalk.green(`\n✓ Grok account "${record.id}" imported from ~/.grok.\n`));
        printAddOutcome("stored");
      }));

  // ── accounts reauth ──────────────────────────────────────────────────────
  accounts
    .command("reauth <id>")
    .description("Sign an existing account in again under the same id (its provider and email are looked up for you)")
    .option("--email <email>", "Override the email to prefill on the sign-in page")
    .option("--long-lived", "Claude only: use claude setup-token")
    .action(async (id: string, opts: { email?: string; longLived?: boolean }) =>
      withSetupTelemetryFlush(async () => {
        const live = await fetchLiveStats();
        const target = resolveReauthTarget(id, live, {
          anthropic: accountsFileExists() ? loadAccounts() : [],
          openai: loadOpenAIAccounts(),
          xai: loadXaiAccounts(),
        });

        if (!target) {
          const { ids } = mergeAccountInventory(
            loadAccounts().map(a => a.id),
            loadOpenAIAccounts().map(a => a.id),
            live,
            loadXaiAccounts().map(a => a.id),
          );
          console.log(chalk.red(`✗ Account "${id}" not found.`));
          console.log(chalk.gray(`  Available: ${ids.join(", ")}`));
          process.exit(1);
        }

        // Grok credentials are minted by the Grok CLI and read back out of
        // ~/.grok; there is no id-preserving sign-in to re-run here.
        if ("grok" in target) {
          console.log(chalk.yellow(
            `Grok credentials live in ~/.grok. Run ${chalk.white("grok login")}, then ${chalk.white("cc-router accounts add grok")}.`,
          ));
          process.exit(1);
        }

        const flows = await import("./account-flows.js");
        const result = await flows.collectReauthRecord(
          { ...target, ...(opts.email ? { email: opts.email } : {}) },
          { longLived: opts.longLived },
        );
        if (!result) { console.log(chalk.yellow("\nNo account re-authenticated.\n")); return; }
        await persistRecord(
          result.record,
          result.attempt,
          target.provider === "openai_subscription" ? "OpenAI account" : "Account",
        );
      }));

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
      const xaiAccounts = loadXaiAccounts();
      const { ids: existingIds, openAIIds } = mergeAccountInventory(
        anthropicAccounts.map(a => a.id),
        openAIAccounts.map(a => a.id),
        await fetchLiveStats(),
        xaiAccounts.map(a => a.id),
      );

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

      const isOpenAI = openAIIds.has(id);
      try {
        await removeAccountRuntimeAware(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`✗ Could not remove "${id}": ${message}`));
        process.exit(1);
      }

      const remaining = loadAccounts().length + loadOpenAIAccounts().length + loadXaiAccounts().length;
      const providerLabel = isOpenAI ? "OpenAI account" : "Account";

      console.log(chalk.green(`✓ Removed ${providerLabel} "${id}". ${remaining} account(s) remaining.`));
      if (remaining === 0) {
        console.log(chalk.yellow("  No accounts left. Run: cc-router setup"));
      }
    });

  accounts
    .command("rename <id> <new-id>")
    .description("Rename an account — its routing state and sticky sessions follow the new name")
    .action(async (id: string, newId: string) => {
      if (!accountsFileExists()) {
        console.log(chalk.yellow("No accounts configured."));
        return;
      }
      if (!isValidAccountId(newId)) {
        console.log(chalk.red(`✗ "${newId}" is not a valid account name.`));
        console.log(chalk.gray("  1-64 characters: alphanumeric start, then letters, digits, dots, underscores, or dashes."));
        process.exit(1);
      }

      const { ids: existingIds } = mergeAccountInventory(
        loadAccounts().map(a => a.id),
        loadOpenAIAccounts().map(a => a.id),
        await fetchLiveStats(),
        loadXaiAccounts().map(a => a.id),
      );
      if (!existingIds.includes(id)) {
        console.log(chalk.red(`✗ Account "${id}" not found.`));
        console.log(chalk.gray(`  Available: ${existingIds.join(", ")}`));
        process.exit(1);
      }
      if (id === newId) {
        console.log(chalk.gray(`Account is already named "${newId}".`));
        return;
      }
      if (existingIds.includes(newId)) {
        console.log(chalk.red(`✗ An account named "${newId}" already exists.`));
        process.exit(1);
      }

      let result: Awaited<ReturnType<typeof renameAccountRuntimeAware>>;
      try {
        result = await renameAccountRuntimeAware(id, newId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`✗ Could not rename "${id}": ${message}`));
        process.exit(1);
      }

      console.log(chalk.green(`✓ Renamed "${id}" → "${newId}".`));
      console.log(
        result.mode === "live"
          ? chalk.gray("  Applied to the running proxy — in-flight requests and sticky sessions follow the new name.")
          : chalk.gray("  Saved to accounts.json — loads on next start: cc-router start"),
      );
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export type ProviderArg = "claude" | "openai" | "grok";

/**
 * The provider named on the command line, if one was.
 *
 * Unknown values throw rather than falling back to a picker: silently asking
 * again would let `accounts login clade` sign the operator into whatever they
 * then clicked, under a command they did not mean to run.
 */
export function parseProviderArg(value: string | undefined): ProviderArg | undefined {
  if (value === undefined) return undefined;
  if (value === "claude" || value === "openai" || value === "grok") return value;
  throw new CliUsageError(`Unknown provider "${value}" — use claude, openai or grok`);
}

async function chooseProvider(given: string | undefined): Promise<ProviderArg> {
  const parsed = parseProviderArg(given);
  if (parsed) return parsed;
  const { select } = await import("@inquirer/prompts");
  return select<ProviderArg>({
    message: "Which provider?",
    choices: [
      { name: "Claude (Claude Max / Pro subscription)", value: "claude" },
      { name: "OpenAI (ChatGPT / Codex subscription)", value: "openai" },
      { name: "Grok (xAI)", value: "grok" },
    ],
  });
}

/**
 * Persist a collected Claude account, replacing any account already holding
 * its id. The merge is by id across the whole Claude pool, so only `addStored`
 * is overridden — `tryAddLive` must stay the default, which asks the running
 * proxy to replace rather than reject the id.
 */
async function persistClaude(account: Account, attempt: SetupAttempt): Promise<void> {
  const { accountToRecord } = await import("./account-flows.js");
  const existing = accountsFileExists() ? loadAccounts() : [];
  const merged = [...existing.filter(a => a.id !== account.id), account];

  let mode: "live" | "stored";
  try {
    ({ mode } = await addAccountRuntimeAware(accountToRecord(account), {
      addStored: () => saveAccounts(merged),
    }));
  } catch (error) {
    endFailedAttempt(attempt, error, "persistence");
    throw error;
  }
  attempt.stageCompleted("persistence");
  attempt.succeeded();

  console.log(chalk.green(`\n✓ Account "${account.id}" saved (${merged.length} Claude accounts).\n`));
  printAddOutcome(mode);
}

/** Persist any already-serialized record (OpenAI, or a re-authenticated account). */
async function persistRecord(record: AccountRecord, attempt: SetupAttempt | undefined, label: string): Promise<void> {
  let mode: "live" | "stored";
  try {
    ({ mode } = await addAccountRuntimeAware(record));
  } catch (error) {
    if (attempt) endFailedAttempt(attempt, error, "persistence");
    throw error;
  }
  attempt?.stageCompleted("persistence");
  attempt?.succeeded();

  console.log(chalk.green(`\n✓ ${label} "${record.id}" saved.\n`));
  printAddOutcome(mode);
}

/**
 * Which account `accounts reauth <id>` should sign in again, and as whom.
 *
 * The live pool wins: it is the only source that carries the fetched account
 * metadata, and its email is what makes the sign-in page land on the right
 * account instead of whichever one the browser is already holding. Disk is the
 * fallback for a proxy that is not running, and knows no email.
 */
export function resolveReauthTarget(
  id: string,
  live: Array<LiveAccountSummary & { accountInfo?: { email?: string } }> | null,
  stored: {
    anthropic: Array<{ id: string }>;
    openai: Array<{ id: string }>;
    xai: Array<{ id: string }>;
  },
): ReauthTarget | { grok: true } | null {
  const liveMatch = live?.find(a => a.id === id);
  if (liveMatch) {
    if (liveMatch.provider === "xai_subscription") return { grok: true };
    return {
      id,
      provider: liveMatch.provider === "openai_subscription" ? "openai_subscription" : "anthropic_subscription",
      ...(liveMatch.accountInfo?.email ? { email: liveMatch.accountInfo.email } : {}),
    };
  }
  if (stored.xai.some(a => a.id === id)) return { grok: true };
  if (stored.openai.some(a => a.id === id)) return { id, provider: "openai_subscription" };
  if (stored.anthropic.some(a => a.id === id)) return { id, provider: "anthropic_subscription" };
  return null;
}

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

/** Tell the user whether the new account is already live or needs a restart. */
function printAddOutcome(mode: "live" | "stored"): void {
  console.log(
    mode === "live"
      ? chalk.gray("  Loaded into the running proxy — available now, no restart needed.\n")
      : chalk.gray("  Restart the proxy to load the new account: cc-router start\n"),
  );
}

/** An account as the running proxy reports it in its health payload. */
export interface LiveAccountSummary {
  id: string;
  provider?: string;
}

/**
 * Every account this CLI could act on, from both places one can live.
 *
 * The proxy loads accounts.json once at startup and holds that snapshot, so
 * the two sources drift the moment the file changes underneath a running
 * proxy — and they answer different questions. Removal prefers the live pool
 * (see `removeAccountRuntimeAware`), so validating an id against disk alone
 * rejected accounts that existed and were perfectly removable.
 */
export function mergeAccountInventory(
  storedAnthropicIds: string[],
  storedOpenAIIds: string[],
  live: LiveAccountSummary[] | null,
  storedXaiIds: string[] = [],
): { ids: string[]; openAIIds: Set<string> } {
  const openAIIds = new Set(storedOpenAIIds);
  for (const account of live ?? []) {
    if (account.provider === "openai_subscription") openAIIds.add(account.id);
  }
  return {
    ids: [...new Set([
      ...storedAnthropicIds,
      ...storedOpenAIIds,
      ...storedXaiIds,
      ...(live ?? []).map(account => account.id),
    ])],
    openAIIds,
  };
}

/**
 * Where the running proxy and accounts.json disagree.
 *
 * `unpersisted` is the dangerous direction: those accounts exist only in the
 * proxy's memory, so a restart loses their refresh tokens and they have to be
 * authenticated again. `unloaded` is merely stale — the records are safe on
 * disk, the proxy just has not read them.
 */
export function accountDrift(
  liveIds: string[],
  storedIds: string[],
): { unpersisted: string[]; unloaded: string[] } {
  const live = new Set(liveIds);
  const stored = new Set(storedIds);
  return {
    unpersisted: liveIds.filter(id => !stored.has(id)),
    unloaded: storedIds.filter(id => !live.has(id)),
  };
}

export function buildStoredAccountsJson(
  anthropicAccounts: Account[],
  openAIAccounts: OpenAISubscriptionAccount[],
  xaiAccounts: Array<{ id: string; expiresAt: number; enabled: boolean }> = [],
): Array<{
  id: string;
  provider: "anthropic_subscription" | "openai_subscription" | "xai_subscription";
  enabled: boolean;
  expiresAt: number;
  scopes?: string[];
  /** Present only when true: this account's refresh token was rejected
   *  permanently and only re-authentication restores it. A JSON consumer
   *  cannot otherwise tell it apart from an ordinarily expired access token,
   *  since both simply read as a past `expiresAt`. A boolean, so nothing
   *  credential-bearing is added to the output. */
  authExpired?: true;
  /** Present only when true: a `claude setup-token` credential, which has no
   *  refresh token, never refreshes and carries the inference scope only. A
   *  boolean, so nothing credential-bearing is added to the output. */
  tokenOnly?: true;
}> {
  return [
    ...anthropicAccounts.map(a => ({
      id: a.id,
      provider: "anthropic_subscription" as const,
      enabled: a.enabled,
      expiresAt: a.tokens.expiresAt,
      scopes: a.tokens.scopes,
      ...(needsReauthentication(a) ? { authExpired: true as const } : {}),
      ...(isTokenOnly(a.tokens) ? { tokenOnly: true as const } : {}),
    })),
    ...openAIAccounts.map(a => ({
      id: a.id,
      provider: "openai_subscription" as const,
      enabled: a.enabled !== false,
      expiresAt: a.expiresAt,
      ...(needsReauthentication(a) ? { authExpired: true as const } : {}),
    })),
    ...xaiAccounts.map(a => ({
      id: a.id,
      provider: "xai_subscription" as const,
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

/**
 * Rename an account on a running proxy. Returns false only when no proxy can
 * be reached (the caller then renames on disk); HTTP errors are authoritative
 * and thrown. A 200 whose returned account still carries the old id means the
 * proxy predates rename support — its patch validation drops unknown fields
 * and reports success having done nothing — and MUST be an error, not a
 * fallthrough to disk: that proxy's refresh loop persists its own snapshot
 * over accounts.json and would silently undo a disk-side rename.
 */
export async function tryRenameAccountOnRunningProxy(
  id: string,
  newId: string,
  options: LiveAccountRemovalOptions = {},
): Promise<boolean> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? `http://localhost:${PROXY_PORT}`).replace(/\/+$/, "");
  const authToken = options.authToken ?? readConfig().proxySecret;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/cc-router/accounts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ id: newId }),
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
  let renamedId: unknown;
  try {
    const payload = await response.json() as { account?: { id?: unknown } };
    renamedId = payload.account?.id;
  } catch { /* fall through to the mismatch error below */ }
  if (renamedId !== newId) {
    throw new Error(
      "the running proxy does not support rename (older version) — update and restart it first: cc-router stop --keep-config && cc-router start",
    );
  }
  return true;
}

export interface RuntimeAwareRenameDependencies {
  tryRenameLive(id: string, newId: string): Promise<boolean>;
  renameStored(id: string, newId: string): AccountRecord | null;
}

export async function renameAccountRuntimeAware(
  id: string,
  newId: string,
  dependencies: RuntimeAwareRenameDependencies = {
    tryRenameLive: tryRenameAccountOnRunningProxy,
    renameStored: renameAccountRecordById,
  },
): Promise<{ mode: "live" } | { mode: "stored"; renamed: AccountRecord }> {
  if (await dependencies.tryRenameLive(id, newId)) return { mode: "live" };
  const renamed = dependencies.renameStored(id, newId);
  if (!renamed) throw new Error(`Account "${id}" disappeared before it could be renamed`);
  return { mode: "stored", renamed };
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

export interface LiveAccountAddOptions {
  baseUrl?: string;
  authToken?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Ask the proxy to replace an account already holding this id rather than
   * refusing the add. This is what re-authenticating means: `accounts add`
   * already replaces by id on disk, and without the same intent on the live
   * pool the proxy answered 409 and the freshly minted refresh token was
   * thrown away. Off by default so the endpoint still protects any other
   * client from an accidental id collision.
   */
  replace?: boolean;
}

/**
 * Add an account to a running proxy so it becomes routable without a restart.
 * Returns false only when no running proxy can be reached (the caller then
 * persists to disk itself); HTTP error responses — e.g. 409 for a duplicate —
 * are authoritative and thrown so the caller does not silently write to disk.
 */
export async function tryAddAccountToRunningProxy(
  record: AccountRecord,
  options: LiveAccountAddOptions = {},
): Promise<boolean> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? `http://localhost:${PROXY_PORT}`).replace(/\/+$/, "");
  const authToken = options.authToken ?? readConfig().proxySecret;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/cc-router/accounts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(options.replace ? { ...record, replace: true } : record),
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

export interface RuntimeAwareAddDependencies {
  tryAddLive(record: AccountRecord): Promise<boolean>;
  addStored(record: AccountRecord): void;
}

/**
 * Persist a newly added account so it is usable immediately. When a proxy is
 * running the record is handed to it (live pool + disk in one step); otherwise
 * it is written to disk via `addStored` and picked up on the next start.
 */
export async function addAccountRuntimeAware(
  record: AccountRecord,
  dependencies: Partial<RuntimeAwareAddDependencies> = {},
): Promise<{ mode: "live" } | { mode: "stored" }> {
  // Each dependency defaults independently. Taking the whole object as one
  // default meant a caller that only needed its own `addStored` — the Claude
  // `accounts add` flow does, to merge by id — had to restate `tryAddLive`
  // too, and that restatement silently dropped the replacement request. The
  // path that most needs replacement was the one path not asking for it.
  const tryAddLive = dependencies.tryAddLive
    // `upsertAccountRecord` already replaces by id on disk; asking the live
    // pool for the same thing is what keeps the two halves of an `accounts
    // add` in agreement instead of failing on the account that most needs it.
    ?? (live => tryAddAccountToRunningProxy(live, { replace: true }));
  const addStored = dependencies.addStored ?? upsertAccountRecord;

  if (await tryAddLive(record)) return { mode: "live" };
  addStored(record);
  return { mode: "stored" };
}

/**
 * The command that recovers this account, whatever its provider.
 *
 * One command for every provider, because it resolves the provider from the id
 * itself — the previous per-provider hints had to guess, and guessing wrong
 * re-added the id under the wrong provider. It re-registers under the id the
 * operator already has, and the live pool replaces rather than rejects it, so
 * no deletion step is needed — which also avoids the running proxy refusing to
 * delete a lone Claude account.
 */
function reauthCommand(id: string): string {
  return `cc-router accounts reauth ${id}`;
}

async function fetchLiveStats(): Promise<null | Array<{
  id: string; provider?: string; healthy: boolean; busy: boolean;
  requestCount: number; errorCount: number; expiresInMs: number;
  authExpired?: boolean; authFailure?: string; authState?: string;
  tokenOnly?: boolean;
  accountInfo?: AccountInfo;
}>> {
  try {
    const { proxySecret } = readConfig();
    const res = await fetch(`http://localhost:${PROXY_PORT}/cc-router/accounts`, {
      headers: proxySecret ? { authorization: `Bearer ${proxySecret}` } : {},
      signal: AbortSignal.timeout(1_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      accounts: Array<{
        id: string; provider?: string; healthy: boolean; busy: boolean;
        requestCount: number; errorCount: number; expiresInMs: number;
        authExpired?: boolean; authFailure?: string; authState?: string;
        tokenOnly?: boolean;
        accountInfo?: AccountInfo;
      }>;
      operational?: {
        providers: {
          anthropic: { configured: boolean; accounts: number; healthy: number; enabled: number };
          openai: { configured: boolean; accounts: number; healthy: number; enabled: number };
          xai?: { configured: boolean; accounts: number; healthy: number; enabled: number };
        };
      };
    };
    if (!Array.isArray(data.accounts)) return null;
    const { mergeGrokIntoHealth } = await import("../providers/xai/overview.js");
    return mergeGrokIntoHealth(data).accounts.map(account => ({
      ...account, accountInfo: sanitizeAccountInfo(account.accountInfo),
    }));
  } catch {
    return null;
  }
}

function formatMs(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
