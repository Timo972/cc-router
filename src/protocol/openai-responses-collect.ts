import { parseSseLines } from "./sse.js";

export type CollectedCodexResponse =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "text"; status: number; body: string };

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
    return { kind: "text", status: upstream.status, body: await upstream.text() };
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
