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

interface RetainedCodexResponseTerminalObserver {
  push(chunk: Uint8Array): RetainedCodexResponseTerminal | undefined;
  finish(): RetainedCodexResponseTerminal;
}

export const MAX_CODEX_STREAM_EVENT_BYTES = 64 * 1024;
export const MAX_CODEX_COLLECTED_RESPONSE_BYTES = 10 * 1024 * 1024;

function createBoundedTerminalObserver(
  maxEventBytes: number,
  retainPayload: boolean,
): RetainedCodexResponseTerminalObserver {
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

    if (candidate.type === "response.completed" || candidate.type === "response.incomplete") {
      close(retainPayload
        ? { kind: candidate.type === "response.completed" ? "completed" : "incomplete", response: candidate.response }
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
  const push = (chunk: Uint8Array): RetainedCodexResponseTerminal | undefined => {
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
  };
  const finish = (): RetainedCodexResponseTerminal => {
    if (!terminal && lineBytes > 0) inspectLine(Buffer.concat(lineFragments, lineBytes));
    if (!terminal) close({ kind: "missing" });
    return terminal!;
  };

  return { push, finish };
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

function upstreamError(message: string): CollectedCodexResponse {
  return { kind: "json", status: 502, body: { error: { type: "upstream_error", message } } };
}

const RESPONSE_SIZE_ERROR = "Upstream response exceeded size limit";

type BoundedBodyRead =
  | { kind: "complete"; body: string }
  | { kind: "overflow" }
  | { kind: "error" };

async function readBodyWithinLimit(
  upstream: globalThis.Response,
  maxBytes: number,
): Promise<BoundedBodyRead> {
  const reader = upstream.body?.getReader();
  if (!reader) return { kind: "complete", body: "" };
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { kind: "overflow" };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return { kind: "error" };
  }
  return { kind: "complete", body: Buffer.concat(chunks, totalBytes).toString("utf8") };
}

/**
 * Collapse the Codex backend's forced SSE stream into a single Responses
 * object for callers that did not ask to stream. The backend's terminal
 * `response.completed` or `response.incomplete` payload is returned verbatim,
 * subject to the same explicit 10 MiB response bound as JSON collection.
 */
export async function collectCodexResponseStream(
  upstream: globalThis.Response,
): Promise<CollectedCodexResponse> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || contentType.includes("application/json")) {
    const read = await readBodyWithinLimit(upstream, MAX_CODEX_COLLECTED_RESPONSE_BYTES);
    if (read.kind === "overflow") return upstreamError(RESPONSE_SIZE_ERROR);
    if (read.kind === "error") return upstreamError("Malformed upstream stream");
    if (!upstream.ok) {
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
      const observed = observer.push(value);
      if (observed?.kind === "overflow") {
        void reader.cancel().catch(() => undefined);
        return upstreamError(RESPONSE_SIZE_ERROR);
      }
      if (observed?.kind === "malformed") {
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
    return upstreamError(terminal.message ?? (terminal.kind === "failed" ? "Response failed" : "Upstream error event"));
  }
  if (terminal.kind === "missing" || terminal.response === undefined) {
    return upstreamError("Stream ended before response.completed");
  }
  return { kind: "json", status: upstream.status, body: terminal.response };
}
