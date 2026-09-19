import { StringDecoder } from "node:string_decoder";
import type { AnthropicUsage } from "./stats.js";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { MAX_RETAINED_SSE_LINE_BYTES } from "./stream-lifecycle.js";
import type { Transform } from "node:stream";

/**
 * Passive token-usage capture for Anthropic responses flowing through the
 * byte-transparent proxy.
 *
 * The proxy forwards upstream bytes untouched, and the client's own
 * `accept-encoding` makes upstream compress — so the observability tap has
 * to decompress its OWN copy of the stream. Before this existed the parser
 * simply skipped compressed responses "safely", which in practice meant
 * every Anthropic activity row lost its usage attribution (no cache rate,
 * no token counts) because Claude Code always requests compression.
 *
 * Strictly best-effort: nothing here may ever affect the proxied response.
 * A decompression error, corrupt frame, or unsupported coding silently ends
 * the capture; the client keeps receiving the original bytes regardless.
 */
export interface AnthropicUsageCaptureOptions {
  contentType: string;
  contentEncoding: string;
  /** message_start usage (input/cache tokens), or the sole usage object of a
   *  non-streaming JSON body. */
  onInputUsage(usage: AnthropicUsage): void;
  /** message_delta usage (output tokens), or the sole usage object of a
   *  non-streaming JSON body. */
  onOutputUsage(usage: AnthropicUsage): void;
  /** Fired once when the capture has seen everything it will see (end,
   *  size cap, or decoder error). Compressed bodies decode asynchronously,
   *  so this can trail the relayed response's own close event. */
  onSettled?(): void;
  onModel?(model: unknown): void;
  onJSONComplete?(): void;
  /** Fired when the decoded SSE copy carries the `message_stop` terminal event.
   *  Providing it keeps the passive decoder running to the end of the stream
   *  (instead of stopping after both usage events) so a compressed stream's
   *  completion can be verified without touching the forwarded bytes. */
  onMessageStop?(): void;
}

export interface AnthropicUsageCapture {
  write(chunk: Buffer): void;
  end(): void;
  abort(): void;
}

/** Non-streaming bodies are buffered for one parse at end-of-stream; a body
 *  past this size stops being buffered (usage is best-effort diagnostics —
 *  unbounded buffering of a pathological body is not worth it). */
const MAX_JSON_BODY_BYTES = 20 * 1024 * 1024;

function createDecoder(contentEncoding: string): Transform | null | undefined {
  const encoding = contentEncoding.trim().toLowerCase();
  // `identity` and absent mean the bytes are already readable.
  if (encoding === "" || encoding === "identity") return null;
  if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
  if (encoding === "br") return createBrotliDecompress();
  if (encoding === "deflate") return createInflate();
  // Multi-codings ("gzip, br") and unknown codings are not worth chasing.
  return undefined;
}

export function createAnthropicUsageCapture(
  options: AnthropicUsageCaptureOptions,
): AnthropicUsageCapture | null {
  const isSSE = options.contentType.includes("text/event-stream");
  const isJSON = options.contentType.includes("application/json");
  if (!isSSE && !isJSON) return null;

  const decoder = createDecoder(options.contentEncoding);
  if (decoder === undefined) return null;

  const textDecoder = new StringDecoder("utf8");
  let dead = false;
  const die = () => {
    if (dead) return;
    dead = true;
    decoder?.destroy();
    options.onSettled?.();
  };

  // ── SSE: incremental line parsing, stop once both events were seen ────────
  let lineBuf = "";
  let discardingOversizedLine = false;
  let gotInput = false;
  let gotOutput = false;
  const parseSSEChunk = (text: string): void => {
    let rest = text;
    if (discardingOversizedLine) {
      const newline = rest.indexOf("\n");
      if (newline === -1) return; // still inside the oversized line
      rest = rest.slice(newline + 1);
      discardingOversizedLine = false;
    }
    if (!rest.includes("\n")) {
      // No line boundary yet: retain a bounded partial line and never re-split
      // the accumulated tail (an unterminated tail would otherwise cost
      // quadratic work and unbounded memory).
      if (lineBuf.length + rest.length > MAX_RETAINED_SSE_LINE_BYTES) {
        lineBuf = "";
        discardingOversizedLine = true;
      } else {
        lineBuf += rest;
      }
      return;
    }
    const lines = (lineBuf + rest).split("\n");
    lineBuf = lines.pop() ?? ""; // keep incomplete last line
    if (lineBuf.length > MAX_RETAINED_SSE_LINE_BYTES) {
      lineBuf = "";
      discardingOversizedLine = true;
    }
    for (const line of lines) {
      if (dead) return;
      if (line.length > MAX_RETAINED_SSE_LINE_BYTES || !line.startsWith("data:")) continue;
      try {
        const evt = JSON.parse(line.slice(5).trimStart()) as {
          type?: string;
          message?: { model?: unknown; usage?: AnthropicUsage };
          usage?: AnthropicUsage;
        };
        if (evt.type === "message_start") options.onModel?.(evt.message?.model);
        if (!gotInput && evt.type === "message_start" && evt.message?.usage) {
          options.onInputUsage(evt.message.usage);
          gotInput = true;
        }
        if ((!gotOutput || options.onMessageStop) && evt.type === "message_delta" && evt.usage) {
          options.onOutputUsage(evt.usage);
          gotOutput = true;
        }
        if (evt.type === "message_stop") {
          // The terminal event is the last thing of interest on the stream.
          options.onMessageStop?.();
          die();
          return;
        }
        // Everything of interest has been seen — stop paying for the rest of
        // the stream (and free the decompressor's zlib state), unless the
        // caller also wants the terminal event.
        if (gotInput && gotOutput && !options.onMessageStop) die();
      } catch { /* partial JSON across chunk boundary — next chunk completes it */ }
    }
  };

  // ── Non-streaming JSON: buffer, parse once at end ─────────────────────────
  let jsonBuf = "";
  const parseJSONBody = (): void => {
    try {
      const body = JSON.parse(jsonBuf) as { model?: unknown; usage?: AnthropicUsage };
      options.onModel?.(body.model);
      if (body.usage) {
        options.onInputUsage(body.usage);
        options.onOutputUsage(body.usage);
        options.onJSONComplete?.();
      }
    } catch { /* not a JSON body after all */ }
  };

  const consume = (chunk: Buffer): void => {
    if (dead) return;
    if (isSSE) {
      parseSSEChunk(textDecoder.write(chunk));
      return;
    }
    if (jsonBuf.length + chunk.length > MAX_JSON_BODY_BYTES) {
      die();
      return;
    }
    jsonBuf += textDecoder.write(chunk);
  };
  const finish = (): void => {
    if (dead) return;
    if (isJSON) { jsonBuf += textDecoder.end(); parseJSONBody(); }
    else parseSSEChunk(textDecoder.end() + "\n");
    if (dead) return;
    dead = true;
    options.onSettled?.();
  };

  if (!decoder) {
    return {
      write: (chunk) => consume(chunk),
      end: () => finish(),
      abort: die,
    };
  }

  decoder.on("data", (chunk: Buffer) => consume(chunk));
  decoder.on("end", () => finish());
  // Corrupt or truncated compressed data — the capture just stops; the
  // proxied bytes were never ours to begin with.
  decoder.on("error", () => die());
  let ending = false;
  const endDecoder = () => { if (dead || ending) return; ending = true; decoder.end(); };
  return {
    // Flush already received compressed input even when its gzip trailer never arrived.
    abort: endDecoder,
    write: (chunk) => {
      if (dead || ending) return;
      decoder.write(chunk);
    },
    end: endDecoder,
  };
}
