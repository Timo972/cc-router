import { parseSseLines } from "./sse.js";

export type CollectedCodexResponse =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "text"; status: number; contentType?: string; body: string };

interface CodexStreamEvent {
  type?: string;
  response?: unknown;
  error?: { message?: string };
}

export type CodexResponseTerminal =
  | { kind: "completed"; response: unknown }
  | { kind: "incomplete"; response: unknown }
  | { kind: "failed"; message: string }
  | { kind: "error"; message: string }
  | { kind: "missing" };

export interface CodexResponseTerminalObserver {
  push(chunk: Uint8Array): void;
  finish(): CodexResponseTerminal;
}

/** Observe terminal Responses events while another consumer relays the same bytes. */
export function createCodexResponseTerminalObserver(): CodexResponseTerminalObserver {
  const decoder = new TextDecoder();
  let remainder = "";
  let terminal: CodexResponseTerminal | undefined;

  const applyEvent = (event: unknown): void => {
    if (terminal || typeof event !== "object" || event === null) return;
    const candidate = event as CodexStreamEvent;
    if (candidate.type === "response.completed") {
      terminal = { kind: "completed", response: candidate.response };
    } else if (candidate.type === "response.incomplete") {
      terminal = { kind: "incomplete", response: candidate.response };
    } else if (candidate.type === "response.failed") {
      const err = (candidate.response as { error?: { message?: string } } | undefined)?.error;
      terminal = { kind: "failed", message: err?.message ?? "Response failed" };
    } else if (candidate.type === "error") {
      terminal = { kind: "error", message: candidate.error?.message ?? "Upstream error event" };
    }
  };

  const parse = (input: string): void => {
    const parsed = parseSseLines(input);
    remainder = parsed.remainder;
    for (const event of parsed.events) applyEvent(event);
  };

  return {
    push(chunk) {
      parse(remainder + decoder.decode(chunk, { stream: true }));
    },
    finish() {
      const tail = remainder + decoder.decode();
      if (tail.length > 0) {
        remainder = "";
        for (const event of parseSseLines(tail + "\n").events) applyEvent(event);
      }
      return terminal ?? { kind: "missing" };
    },
  };
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
  const observer = createCodexResponseTerminalObserver();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      observer.push(value);
    }
  } catch {
    return upstreamError("Malformed upstream stream");
  }

  let terminal: CodexResponseTerminal;
  try {
    terminal = observer.finish();
  } catch {
    return upstreamError("Malformed upstream stream");
  }
  if (terminal.kind === "failed" || terminal.kind === "error") {
    return upstreamError(terminal.message);
  }
  if (terminal.kind === "missing" || terminal.response === undefined) {
    return upstreamError("Stream ended before response.completed");
  }
  return { kind: "json", status: upstream.status, body: terminal.response };
}
