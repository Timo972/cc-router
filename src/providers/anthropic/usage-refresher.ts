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
      telemetry: {
        provider: "anthropic",
        classifyResult: result => ({
          outcome: usageOutcome(result),
          ...(!result.ok ? {
            reason: usageReason(result),
            ...(result.status !== undefined ? { httpStatusCode: result.status } : {}),
          } : {}),
        }),
      },
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

function usageOutcome(result: UsageFetchResult): "complete" | "rate_limited" | "timeout" | "upstream_error" {
  if (result.ok) return "complete";
  if (result.reason === "timeout") return "timeout";
  if (result.reason === "http" && result.status === 429) return "rate_limited";
  return "upstream_error";
}

function usageReason(result: Exclude<UsageFetchResult, { ok: true }>): "unauthorized" | "forbidden" | "rate_limited" | "upstream_4xx" | "upstream_5xx" | "timeout" | "network_failure" | "unexpected_response_shape" {
  if (result.reason === "timeout") return "timeout";
  if (result.reason === "network") return "network_failure";
  if (result.reason === "invalid_json" || result.reason === "invalid_schema") {
    return "unexpected_response_shape";
  }
  if (result.status === 401) return "unauthorized";
  if (result.status === 403) return "forbidden";
  if (result.status === 429) return "rate_limited";
  return (result.status ?? 500) >= 500 ? "upstream_5xx" : "upstream_4xx";
}
