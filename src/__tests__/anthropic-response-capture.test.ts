import { EventEmitter } from "node:events";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  attachAnthropicResponseCapture,
  type CapturableUpstream,
} from "../proxy/anthropic-response-capture.js";
import type { LogEntry } from "../proxy/stats.js";

const completeSse = Buffer.from([
  `data: ${JSON.stringify({
    type: "message_start",
    message: { usage: { input_tokens: 12, cache_read_input_tokens: 3 } },
  })}`,
  "",
  `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } })}`,
  "",
  `data: ${JSON.stringify({ type: "message_stop" })}`,
  "",
  "",
].join("\n"));

function upstream(contentEncoding: string): CapturableUpstream & EventEmitter {
  return Object.assign(new EventEmitter(), {
    headers: {
      "content-type": "text/event-stream",
      "content-encoding": contentEncoding,
    },
  }) as CapturableUpstream & EventEmitter;
}

function entry(): LogEntry {
  return { ts: 1, accountId: "anthropic-1", model: "claude", type: "route" };
}

describe("attachAnthropicResponseCapture", () => {
  it.each([
    ["gzip", gzipSync],
    ["br", brotliCompressSync],
    ["deflate", deflateSync],
  ])("waits for %s usage and message_stop before reporting completion", async (encoding, compress) => {
    const source = upstream(encoding);
    const destination = new EventEmitter();
    const activity = entry();
    const terminals: unknown[] = [];

    attachAnthropicResponseCapture(source, destination, activity, 1_000, {
      now: () => 1_250,
      onTerminal: terminal => {
        terminals.push({
          ...terminal,
          inputTokens: activity.inputTokens,
          outputTokens: activity.outputTokens,
        });
      },
    });

    source.emit("data", compress(completeSse));
    source.emit("end");
    destination.emit("finish");

    await vi.waitFor(() => {
      expect(terminals).toEqual([{
        outcome: "complete",
        durationMs: 250,
        inputTokens: 12,
        outputTokens: 42,
      }]);
    });
  });

  it("does not mark a compressed SSE stream complete without message_stop", async () => {
    const source = upstream("gzip");
    const destination = new EventEmitter();
    const terminals: string[] = [];
    const truncated = Buffer.from([
      `data: ${JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 12 } },
      })}`,
      "",
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } })}`,
      "",
      "",
    ].join("\n"));

    attachAnthropicResponseCapture(source, destination, entry(), 1_000, {
      now: () => 1_250,
      onTerminal: terminal => { terminals.push(terminal.outcome); },
    });

    source.emit("data", gzipSync(truncated));
    source.emit("end");
    destination.emit("finish");

    await vi.waitFor(() => expect(terminals).toEqual(["other"]));
  });
});
