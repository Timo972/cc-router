export type CollectedCodexResponse =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "text"; status: number; contentType?: string; body: string };

interface CodexStreamEvent {
  type?: string;
  response?: unknown;
  error?: { message?: string };
}

type CodexResponseTerminalKind =
  | "completed"
  | "incomplete"
  | "failed"
  | "error"
  | "missing"
  | "malformed"
  | "overflow";

export interface CodexResponseTerminal {
  kind: CodexResponseTerminalKind;
}

interface RetainedCodexResponseTerminal extends CodexResponseTerminal {
  response?: unknown;
  message?: string;
}

export interface CodexResponseTerminalObserver {
  push(chunk: Uint8Array): CodexResponseTerminal | undefined;
  finish(): CodexResponseTerminal;
}

export const MAX_CODEX_STREAM_EVENT_BYTES = 64 * 1024;
export const MAX_CODEX_COLLECTED_RESPONSE_BYTES = 10 * 1024 * 1024;

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
 *
 * `{}` is the same problem wearing an object's clothes: it satisfies a bare
 * typeof check and then produces a `200` whose body is `{}`, or an empty
 * assistant turn on the Messages path. `id` is the field that separates a
 * Responses object from an empty husk — upstream stamps it from
 * `response.created` onward — so requiring it is what makes "is this an
 * object" mean "is this a response".
 */
export function terminalResponsePayload(event: unknown): unknown {
  if (typeof event !== "object" || event === null) return undefined;
  const typed = event as { type?: unknown; response?: unknown };
  if (typeof typed.type !== "string" || !TERMINAL_RESPONSE_EVENT_TYPES.has(typed.type)) {
    return undefined;
  }
  const payload = typed.response;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const { id } = payload as { id?: unknown };
  if (typeof id !== "string" || id.length === 0) return undefined;
  return payload;
}

function createBoundedTerminalObserver(
  maxEventBytes: number,
  retainPayload: boolean,
): {
  push(chunk: Uint8Array): RetainedCodexResponseTerminal | undefined;
  finish(): RetainedCodexResponseTerminal;
} {
  let lineFragments: Buffer[] = [];
  let lineBytes = 0;
  let terminal: RetainedCodexResponseTerminal | undefined;

  const clearLine = (): void => {
    lineFragments = [];
    lineBytes = 0;
  };
  const close = (next: RetainedCodexResponseTerminal): void => {
    if (terminal) return;
    terminal = next;
    clearLine();
  };
  const inspectLine = (line: Buffer): void => {
    if (terminal) return;
    const text = line.toString("utf8");
    if (!text.startsWith("data: ")) return;
    const payload = text.slice(6).trim();
    if (!payload || payload === "[DONE]") return;

    let candidate: CodexStreamEvent;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (typeof parsed !== "object" || parsed === null) return;
      candidate = parsed as CodexStreamEvent;
    } catch {
      close({ kind: "malformed" });
      return;
    }

    const response = terminalResponsePayload(candidate);
    if (response !== undefined) {
      close(retainPayload
        ? { kind: candidate.type === "response.completed" ? "completed" : "incomplete", response }
        : { kind: candidate.type === "response.completed" ? "completed" : "incomplete" });
    } else if (candidate.type === "response.failed") {
      const err = (candidate.response as { error?: { message?: string } } | undefined)?.error;
      close(retainPayload
        ? { kind: "failed", message: err?.message ?? "Response failed" }
        : { kind: "failed" });
    } else if (candidate.type === "error") {
      close(retainPayload
        ? { kind: "error", message: candidate.error?.message ?? "Upstream error event" }
        : { kind: "error" });
    }
  };

  return {
    push(chunk) {
      if (terminal) return terminal;
      let offset = 0;
      while (offset < chunk.byteLength && !terminal) {
        const newlineAt = chunk.indexOf(0x0a, offset);
        const fragmentEnd = newlineAt === -1 ? chunk.byteLength : newlineAt;
        const fragment = chunk.subarray(offset, fragmentEnd);
        if (lineBytes + fragment.byteLength > maxEventBytes) {
          close({ kind: "overflow" });
          break;
        }
        if (fragment.byteLength > 0) {
          lineFragments.push(Buffer.from(fragment));
          lineBytes += fragment.byteLength;
        }
        if (newlineAt === -1) break;
        inspectLine(Buffer.concat(lineFragments, lineBytes));
        clearLine();
        offset = newlineAt + 1;
      }
      return terminal;
    },
    finish() {
      if (!terminal && lineBytes > 0) inspectLine(Buffer.concat(lineFragments, lineBytes));
      if (!terminal) close({ kind: "missing" });
      return terminal!;
    },
  };
}

/** Observe only bounded framing state and a closed terminal classification. */
export function createCodexResponseTerminalObserver(): CodexResponseTerminalObserver {
  const observer = createBoundedTerminalObserver(MAX_CODEX_STREAM_EVENT_BYTES, false);
  return {
    push(chunk) {
      const result = observer.push(chunk);
      return result ? { kind: result.kind } : undefined;
    },
    finish() {
      return { kind: observer.finish().kind };
    },
  };
}

export const RESPONSE_SIZE_ERROR = "Upstream response exceeded size limit";

export type BoundedBodyRead =
  | { kind: "complete"; body: string }
  | { kind: "overflow" }
  | { kind: "cancelled" }
  | { kind: "error" };

export async function readBodyWithinLimit(
  upstream: globalThis.Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedBodyRead> {
  const reader = upstream.body?.getReader();
  if (!reader) return signal?.aborted ? { kind: "cancelled" } : { kind: "complete", body: "" };
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let cancellationStarted = false;
  let cancelPromise: Promise<void> | undefined;
  const cancelReader = (): Promise<void> => {
    if (!cancellationStarted) {
      cancellationStarted = true;
      try {
        cancelPromise = Promise.resolve(reader.cancel()).catch(() => undefined);
      } catch {
        cancelPromise = Promise.resolve();
      }
    }
    return cancelPromise!;
  };
  const abortSentinel = Symbol("body-read-aborted");
  let resolveAbort!: (value: typeof abortSentinel) => void;
  const abortPromise = new Promise<typeof abortSentinel>(resolve => {
    resolveAbort = resolve;
  });
  let abortObserved = false;
  const onAbort = (): void => {
    if (abortObserved) return;
    abortObserved = true;
    // Resolve the trusted local sentinel before cancellation can make a
    // pending Web Streams read look like an ordinary `{ done: true }` EOF.
    resolveAbort(abortSentinel);
    void cancelReader();
  };

  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // Covers an abort that happened before registration or in the narrow gap
    // between listener registration and this check.
    if (signal?.aborted) onAbort();
    if (abortObserved) {
      await cancelReader();
      return { kind: "cancelled" };
    }

    while (true) {
      let outcome: ReadableStreamReadResult<Uint8Array> | typeof abortSentinel;
      try {
        // Race the raw read promise, rather than a mapped derivative, so a
        // genuine reader rejection that settled before a same-tick abort wins
        // deterministically and remains upstream-owned.
        outcome = await Promise.race([reader.read(), abortPromise]);
      } catch {
        // A later client abort still has cleanup to join, but cannot rewrite
        // the upstream read failure that already won the race.
        if (abortObserved) await cancelReader();
        return { kind: "error" };
      }
      if (outcome === abortSentinel || abortObserved) {
        await cancelReader();
        return { kind: "cancelled" };
      }
      const { value, done } = outcome;
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await cancelReader();
        return { kind: "overflow" };
      }
      chunks.push(Buffer.from(value));
    }
    // Web Streams cancellation is allowed to resolve the pending read as EOF;
    // never publish a partial/empty body until the trusted abort state and its
    // cleanup promise have both been accounted for.
    if (abortObserved) {
      await cancelReader();
      return { kind: "cancelled" };
    }
    return { kind: "complete", body: Buffer.concat(chunks, totalBytes).toString("utf8") };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
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
  /** Invoked the moment upstream announces a failure, so the caller keeps that
   *  verdict even when the read is later cut short — the catch below turns any
   *  such interruption into a generic "malformed stream" and would otherwise
   *  bury it. */
  onUpstreamFailure?: () => void,
): Promise<CollectedCodexResponse> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || contentType.includes("application/json")) {
    const read = await readBodyWithinLimit(upstream, MAX_CODEX_COLLECTED_RESPONSE_BYTES);
    if (read.kind === "overflow") return upstreamError(RESPONSE_SIZE_ERROR);
    // This collector does not pass an abort signal, so cancellation is not a
    // reachable result here. Keep the union exhaustive if a caller adds one.
    if (read.kind === "cancelled") return upstreamError("Malformed upstream stream");
    if (read.kind === "error") return upstreamError("Malformed upstream stream");
    if (!upstream.ok) {
      onUpstreamFailure?.();
      return {
        kind: "text",
        status: upstream.status,
        contentType: contentType || undefined,
        body: read.body,
      };
    }
    try {
      return { kind: "json", status: upstream.status, body: JSON.parse(read.body) as unknown };
    } catch {
      return upstreamError("Malformed upstream JSON body");
    }
  }

  const reader = upstream.body?.getReader();
  if (!reader) return upstreamError("Empty upstream body");

  const observer = createBoundedTerminalObserver(MAX_CODEX_COLLECTED_RESPONSE_BYTES, true);
  let totalBytes = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_CODEX_COLLECTED_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return upstreamError(RESPONSE_SIZE_ERROR);
      }
      const terminal = observer.push(value);
      if (terminal?.kind === "overflow") {
        void reader.cancel().catch(() => undefined);
        return upstreamError(RESPONSE_SIZE_ERROR);
      }
      if (terminal?.kind === "malformed") {
        void reader.cancel().catch(() => undefined);
        return upstreamError("Malformed upstream stream");
      }
    }
  } catch {
    return upstreamError("Malformed upstream stream");
  }

  const terminal = observer.finish();
  if (terminal.kind === "overflow") return upstreamError(RESPONSE_SIZE_ERROR);
  if (terminal.kind === "malformed") return upstreamError("Malformed upstream stream");
  if (terminal.kind === "failed" || terminal.kind === "error") {
    onUpstreamFailure?.();
    return upstreamError(terminal.message ?? (terminal.kind === "failed" ? "Response failed" : "Upstream error event"));
  }
  if (terminal.kind === "missing" || terminal.response === undefined) {
    return upstreamError("Stream ended before any terminal response event");
  }
  return { kind: "json", status: upstream.status, body: terminal.response };
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
  let lineFragments: Buffer[] = [];
  let lineBytes = 0;
  let droppingOversizedLine = false;
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

  const clearLine = (): void => {
    lineFragments = [];
    lineBytes = 0;
  };
  const inspectLine = (): void => {
    if (lineBytes === 0) return;
    const line = Buffer.concat(lineFragments, lineBytes).toString("utf8");
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      applyEvent(JSON.parse(payload) as unknown);
    } catch {
      // Passive observer: malformed frames do not alter relayed response bytes.
    }
  };

  const pushBounded = (chunk: Uint8Array): void => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newlineAt = chunk.indexOf(0x0a, offset);
      const fragmentEnd = newlineAt === -1 ? chunk.byteLength : newlineAt;
      const fragment = chunk.subarray(offset, fragmentEnd);

      if (!droppingOversizedLine) {
        if (lineBytes + fragment.byteLength > MAX_CODEX_STREAM_EVENT_BYTES) {
          clearLine();
          droppingOversizedLine = newlineAt === -1;
        } else if (fragment.byteLength > 0) {
          lineFragments.push(Buffer.from(fragment));
          lineBytes += fragment.byteLength;
        }
      } else if (newlineAt !== -1) {
        droppingOversizedLine = false;
      }

      if (newlineAt === -1) break;
      if (!droppingOversizedLine) inspectLine();
      clearLine();
      offset = newlineAt + 1;
    }
  };

  return {
    push(chunk: Uint8Array): void {
      // Best-effort: a malformed SSE frame from upstream must never throw
      // here. This observer only watches bytes that are already being
      // relayed to the client verbatim — a parse failure just means that one
      // frame goes uncaptured, never that the response breaks. Tolerant
      // parsing keeps the rest of the chunk's valid events.
      try { pushBounded(chunk); } catch { /* passive observer */ }
    },
    finish(): CodexUsageTotals | undefined {
      try {
        if (!droppingOversizedLine) inspectLine();
      } catch { /* passive observer */ }
      clearLine();
      droppingOversizedLine = false;
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
