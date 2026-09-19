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
  /** Safe phase timing for provider diagnostics; no payload timing/content. */
  refreshDurationMs?: number;
  headerDurationMs?: number;
  firstByteDurationMs?: number;
  correlationId?: string;
  method?: string;
  path?: string;
  /** Which client sent the request. `codex` is the Codex CLI on `/v1/responses`;
   *  a Claude-shaped client whose model routes to OpenAI stays `cli`/`desktop`/`api`. */
  source?: "cli" | "desktop" | "api" | "codex";
  // Token usage from Anthropic response (message_start + message_delta events)
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  streamLifecycle?: StreamLifecycleState;
}

export type LocalRoutingErrorReason = "rate_limited" | "unavailable";

/**
 * Longest model identifier retained in an activity entry. Model names arrive
 * in request bodies the JSON parsers accept up to megabytes, and every entry
 * stays resident until MAX_LOG_ENTRIES newer ones push it out — and is
 * re-serialized into each health response meanwhile. Retaining one verbatim
 * would let a handful of requests pin hundreds of megabytes. Real model names
 * are far shorter than this; the same 64 that `normalizeModelSlug` and
 * `normalizeModelFamily` already clamp their identifiers to.
 */
const MAX_LOG_MODEL_LENGTH = 64;

/**
 * Clamp a caller-supplied model identifier to a length that is safe to retain.
 * Truncation only — an empty model stays empty so routing lookups behave
 * exactly as they did on the untruncated value.
 */
export function boundModelId(model: string): string {
  return model.length > MAX_LOG_MODEL_LENGTH ? model.slice(0, MAX_LOG_MODEL_LENGTH) : model;
}

/** Build a bounded diagnostic for a request rejected before account selection. */
export function createLocalRoutingErrorLog(
  reason: LocalRoutingErrorReason,
  modelFamily?: string,
  now = Date.now(),
): LogEntry {
  return {
    ts: now,
    accountId: "proxy",
    model: modelFamily ? boundModelId(modelFamily) : "-",
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

/**
 * Record Anthropic input-side usage (message_start, or a non-streaming JSON
 * body) on both the request's log entry and the running totals. Mutates an
 * entry that is typically already stored — the dashboard picks the values up
 * on its next poll.
 */
function applyCumulativeAnthropicCount(
  entry: LogEntry,
  field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens",
  total: "totalInputTokens" | "totalOutputTokens" | "totalCacheReadTokens" | "totalCacheCreationTokens",
  value: unknown,
): void {
  // Usage snapshots are cumulative. Absent or malformed fields are not new zeroes.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return;
  const previous = entry[field] ?? 0;
  if (value < previous) return;
  stats[total] += value - previous;
  entry[field] = value;
}

function applyAnthropicUsageSnapshot(entry: LogEntry, usage: AnthropicUsage): void {
  applyCumulativeAnthropicCount(entry, "inputTokens", "totalInputTokens", usage.input_tokens);
  applyCumulativeAnthropicCount(entry, "cacheReadTokens", "totalCacheReadTokens", usage.cache_read_input_tokens);
  applyCumulativeAnthropicCount(entry, "cacheCreationTokens", "totalCacheCreationTokens", usage.cache_creation_input_tokens);
  applyCumulativeAnthropicCount(entry, "outputTokens", "totalOutputTokens", usage.output_tokens);
}

export function applyAnthropicInputUsage(entry: LogEntry, usage: AnthropicUsage): void {
  notifyUsage(entry, { kind: "input", usage });
  applyAnthropicUsageSnapshot(entry, usage);
}

/** Record the positive difference from the preceding cumulative output snapshot. */
export function applyAnthropicOutputUsage(entry: LogEntry, usage: AnthropicUsage): void {
  notifyUsage(entry, { kind: "output", usage });
  applyAnthropicUsageSnapshot(entry, usage);
}

/** Record Codex token usage on both the request's log entry and the running totals. */
export function applyCodexUsage(entry: LogEntry, usage: CodexUsageTotals | undefined): void {
  if (!usage) return;
  notifyUsage(entry, { kind: "codex", usage });
  entry.inputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  entry.outputTokens = usage.outputTokens;
  entry.cacheReadTokens = usage.cachedInputTokens;
  stats.totalInputTokens += entry.inputTokens;
  stats.totalOutputTokens += usage.outputTokens;
  stats.totalCacheReadTokens += usage.cachedInputTokens;
}

/** Per-attempt passive hooks. Never serialize identity or persistence state into /health. */
export type AnthropicUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } };
export type UsageCaptureEvent =
  | { kind: "model"; model: unknown }
  | { kind: "input" | "output"; usage: AnthropicUsage }
  | { kind: "codex"; usage: CodexUsageTotals }
  | { kind: "codex-response"; body: unknown }
  | { kind: "finish"; complete: boolean }
  | { kind: "discard" };
const usageObservers = new WeakMap<LogEntry, (event: UsageCaptureEvent) => void>();
export function observeEntryUsage(entry: LogEntry, observer: (event: UsageCaptureEvent) => void): void { usageObservers.set(entry, observer); }
function notifyUsage(entry: LogEntry, event: UsageCaptureEvent): void {
  try { usageObservers.get(entry)?.(event); } catch { /* Persistence must never change routing/response bytes. */ }
}
export function setUsageModel(entry: LogEntry, model: unknown): void { notifyUsage(entry, { kind: "model", model }); }
export function captureCodexResponse(entry: LogEntry, body: unknown): void { notifyUsage(entry, { kind: "codex-response", body }); }
export function finishUsageAttempt(entry: LogEntry, complete: boolean): void { notifyUsage(entry, { kind: "finish", complete }); }

/** A bound candidate was never forwarded: release capture without inventing missing usage. */
export function discardUsageAttempt(entry: LogEntry): void {
  notifyUsage(entry, { kind: "discard" });
  usageObservers.delete(entry);
}
