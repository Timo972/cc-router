import { parseSseLines } from "./sse.js";

export type CollectedCodexResponse =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "text"; status: number; contentType?: string; body: string };

interface CodexStreamEvent {
  type?: string;
  response?: unknown;
  error?: { message?: string };
}

function upstreamError(message: string): CollectedCodexResponse {
  return { kind: "json", status: 502, body: { error: { type: "upstream_error", message } } };
}

/**
 * Collapse the Codex backend's forced SSE stream into a single Responses
 * object for callers that did not ask to stream. The backend's terminal
 * `response.completed` payload is returned verbatim, preserving tool calls,
 * reasoning, and usage.
 */
export async function collectCodexResponseStream(
  upstream: globalThis.Response,
): Promise<CollectedCodexResponse> {
  if (!upstream.ok) {
    const contentType = upstream.headers.get("content-type") ?? undefined;
    return { kind: "text", status: upstream.status, contentType, body: await upstream.text() };
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return { kind: "json", status: upstream.status, body: await upstream.json() };
    } catch {
      return upstreamError("Malformed upstream JSON body");
    }
  }

  const reader = upstream.body?.getReader();
  if (!reader) return upstreamError("Empty upstream body");

  const decoder = new TextDecoder();
  let remainder = "";
  let completed: unknown;
  let failure: string | undefined;

  const applyEvent = (event: unknown): void => {
    if (typeof event !== "object" || event === null) return;
    const e = event as CodexStreamEvent;
    if (e.type === "response.completed") {
      completed = e.response;
    } else if (e.type === "response.failed") {
      const err = (e.response as { error?: { message?: string } } | undefined)?.error;
      failure = err?.message ?? "Response failed";
    } else if (e.type === "error") {
      failure = e.error?.message ?? "Upstream error event";
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }));
      remainder = parsed.remainder;
      for (const event of parsed.events) applyEvent(event);
    }
    const tail = remainder + decoder.decode();
    if (tail.length > 0) {
      for (const event of parseSseLines(tail + "\n").events) applyEvent(event);
    }
  } catch {
    return upstreamError("Malformed upstream stream");
  }

  if (failure !== undefined) return upstreamError(failure);
  if (completed === undefined) return upstreamError("Stream ended before response.completed");
  return { kind: "json", status: upstream.status, body: completed };
}

export interface CodexUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Extract usage totals from a response-shaped object (i.e. something with a
 * `.usage` field directly — the Responses `response.completed` payload, or
 * an object wrapping one). Shared by every ingress that needs to report
 * Codex token usage from a fully-materialized body.
 */
export function usageFromResponseBody(body: unknown): CodexUsageTotals | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const usage = (body as { usage?: { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown } } }).usage;
  if (usage === undefined || usage === null || typeof usage !== "object") return undefined;
  return {
    inputTokens: usageNumber(usage.input_tokens),
    cachedInputTokens: usageNumber(usage.input_tokens_details?.cached_tokens),
    outputTokens: usageNumber(usage.output_tokens),
  };
}

/**
 * Passive usage reader for the byte-transparent streaming path: it only
 * observes chunks that are already being piped downstream unchanged.
 */
export function createCodexUsageObserver(): {
  push(chunk: Uint8Array): void;
  finish(): CodexUsageTotals | undefined;
} {
  const decoder = new TextDecoder();
  let remainder = "";
  let totals: CodexUsageTotals | undefined;

  const applyEvent = (event: unknown): void => {
    if (typeof event !== "object" || event === null) return;
    const typed = event as {
      type?: unknown;
      response?: { usage?: { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown } } };
    };
    if (typed.type !== "response.completed") return;
    const usage = typed.response?.usage;
    if (usage === undefined || typeof usage !== "object") return;
    totals = {
      inputTokens: usageNumber(usage.input_tokens),
      cachedInputTokens: usageNumber(usage.input_tokens_details?.cached_tokens),
      outputTokens: usageNumber(usage.output_tokens),
    };
  };

  return {
    push(chunk: Uint8Array): void {
      // Best-effort: a malformed SSE frame from upstream must never throw
      // here. This observer only watches bytes that are already being
      // relayed to the client verbatim — a parse failure just means usage
      // for this chunk goes uncaptured, never that the response breaks.
      try {
        const parsed = parseSseLines(remainder + decoder.decode(chunk, { stream: true }));
        remainder = parsed.remainder;
        parsed.events.forEach(applyEvent);
      } catch {
        // swallow — passive observer, see comment above
      }
    },
    finish(): CodexUsageTotals | undefined {
      try {
        const tail = decoder.decode();
        if (tail || remainder) parseSseLines(remainder + tail + "\n").events.forEach(applyEvent);
      } catch {
        // swallow — passive observer, see comment above
      }
      remainder = "";
      return totals;
    },
  };
}
