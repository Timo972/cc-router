import { describe, expect, it, vi } from "vitest";
import { brotliCompressSync, gzipSync, deflateSync } from "node:zlib";
import { createAnthropicUsageCapture } from "../proxy/usage-capture.js";

const INPUT_USAGE = { input_tokens: 12, cache_read_input_tokens: 300, cache_creation_input_tokens: 7 };
const OUTPUT_USAGE = { output_tokens: 42 };

function sseBody(): Buffer {
  return Buffer.from([
    `data: ${JSON.stringify({ type: "message_start", message: { usage: INPUT_USAGE } })}`,
    "",
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } })}`,
    "",
    `data: ${JSON.stringify({ type: "message_delta", usage: OUTPUT_USAGE })}`,
    "",
    "",
  ].join("\n"), "utf8");
}

function harness(contentType: string, contentEncoding: string) {
  const onInputUsage = vi.fn();
  const onOutputUsage = vi.fn();
  const capture = createAnthropicUsageCapture({ contentType, contentEncoding, onInputUsage, onOutputUsage });
  return { capture, onInputUsage, onOutputUsage };
}

/** Feed a buffer in awkward small slices, like TCP would. */
function feed(capture: { write(chunk: Buffer): void; end(): void }, body: Buffer, sliceSize = 7): void {
  for (let offset = 0; offset < body.length; offset += sliceSize) {
    capture.write(body.subarray(offset, offset + sliceSize));
  }
  capture.end();
}

async function settle(): Promise<void> {
  // Decompression is stream-based and asynchronous; give it a few ticks.
  await new Promise(resolve => setTimeout(resolve, 20));
}

describe("createAnthropicUsageCapture", () => {
  it("parses usage from an uncompressed SSE stream split across chunks", async () => {
    const { capture, onInputUsage, onOutputUsage } = harness("text/event-stream", "");
    feed(capture!, sseBody());
    await settle();

    expect(onInputUsage).toHaveBeenCalledWith(INPUT_USAGE);
    expect(onOutputUsage).toHaveBeenCalledWith(OUTPUT_USAGE);
  });

  it("parses usage from a gzip-compressed SSE stream", async () => {
    // The whole point of this module: the proxy is byte-transparent, so the
    // client's accept-encoding makes upstream compress — and before this
    // existed, every compressed response silently lost its usage attribution
    // (no cache rate on any Anthropic activity row).
    const { capture, onInputUsage, onOutputUsage } = harness("text/event-stream; charset=utf-8", "gzip");
    feed(capture!, gzipSync(sseBody()));
    await settle();

    expect(onInputUsage).toHaveBeenCalledWith(INPUT_USAGE);
    expect(onOutputUsage).toHaveBeenCalledWith(OUTPUT_USAGE);
  });

  it("parses usage from a brotli-compressed JSON body", async () => {
    const { capture, onInputUsage, onOutputUsage } = harness("application/json", "br");
    feed(capture!, brotliCompressSync(Buffer.from(JSON.stringify({
      id: "msg_1",
      usage: { ...INPUT_USAGE, ...OUTPUT_USAGE },
    }))));
    await settle();

    expect(onInputUsage).toHaveBeenCalledWith({ ...INPUT_USAGE, ...OUTPUT_USAGE });
    expect(onOutputUsage).toHaveBeenCalledWith({ ...INPUT_USAGE, ...OUTPUT_USAGE });
  });

  it("parses usage from a deflate-compressed JSON body", async () => {
    const { capture, onInputUsage } = harness("application/json", "deflate");
    feed(capture!, deflateSync(Buffer.from(JSON.stringify({ usage: INPUT_USAGE }))));
    await settle();

    expect(onInputUsage).toHaveBeenCalledWith(INPUT_USAGE);
  });

  it("returns null for content types and encodings it cannot parse", () => {
    expect(createAnthropicUsageCapture({
      contentType: "text/html", contentEncoding: "",
      onInputUsage: vi.fn(), onOutputUsage: vi.fn(),
    })).toBeNull();
    expect(createAnthropicUsageCapture({
      contentType: "text/event-stream", contentEncoding: "snappy",
      onInputUsage: vi.fn(), onOutputUsage: vi.fn(),
    })).toBeNull();
  });

  it("survives corrupt compressed bytes without throwing or reporting usage", async () => {
    const { capture, onInputUsage, onOutputUsage } = harness("text/event-stream", "gzip");
    feed(capture!, Buffer.from("definitely not gzip"));
    await settle();

    expect(onInputUsage).not.toHaveBeenCalled();
    expect(onOutputUsage).not.toHaveBeenCalled();
  });
});
