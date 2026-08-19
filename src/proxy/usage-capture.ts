import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
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
  onInputUsage(usage: Record<string, number>): void;
  /** message_delta usage (output tokens), or the sole usage object of a
   *  non-streaming JSON body. */
  onOutputUsage(usage: Record<string, number>): void;
}

export interface AnthropicUsageCapture {
  write(chunk: Buffer): void;
  end(): void;
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

  let dead = false;
  const die = () => {
    if (dead) return;
    dead = true;
    decoder?.destroy();
  };

  // ── SSE: incremental line parsing, stop once both events were seen ────────
  let lineBuf = "";
  let gotInput = false;
  let gotOutput = false;
  const parseSSEChunk = (text: string): void => {
    lineBuf += text;
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() ?? ""; // keep incomplete last line
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const evt = JSON.parse(line.slice(6)) as {
          type?: string;
          message?: { usage?: Record<string, number> };
          usage?: Record<string, number>;
        };
        if (!gotInput && evt.type === "message_start" && evt.message?.usage) {
          options.onInputUsage(evt.message.usage);
          gotInput = true;
        }
        if (!gotOutput && evt.type === "message_delta" && evt.usage) {
          options.onOutputUsage(evt.usage);
          gotOutput = true;
        }
        // Everything of interest has been seen — stop paying for the rest of
        // the stream (and free the decompressor's zlib state).
        if (gotInput && gotOutput) die();
      } catch { /* partial JSON across chunk boundary — next chunk completes it */ }
    }
  };

  // ── Non-streaming JSON: buffer, parse once at end ─────────────────────────
  let jsonBuf = "";
  const parseJSONBody = (): void => {
    try {
      const body = JSON.parse(jsonBuf) as { usage?: Record<string, number> };
      if (body.usage) {
        options.onInputUsage(body.usage);
        options.onOutputUsage(body.usage);
      }
    } catch { /* not a JSON body after all */ }
  };

  const consume = (chunk: Buffer): void => {
    if (dead) return;
    if (isSSE) {
      parseSSEChunk(chunk.toString("utf8"));
      return;
    }
    if (jsonBuf.length + chunk.length > MAX_JSON_BODY_BYTES) {
      die();
      return;
    }
    jsonBuf += chunk.toString("utf8");
  };
  const finish = (): void => {
    if (dead) return;
    if (isJSON) parseJSONBody();
    dead = true;
  };

  if (!decoder) {
    return {
      write: (chunk) => consume(chunk),
      end: () => finish(),
    };
  }

  decoder.on("data", (chunk: Buffer) => consume(chunk));
  decoder.on("end", () => finish());
  // Corrupt or truncated compressed data — the capture just stops; the
  // proxied bytes were never ours to begin with.
  decoder.on("error", () => die());
  return {
    write: (chunk) => {
      if (dead) return;
      decoder.write(chunk);
    },
    end: () => {
      if (dead) return;
      decoder.end();
    },
  };
}
