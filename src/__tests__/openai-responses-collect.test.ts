import { describe, expect, it } from "vitest";
import { collectCodexResponseStream, createCodexUsageObserver } from "../protocol/openai-responses-collect.js";

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
    const body = JSON.stringify({ error: { message: "rate limited" } });
    const upstream = new Response(body, {
      status: 429,
      headers: { "content-type": "application/json" },
    });

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({ kind: "text", status: 429, contentType: "application/json", body });
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

  it("reassembles a response.completed event split across chunks", async () => {
    const upstream = sseResponse([
      'data: {"type":"response.completed","response":{"id":"split"',
      "}}\n\n",
    ]);

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({
      kind: "json",
      status: 200,
      body: { id: "split" },
    });
  });

  it("flushes a final event with no trailing newline", async () => {
    const upstream = sseResponse([
      'data: {"type":"response.completed","response":{"id":"tail"}}',
    ]);

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({
      kind: "json",
      status: 200,
      body: { id: "tail" },
    });
  });

  it("maps an error event to a 502 upstream_error carrying its message", async () => {
    const upstream = sseResponse([
      'data: {"type":"error","error":{"message":"stream exploded"}}\n\n',
    ]);

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({
      kind: "json",
      status: 502,
      body: { error: { type: "upstream_error", message: "stream exploded" } },
    });
  });

  it("maps a malformed SSE data line to a 502 upstream_error", async () => {
    const upstream = sseResponse(["data: {this is not valid json\n\n"]);

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({
      kind: "json",
      status: 502,
      body: { error: { type: "upstream_error", message: "Malformed upstream stream" } },
    });
  });

  it("maps a malformed application/json body to a 502 upstream_error", async () => {
    const upstream = new Response("{not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({
      kind: "json",
      status: 502,
      body: { error: { type: "upstream_error", message: "Malformed upstream JSON body" } },
    });
  });
});

describe("createCodexUsageObserver", () => {
  const encoder = new TextEncoder();

  it("captures usage from a response.completed event split across chunks", () => {
    const observer = createCodexUsageObserver();
    const event = `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 60 } },
      },
    })}\n\n`;
    const mid = Math.floor(event.length / 2);
    observer.push(encoder.encode(event.slice(0, mid)));
    observer.push(encoder.encode(event.slice(mid)));
    expect(observer.finish()).toEqual({ inputTokens: 100, cachedInputTokens: 60, outputTokens: 25 });
  });

  it("returns undefined when no completed event arrives", () => {
    const observer = createCodexUsageObserver();
    observer.push(encoder.encode("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"));
    expect(observer.finish()).toBeUndefined();
  });
});
