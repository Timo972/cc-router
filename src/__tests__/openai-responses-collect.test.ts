import { describe, expect, it } from "vitest";
import {
  collectCodexResponseStream,
  createCodexResponseTerminalObserver,
} from "../protocol/openai-responses-collect.js";

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
  it("classifies a split terminal without retaining its payload or mutating chunks", () => {
    const encoder = new TextEncoder();
    const first = encoder.encode('data: {"type":"response.com');
    const second = encoder.encode('pleted","response":{"private":"not retained"}}\n\n');
    const firstBefore = first.slice();
    const secondBefore = second.slice();
    const observer = createCodexResponseTerminalObserver();

    observer.push(first);
    observer.push(second);

    expect(observer.finish()).toEqual({ kind: "completed" });
    expect(first).toEqual(firstBefore);
    expect(second).toEqual(secondBefore);
  });

  it("classifies response.incomplete without retaining the response object", () => {
    const observer = createCodexResponseTerminalObserver();
    observer.push(new TextEncoder().encode(
      'data: {"type":"response.incomplete","response":{"private":"not retained"}}\n\n',
    ));

    expect(observer.finish()).toEqual({ kind: "incomplete" });
  });

  it.each([
    ["a no-newline data field", `data: ${"x".repeat(64 * 1024 + 1)}`],
    ["an oversized terminal event", `data: ${JSON.stringify({
      type: "response.completed",
      response: { output: "x".repeat(64 * 1024) },
    })}\n\n`],
  ])("classifies %s as overflow with bounded framing state", (_name, input) => {
    const observer = createCodexResponseTerminalObserver();

    observer.push(new TextEncoder().encode(input));

    expect(observer.finish().kind).toBe("overflow");
  });

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

  it("returns response.incomplete as a valid terminal Responses object", async () => {
    const upstream = sseResponse([
      'data: {"type":"response.incomplete","response":{"id":"resp_incomplete","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}\n\n',
    ]);

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({
      kind: "json",
      status: 200,
      body: {
        id: "resp_incomplete",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      },
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

  it("bounds a non-streaming terminal response at 10 MiB", async () => {
    const upstream = sseResponse([
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { output: "x".repeat(10 * 1024 * 1024) },
      })}\n\n`,
    ]);

    const result = await collectCodexResponseStream(upstream);

    expect(result.kind).toBe("json");
    expect(result.status).toBe(502);
    expect(result.body).toEqual({
      error: { type: "upstream_error", message: "Upstream response exceeded size limit" },
    });
  });
});
