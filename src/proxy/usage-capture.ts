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
  /** Decoded bytes for terminal SSE inspection. Never receives compressed
   *  source bytes. */
  onDecodedChunk?(chunk: Buffer): void;
}

export interface AnthropicUsageCapture {
  write(chunk: Buffer): void;
  end(): void;
  readonly finished: Promise<void>;
}

/** Non-streaming bodies are buffered for one parse at end-of-stream; a body
 *  past this size stops being buffered (usage is best-effort diagnostics —
 *  unbounded buffering of a pathological body is not worth it). */
const MAX_JSON_BODY_BYTES = 20 * 1024 * 1024;
const MAX_SSE_USAGE_LINE_BYTES = 64 * 1024;

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
  let resolveFinished!: () => void;
  let finishedSettled = false;
  const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
  const settleFinished = (): void => {
    if (finishedSettled) return;
    finishedSettled = true;
    resolveFinished();
  };
  const die = () => {
    if (dead) return;
    dead = true;
    decoder?.destroy();
    settleFinished();
  };

  // ── SSE: incremental line parsing, stop once both events were seen ────────
  let lineBuf = "";
  let gotInput = false;
  let gotOutput = false;
  let usageComplete = false;
  let usageParsingStopped = false;
  let lineBufBytes = 0;
  const stopUsageParsing = (): void => {
    usageParsingStopped = true;
    lineBuf = "";
    lineBufBytes = 0;
    if (!options.onDecodedChunk) die();
  };
  const parseSSELine = (line: string): void => {
    if (!line.startsWith("data: ")) return;
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
      if (gotInput && gotOutput) {
        usageComplete = true;
        stopUsageParsing();
      }
    } catch { /* malformed complete data lines are irrelevant to usage capture */ }
  };
  const parseSSEChunk = (text: string): void => {
    if (usageComplete || usageParsingStopped) return;
    let offset = 0;
    while (offset < text.length) {
      const newlineAt = text.indexOf("\n", offset);
      const fragmentEnd = newlineAt === -1 ? text.length : newlineAt;
      const fragment = text.slice(offset, fragmentEnd);
      const fragmentBytes = Buffer.byteLength(fragment, "utf8");
      if (lineBufBytes + fragmentBytes > MAX_SSE_USAGE_LINE_BYTES) {
        stopUsageParsing();
        return;
      }
      lineBuf += fragment;
      lineBufBytes += fragmentBytes;
      if (newlineAt === -1) return;
      parseSSELine(lineBuf);
      lineBuf = "";
      lineBufBytes = 0;
      if (usageComplete || usageParsingStopped) return;
      offset = newlineAt + 1;
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
    try { options.onDecodedChunk?.(chunk); } catch { /* passive observer */ }
    if (isSSE) {
      if (!usageComplete && !usageParsingStopped) parseSSEChunk(chunk.toString("utf8"));
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
    settleFinished();
  };

  if (!decoder) {
    return {
      write: (chunk) => consume(chunk),
      end: () => finish(),
      finished,
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
      try { decoder.write(chunk); } catch { die(); }
    },
    end: () => {
      if (dead) return;
      try { decoder.end(); } catch { die(); }
    },
    finished,
  };
}
