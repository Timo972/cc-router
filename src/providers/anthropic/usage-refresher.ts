import type { Account, AccountUsageSnapshot } from "../../proxy/types.js";
import { UsageRefresher } from "../../proxy/usage-refresher.js";
import { fetchAnthropicUsage, type UsageFetchResult } from "./usage.js";
import {
  httpOutcome,
  recordRuntimeError,
  recordSafeLog,
  recordUpstreamStatus,
  withTelemetrySpan,
} from "../../telemetry/facade.js";

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
    const fetchUsage = options.fetchUsage ?? fetchAnthropicUsage;
    super(pool, {
      fetchUsage: account => withTelemetrySpan("provider.usage_refresh", { provider: "anthropic" },
        async span => {
          let result: UsageFetchResult;
          try {
            result = await fetchUsage(account);
          } catch (error) {
            recordRuntimeError(error, { operation: "provider.usage_refresh", provider: "anthropic" });
            throw error;
          }
          if (!result.ok) {
            if (result.status !== undefined) {
              recordUpstreamStatus("provider.usage_refresh", "anthropic", result.status);
              span.fail({ httpStatusCode: result.status, outcome: httpOutcome(result.status) });
            } else {
              // fetchAnthropicUsage resolves transport failures instead of
              // throwing, so the unsampled failure log is emitted here.
              const reason = result.reason === "timeout" ? "timeout"
                : result.reason === "network" ? "network_failure"
                : "other";
              const outcome = reason === "timeout" ? "timeout" : "upstream_error";
              recordSafeLog({
                operation: "provider.usage_refresh",
                provider: "anthropic",
                severity: "error",
                reason,
                outcome,
              });
              span.fail({ outcome });
            }
          }
          return result;
        }),
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
