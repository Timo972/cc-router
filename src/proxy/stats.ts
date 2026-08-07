import type { StreamLifecycleState } from "./stream-lifecycle.js";
import type { CodexUsageTotals } from "../protocol/openai-responses-collect.js";

export interface LogEntry {
  ts: number;
  accountId: string;
  model: string;
  type: "route" | "refresh" | "error" | "warn";
  details?: string;
  statusCode?: number;
  durationMs?: number;
  method?: string;
  path?: string;
  source?: "cli" | "desktop" | "api";
  // Token usage from Anthropic response (message_start + message_delta events)
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  streamLifecycle?: StreamLifecycleState;
}

export type LocalRoutingErrorReason = "rate_limited" | "unavailable";

/** Build a bounded diagnostic for a request rejected before account selection. */
export function createLocalRoutingErrorLog(
  reason: LocalRoutingErrorReason,
  modelFamily?: string,
  now = Date.now(),
): LogEntry {
  return {
    ts: now,
    accountId: "proxy",
    model: modelFamily ?? "-",
    type: "error",
    details: `no-eligible:${reason.replace("_", "-")}`,
    statusCode: reason === "rate_limited" ? 429 : 503,
  };
}

const MAX_LOG_ENTRIES = 100;

class ProxyStats {
  totalRequests = 0;
  totalErrors = 0;
  totalRefreshes = 0;
  totalCacheReadTokens = 0;
  totalCacheCreationTokens = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  readonly startTime = Date.now();
  private logs: LogEntry[] = [];

  addLog(entry: LogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) this.logs.shift();
  }

  getRecentLogs(n = 20): LogEntry[] {
    return [...this.logs].reverse().slice(0, n);
  }

  getUptimeSeconds(): number {
    return Math.round((Date.now() - this.startTime) / 1000);
  }
}

// Singleton — shared across server and health endpoint
export const stats = new ProxyStats();

/** Record Codex token usage on both the request's log entry and the running totals. */
export function applyCodexUsage(entry: LogEntry, usage: CodexUsageTotals | undefined): void {
  if (!usage) return;
  entry.inputTokens = usage.inputTokens;
  entry.outputTokens = usage.outputTokens;
  entry.cacheReadTokens = usage.cachedInputTokens;
  stats.totalInputTokens += usage.inputTokens;
  stats.totalOutputTokens += usage.outputTokens;
  stats.totalCacheReadTokens += usage.cachedInputTokens;
}
