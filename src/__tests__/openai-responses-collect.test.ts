import { describe, expect, it } from "vitest";
import { collectCodexResponseStream } from "../protocol/openai-responses-collect.js";

function sseResponse(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream as BodyInit, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}

describe("collectCodexResponseStream", () => {
  it("returns the verbatim response.completed object as JSON", async () => {
    const upstream = sseResponse([
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","output":[{"type":"message"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
    ]);

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({
      kind: "json",
      status: 200,
      body: {
        id: "resp_1",
        model: "gpt-5.5",
        output: [{ type: "message" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
  });

  it("passes a genuine application/json 200 body straight through", async () => {
    const upstream = new Response(JSON.stringify({ id: "resp_json" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({ kind: "json", status: 200, body: { id: "resp_json" } });
  });

  it("passes a non-2xx upstream through as text with its status", async () => {
    const upstream = new Response("rate limited", {
      status: 429,
      headers: { "content-type": "text/event-stream" },
    });

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({ kind: "text", status: 429, body: "rate limited" });
  });

  it("maps a stream that never completes to a 502 upstream_error", async () => {
    const upstream = sseResponse([
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    ]);

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({
      kind: "json",
      status: 502,
      body: { error: { type: "upstream_error", message: "Stream ended before response.completed" } },
    });
  });

  it("maps a response.failed event to a 502 upstream_error carrying its message", async () => {
    const upstream = sseResponse([
      'data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n',
    ]);

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({
      kind: "json",
      status: 502,
      body: { error: { type: "upstream_error", message: "boom" } },
    });
  });
});
