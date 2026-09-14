import type { Command } from "commander";
import chalk from "chalk";
import { PROXY_PORT } from "../config/paths.js";
import { readConfig } from "../config/manager.js";

/**
 * Resolves where the proxy's HTTP API lives and which bearer token to use.
 *
 * The returned `authToken` is used for BOTH the (exempt) health endpoint and
 * for the authenticated /cc-router/accounts endpoints. Health doesn't need it
 * but the dashboard forwards a single `authToken` to Ink regardless.
 *
 * Local mode  → http://localhost:<port>,   bearer = config.proxySecret (may be undefined)
 * Client mode → cfg.client.remoteUrl,      bearer = cfg.client.remoteSecret
 */
export interface StatusTarget {
  baseUrl: string;
  healthUrl: string;
  headers: Record<string, string>;
  authToken?: string;
}

export function resolveStatusTarget(port: number): StatusTarget {
  const cfg = readConfig();
  if (cfg.client) {
    const base = cfg.client.remoteUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = {};
    if (cfg.client.remoteSecret) headers["authorization"] = `Bearer ${cfg.client.remoteSecret}`;
    return {
      baseUrl: base,
      healthUrl: `${base}/cc-router/health`,
      headers,
      authToken: cfg.client.remoteSecret,
    };
  }

  const base = `http://localhost:${port}`;
  const headers: Record<string, string> = {};
  if (cfg.proxySecret) headers["authorization"] = `Bearer ${cfg.proxySecret}`;
  return {
    baseUrl: base,
    healthUrl: `${base}/cc-router/health`,
    headers,
    authToken: cfg.proxySecret,
  };
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Live dashboard: account health, request counts, recent routing log")
    .option("--port <port>", "Proxy port to connect to", String(PROXY_PORT))
    .option("--json", "Output current stats as JSON and exit (non-interactive)")
    .action(async (opts: { port: string; json?: boolean }) => {
      const port = parseInt(opts.port, 10);

      if (opts.json) {
        await jsonOutput(port);
        return;
      }

      await dashboardLoop(port);
    });
}

async function jsonOutput(port: number): Promise<void> {
  const { healthUrl, headers } = resolveStatusTarget(port);
  try {
    const res = await fetch(healthUrl, {
      headers,
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) {
      console.error(chalk.red(`Proxy returned HTTP ${res.status}`));
      process.exit(1);
    }
    const { mergeGrokIntoHealth, loadGrokHealthSnapshotsWithSubscription } =
      await import("../providers/xai/overview.js");
    const health = await res.json() as {
      accounts: Array<{ provider?: string }>;
      operational?: {
        providers: {
          anthropic: { configured: boolean; accounts: number; healthy: number; enabled: number };
          openai: { configured: boolean; accounts: number; healthy: number; enabled: number };
          xai?: { configured: boolean; accounts: number; healthy: number; enabled: number };
        };
      };
    };
    const grokSnapshots = await loadGrokHealthSnapshotsWithSubscription();
    console.log(JSON.stringify(mergeGrokIntoHealth(health, grokSnapshots), null, 2));
  } catch {
    console.error(chalk.red(`Cannot connect to proxy at ${healthUrl}`));
    const cfg = readConfig();
    if (cfg.client) {
      console.error(chalk.gray("Is the remote CC-Router running?"));
    } else {
      console.error(chalk.gray("Is it running? Start with: cc-router start"));
    }
    process.exit(1);
  }
}

/**
 * Launches the Ink dashboard and handles "re-launch" intents.
 *
 * The dashboard cannot run inquirer prompts while Ink owns stdin, so when
 * the user presses `n` to add an account, Ink unmounts **completely** first.
 * Only after `waitUntilExit()` resolves — and stdin is restored from raw mode
 * — does the OAuth flow run. Once tokens are obtained and POSTed to the
 * server, the dashboard is re-rendered and polling resumes.
 *
 * IMPORTANT: The previous design resolved the outer promise from inside
 * `onIntent` (before Ink unmounted), then raced with `waitUntilExit`. That
 * caused inquirer to see a half-released stdin and force-close itself.
 * The fix: `onIntent` writes to a mutable variable; `waitUntilExit()`
 * is the ONLY thing that resolves the await; stdin is explicitly restored
 * before inquirer runs.
 */
async function dashboardLoop(port: number): Promise<void> {
  // Dynamic imports keep these heavy deps out of the cold-start path
  const [{ render }, { createElement }, { Dashboard }] = await Promise.all([
    import("ink"),
    import("react"),
    import("../ui/Dashboard.js"),
  ]);

  while (true) {
    const target = resolveStatusTarget(port);

    // `pendingIntent` is set by the Dashboard component via `onIntent`;
    // it defaults to "quit" so Ctrl+C (exitOnCtrlC) does the right thing
    // without the Dashboard ever firing onIntent.
    let pendingIntent: "quit" | "addAccount" = "quit";

    const instance = render(
      createElement(Dashboard, {
        port,
        baseUrl: target.baseUrl,
        authToken: target.authToken,
        onIntent: (i: "quit" | "addAccount") => { pendingIntent = i; },
      }),
      { exitOnCtrlC: true },
    );

    // Block until Ink has FULLY unmounted and released stdin.
    // The Dashboard's keyboard handler calls exit() for both `q` and `n`;
    // Ctrl+C also triggers exit via exitOnCtrlC.
    await instance.waitUntilExit();

    // Yield the event loop so any of Ink's pending stdin cleanup tasks
    // (listeners detach, raw-mode restore) run before inquirer grabs stdin.
    // Without this, inquirer can see a half-released stdin and throw
    // "User force closed the prompt".
    await new Promise<void>(resolve => setImmediate(resolve));

    // Ink leaves stdin in raw mode. Restore it before running inquirer or
    // exiting, otherwise the terminal may remain in a broken state.
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    // Ink may have paused stdin — resume it so inquirer can read input.
    process.stdin.resume();

    if (pendingIntent === "quit") return;

    // Intent: addAccount — run the OAuth flow, then POST the resulting
    // tokens to the server we're connected to (local or remote).
    console.log();
    console.log(chalk.cyan("→ Adding a new account..."));
    console.log();

    const added = await runAddAccountFlow(target);
    if (added) {
      console.log(chalk.green(`\n✓ Account "${added}" added. Returning to dashboard...\n`));
    } else {
      console.log(chalk.yellow("\n  No account added. Returning to dashboard...\n"));
    }
    // Fall through → loop re-renders the dashboard
  }
}

/**
 * Runs the existing setupSingleAccount() OAuth flow, then POSTs the resulting
 * tokens to /cc-router/accounts on the active target. Returns the new id on
 * success, or null if the user aborted / an error occurred.
 */
async function runAddAccountFlow(target: StatusTarget): Promise<string | null> {
  try {
    const { setupSingleAccount } = await import("./cmd-setup.js");
    // The index shown in the flow is just for display, pick something neutral.
    const account = await setupSingleAccount(1);
    if (!account) return null;

    const res = await fetch(`${target.baseUrl}/cc-router/accounts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...target.headers,
      },
      body: JSON.stringify({
        id: account.id,
        accessToken: account.tokens.accessToken,
        refreshToken: account.tokens.refreshToken,
        expiresAt: account.tokens.expiresAt,
        scopes: account.tokens.scopes,
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(chalk.red(`\n✗ Server rejected account: HTTP ${res.status}`));
      if (text) console.error(chalk.gray(`  ${text}`));
      return null;
    }
    return account.id;
  } catch (err) {
    console.error(chalk.red(`\n✗ Failed to add account: ${(err as Error).message}`));
    return null;
  }
}
