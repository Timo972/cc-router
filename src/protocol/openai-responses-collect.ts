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
 * SSE event types that represent a Responses stream reaching a terminal
 * *result*, as opposed to a transport/backend failure.
 *
 * `response.completed` is the ordinary success terminal event.
 * `response.incomplete` is also terminal: Codex/OpenAI emit it when
 * generation stops without completing — most commonly hitting
 * `max_output_tokens`, or a content filter — but the event still carries a
 * full response object with `usage` and `incomplete_details.reason`. It is a
 * *result* to relay, not an error, so it belongs here rather than alongside
 * `response.failed`.
 *
 * `response.failed` and the bare `error` event are failures, not results:
 * they carry no usable response body and are handled separately by every
 * caller below.
 */
const TERMINAL_RESPONSE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "response.completed",
  "response.incomplete",
]);

/**
 * Returns the `.response` payload carried by a terminal Responses SSE event
 * (`response.completed` or `response.incomplete`), or `undefined` for any
 * other event — including `response.failed`/`error`, which are failures and
 * carry no usable response to return. Shared by every ingress that needs to
 * recognize "the stream produced a result", so that notion cannot drift
 * apart between the `/v1/responses` and `/v1/messages` paths.
 *
 * The event type alone does not make a result: it has to carry an actual
 * response object. Upstream can emit `{"type":"response.incomplete",
 * "response":null}` — or a string, a number, an array — and every consumer
 * here asks whether the payload is `undefined`, so anything else would count
 * as a terminal success. That would hand a `200` with a `null` body to a
 * non-streaming caller and mark an observed stream complete, which is exactly
 * what the terminal-event checks exist to prevent. A payload nothing can be
 * read out of is not a result.
 */
export function terminalResponsePayload(event: unknown): unknown {
  if (typeof event !== "object" || event === null) return undefined;
  const typed = event as { type?: unknown; response?: unknown };
  if (typeof typed.type !== "string" || !TERMINAL_RESPONSE_EVENT_TYPES.has(typed.type)) {
    return undefined;
  }
  const payload = typed.response;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  return payload;
}

/**
 * Collapse the Codex backend's forced SSE stream into a single Responses
 * object for callers that did not ask to stream. The backend's terminal
 * `response.completed` or `response.incomplete` payload is returned
 * verbatim, preserving tool calls, reasoning, and usage — including for a
 * response that stopped early (e.g. hitting the output-token ceiling), which
 * is a usable partial answer, not a transport failure.
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
  let terminalResponse: unknown;
  let failure: string | undefined;

  const applyEvent = (event: unknown): void => {
    const payload = terminalResponsePayload(event);
    if (payload !== undefined) {
      terminalResponse = payload;
      return;
    }
    if (typeof event !== "object" || event === null) return;
    const e = event as CodexStreamEvent;
    if (e.type === "response.failed") {
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
  if (terminalResponse === undefined) return upstreamError("Stream ended before any terminal response event");
  return { kind: "json", status: upstream.status, body: terminalResponse };
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
 * `.usage` field directly — the Responses `response.completed`/
 * `response.incomplete` payload, or an object wrapping one). Shared by every
 * ingress that needs to report Codex token usage from a fully-materialized
 * body.
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
 * Extract usage totals from a terminal Responses SSE event —
 * `response.completed` or `response.incomplete`, see
 * `TERMINAL_RESPONSE_EVENT_TYPES` above — or `undefined` for any other
 * event. Single definition shared by every streaming ingress so
 * `/v1/responses` and `/v1/messages` can never report different token totals
 * for the same stream.
 */
export function usageFromTerminalEvent(event: unknown): CodexUsageTotals | undefined {
  return usageFromResponseBody(terminalResponsePayload(event));
}

/**
 * Passive usage reader for the byte-transparent streaming path: it only
 * observes chunks that are already being piped downstream unchanged. It also
 * watches for a `response.failed`/`error` event — the same terminal-failure
 * signal `collectCodexResponseStream` above already detects for the
 * non-streaming path — so a stream that upstream answered with `200` but
 * ended in failure can still be reported (for stats/activity only) as the
 * failure it was, without altering a single byte written to the client.
 */
export function createCodexUsageObserver(): {
  push(chunk: Uint8Array): void;
  finish(): CodexUsageTotals | undefined;
  /** The failure message observed via `response.failed`/`error`, or a
   *  synthetic one if the stream ended without ever observing a valid
   *  terminal response event (`response.completed`/`response.incomplete`).
   *  Only meaningful after `finish()` has been called — earlier chunks may
   *  not yet have carried the terminal event. */
  failure(): string | undefined;
  /** Only the failure upstream stated outright (`response.failed`/`error`),
   *  never the synthetic "no terminal event" verdict. A client that hangs up
   *  mid-stream manufactures the latter and cannot manufacture the former, so
   *  callers deciding whether a disconnect explains a failure need the two
   *  kept apart. */
  explicitFailure(): string | undefined;
} {
  const decoder = new TextDecoder();
  let remainder = "";
  let totals: CodexUsageTotals | undefined;
  let failure: string | undefined;
  let completed = false;

  const applyEvent = (event: unknown): void => {
    totals = usageFromTerminalEvent(event) ?? totals;
    if (typeof event !== "object" || event === null) return;
    const e = event as CodexStreamEvent;
    if (e.type === "response.failed") {
      const err = (e.response as { error?: { message?: string } } | undefined)?.error;
      failure = err?.message ?? "Response failed";
    } else if (e.type === "error") {
      failure = e.error?.message ?? "Upstream error event";
    } else if (terminalResponsePayload(event) !== undefined) {
      completed = true;
    }
  };

  return {
    push(chunk: Uint8Array): void {
      // Best-effort: a malformed SSE frame from upstream must never throw
      // here. This observer only watches bytes that are already being
      // relayed to the client verbatim — a parse failure just means that one
      // frame goes uncaptured, never that the response breaks. Tolerant
      // parsing keeps the rest of the chunk's valid events.
      try {
        const parsed = parseSseLines(remainder + decoder.decode(chunk, { stream: true }), { tolerant: true });
        remainder = parsed.remainder;
        parsed.events.forEach(applyEvent);
      } catch {
        // swallow — passive observer, see comment above
      }
    },
    finish(): CodexUsageTotals | undefined {
      try {
        const tail = decoder.decode();
        if (tail || remainder) {
          parseSseLines(remainder + tail + "\n", { tolerant: true }).events.forEach(applyEvent);
        }
      } catch {
        // swallow — passive observer, see comment above
      }
      remainder = "";
      return totals;
    },
    failure(): string | undefined {
      // Tolerant parsing drops a malformed frame instead of aborting, which
      // also means a malformed *terminal* response event (`response.completed`
      // or `response.incomplete`) frame vanishes silently. Without an
      // observed terminal event the stream never actually produced a result,
      // so — mirroring collectCodexResponseStream's non-streaming check —
      // that is reported as a failure too, unless an explicit
      // response.failed/error already said more about what went wrong.
      return failure ?? (completed ? undefined : "Upstream stream ended before any terminal response event");
    },
    explicitFailure(): string | undefined {
      return failure;
    },
  };
}
