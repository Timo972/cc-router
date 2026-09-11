/**
 * One operator-triggered "reload everything" pass over the live pools —
 * what a router restart gives you, without dropping in-flight requests or
 * sticky sessions: expired cooldowns are swept, due (or quarantined) tokens
 * go through the same refresh path the background loops use, and every
 * account's usage is re-fetched immediately instead of waiting for its
 * scheduled slot.
 *
 * Provider-agnostic on purpose: each provider hands in its own token refresh
 * and usage hook, so the endpoint never learns OAuth or usage details.
 */

export interface RefreshablePoolSource<TAccount extends { id: string }> {
  /** Stable provider label used in the summary. */
  provider: string;
  getAll(): TAccount[];
  /** One pass of the provider's own scheduled token refresh (due accounts
   *  only). Resolves with how many accounts came out without usable
   *  credentials; a throw counts as the whole pass failing. */
  refreshTokens(): Promise<{ failed: number }>;
  /** Join or start this account's usage fetch; resolves with the settled outcome. */
  refreshUsage(account: TAccount): Promise<{ ok: boolean }>;
}

export interface RefreshAllOptions {
  /** Drop expired cooldown state before refreshing, mirroring the health poll. */
  sweepCooldowns?: () => void;
  now?: () => number;
  onError?: (provider: string, error: unknown) => void;
}

export interface RefreshAllProviderSummary {
  provider: string;
  accounts: number;
  usageRefreshed: number;
  usageFailed: number;
  /** Accounts whose token pass failed; the whole pass throwing counts every account. */
  tokenRefreshFailed: number;
}

export interface RefreshAllSummary {
  accounts: number;
  usageRefreshed: number;
  usageFailed: number;
  tokenRefreshFailed: number;
  durationMs: number;
  providers: RefreshAllProviderSummary[];
}

export async function refreshAllAccounts(
  sources: RefreshablePoolSource<{ id: string }>[],
  options: RefreshAllOptions = {},
): Promise<RefreshAllSummary> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  options.sweepCooldowns?.();

  const providers = await Promise.all(sources.map(async (source): Promise<RefreshAllProviderSummary> => {
    let tokenRefreshFailed = 0;
    try {
      tokenRefreshFailed = Math.max(0, (await source.refreshTokens()).failed);
    } catch (error) {
      tokenRefreshFailed = source.getAll().length;
      options.onError?.(source.provider, error);
    }

    // Snapshot AFTER the token pass — a refresh may have quarantined or
    // recovered accounts — and as a copy: the pools hand out their live
    // array, which an add/delete can mutate while usage fetches settle.
    const accounts = [...source.getAll()];
    const outcomes = await Promise.allSettled(accounts.map(account => source.refreshUsage(account)));
    let usageRefreshed = 0;
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled" && outcome.value.ok) usageRefreshed++;
      else if (outcome.status === "rejected") options.onError?.(source.provider, outcome.reason);
    }
    return {
      provider: source.provider,
      accounts: accounts.length,
      usageRefreshed,
      usageFailed: accounts.length - usageRefreshed,
      tokenRefreshFailed,
    };
  }));

  const total = (pick: (p: RefreshAllProviderSummary) => number) => providers.reduce((sum, p) => sum + pick(p), 0);
  return {
    accounts: total(p => p.accounts),
    usageRefreshed: total(p => p.usageRefreshed),
    usageFailed: total(p => p.usageFailed),
    tokenRefreshFailed: total(p => p.tokenRefreshFailed),
    durationMs: Math.max(0, now() - startedAt),
    providers,
  };
}

/**
 * Single-flight wrapper: a second reload request while one is running joins
 * the running one instead of starting another pass. Needed because the
 * dashboard's client deadline is shorter than the worst case of many
 * accounts all timing out — a client that gave up and pressed again must
 * not stack a second sweep on the pools.
 */
export function createRefreshAllRunner(
  run: () => Promise<RefreshAllSummary>,
): () => Promise<RefreshAllSummary> {
  let inFlight: Promise<RefreshAllSummary> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const operation = run().finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    inFlight = operation;
    return operation;
  };
}

/** Human-readable one-liner for the activity log and the dashboard banner. */
export function describeRefreshAll(summary: RefreshAllSummary): string {
  const failed = summary.usageFailed > 0 ? `, ${summary.usageFailed} usage fetch${summary.usageFailed === 1 ? "" : "es"} failed` : "";
  const tokens = summary.tokenRefreshFailed > 0 ? `, ${summary.tokenRefreshFailed} token refresh${summary.tokenRefreshFailed === 1 ? "" : "es"} failed` : "";
  return `reloaded ${summary.accounts} account${summary.accounts === 1 ? "" : "s"}, usage fresh for ${summary.usageRefreshed}${failed}${tokens} (${summary.durationMs}ms)`;
}
