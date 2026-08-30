import type { Account, AccountUsageSnapshot } from "../../proxy/types.js";
import { UsageRefresher } from "../../proxy/usage-refresher.js";
import { fetchAnthropicUsage, type UsageFetchResult } from "./usage.js";

export interface UsageAccountPool {
  getAll(): Account[];
  findById(id: string): Account | null;
}

export interface AnthropicUsageRefresherOptions {
  fetchUsage?: (account: Account) => Promise<UsageFetchResult>;
  now?: () => number;
  startupStaggerMs?: number;
  maxConcurrent?: number;
}

/**
 * The Anthropic instantiation of the shared usage scheduler (see
 * proxy/usage-refresher.ts for the timing/identity guarantees): fetches the
 * OAuth usage endpoint and lands snapshots on `account.rateLimits.usage`,
 * downgrading prior data to "stale" (or marking "unavailable") on failure.
 */
export class AnthropicUsageRefresher extends UsageRefresher<Account, UsageFetchResult> {
  constructor(pool: UsageAccountPool, options: AnthropicUsageRefresherOptions = {}) {
    const now = options.now ?? Date.now;
    super(pool, {
      fetchUsage: options.fetchUsage ?? fetchAnthropicUsage,
      cancelledResult: () => ({ ok: false, reason: "network" }),
      applyResult: (account, result) => {
        if (result.ok) {
          account.rateLimits = { ...account.rateLimits, usage: result.snapshot };
          return;
        }
        const prior = account.rateLimits.usage;
        const usage: AccountUsageSnapshot = prior
          ? { ...prior, fetchStatus: "stale" }
          : { modelLimits: [], fetchedAt: now(), fetchStatus: "unavailable" };
        account.rateLimits = { ...account.rateLimits, usage };
      },
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.startupStaggerMs !== undefined ? { startupStaggerMs: options.startupStaggerMs } : {}),
      ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
    });
  }
}
