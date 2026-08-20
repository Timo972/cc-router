import { applyAnthropicInputUsage, applyAnthropicOutputUsage } from "./stats.js";
import type { LogEntry } from "./stats.js";
import { createAnthropicUsageCapture } from "./usage-capture.js";
import { createStreamLifecycleTracker } from "./stream-lifecycle.js";
import type { LifecycleEmitter } from "./stream-lifecycle.js";

export interface CapturableUpstream extends LifecycleEmitter {
  headers: Record<string, string | string[] | undefined>;
  on(event: "data" | "end", listener: (chunk: Buffer) => void): unknown;
}

/**
 * Attach the passive observability taps to a relayed Anthropic response:
 * stream-lifecycle tracking and token-usage capture, both mutating the
 * already-recorded activity entry in place (the dashboard picks the values
 * up on its next poll).
 *
 * SSE streams carry usage across two events (message_start → input/cache
 * tokens, message_delta → output tokens); non-streaming JSON carries all
 * fields in one usage object. The proxy is byte-transparent and the client's
 * accept-encoding makes upstream compress, so the capture decompresses its
 * own copy of the stream (see usage-capture.ts) — previously compressed
 * responses were skipped, which in practice was EVERY response.
 *
 * Shared by the generic /v1 proxy and the retrying /v1/messages transport so
 * the two Anthropic relays can never drift on what they observe. Must run
 * BEFORE the response is piped to the client, in the same synchronous block,
 * so no data event can slip past the taps.
 */
export function attachAnthropicResponseCapture(
  upstream: CapturableUpstream,
  downstream: LifecycleEmitter,
  entry: LogEntry,
  startedAt: number,
): void {
  const contentType = String(upstream.headers["content-type"] ?? "");
  const encoding = String(upstream.headers["content-encoding"] ?? "");
  const isCompressed = /gzip|br|deflate/.test(encoding);
  const streamTracker = createStreamLifecycleTracker(
    startedAt,
    !isCompressed && contentType.includes("text/event-stream"),
  );
  entry.streamLifecycle = streamTracker.state;
  streamTracker.attach(upstream, downstream);
  upstream.on("data", (chunk: Buffer) => streamTracker.observeChunk(chunk));

  const usageCapture = createAnthropicUsageCapture({
    contentType,
    contentEncoding: encoding,
    onInputUsage: usage => applyAnthropicInputUsage(entry, usage),
    onOutputUsage: usage => applyAnthropicOutputUsage(entry, usage),
  });
  if (usageCapture) {
    upstream.on("data", (chunk: Buffer) => usageCapture.write(chunk));
    upstream.on("end", () => usageCapture.end());
  }
}
