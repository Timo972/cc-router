import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request as httpRequest, type ClientRequest } from "http";
import type { AddressInfo } from "net";
import express from "express";
import type { Response as ExpressResponse } from "express";
import { ReadableStream } from "stream/web";
import { mountMessagesCrossProviderRoute } from "../proxy/messages-cross-route.js";
import type { MessagesCrossProviderRouteOptions } from "../proxy/messages-cross-route.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";
import { SessionRouter } from "../proxy/session-router.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { applyCodexRateLimits, createOpenAIAccount, type OpenAIAccount } from "../providers/openai/account-state.js";
import { parseCodexRateLimits } from "../providers/openai/usage.js";
import type { LogEntry } from "../proxy/stats.js";
import type { OpenAIIngressTelemetry } from "../proxy/openai-ingress.js";

type ForwardOpenAI = (opts: { account: OpenAIAccount; body: OpenAIResponsesRequest; stream: boolean; signal?: AbortSignal }) => Promise<Response>;

async function withServer(
  app: ReturnType<typeof express>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  }
}

function makeRuntimeAccount(id: string): OpenAIAccount {
  return createOpenAIAccount({
    id,
    provider: "openai_subscription",
    accessToken: "header.e30.sig",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
    enabled: true,
  });
}

function mountWithPool(
  accounts: OpenAIAccount[],
  forwardOpenAI: ForwardOpenAI,
  extra: Partial<MessagesCrossProviderRouteOptions> = {},
  beforeMount?: (app: ReturnType<typeof express>) => void,
) {
  const app = express();
  beforeMount?.(app);
  const openAIPool = new OpenAITokenPool(accounts);
  const openAIRouter = new SessionRouter<OpenAIAccount>(openAIPool);
  const activity: LogEntry[] = [];
  mountMessagesCrossProviderRoute(app, {
    openAIRouter,
    openAIPool,
    forwardOpenAI,
    recordActivity: entry => activity.push(entry),
    ...extra,
  });
  // Terminal handler so next()-passthrough cases (non-OpenAI models) resolve
  // instead of hanging when the test doesn't register its own downstream
  // middleware.
  app.use("/v1/messages", (_req, res) => {
    res.status(404).json({ notFound: true });
  });
  return { app, openAIPool, openAIRouter, activity };
}

function captureIngressTelemetry() {
  const records: unknown[] = [];
  const telemetry: OpenAIIngressTelemetry = {
    annotateActiveSpan: (...values) => { records.push(["span", ...values]); },
    recordSafeLog: (...values) => { records.push(["log", ...values]); },
    recordUnexpectedException: (...values) => { records.push(["exception", ...values]); },
  };
  return { records, telemetry };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function postMessages(baseUrl: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "openai/gpt-5.6-luna",
      max_tokens: 128,
      messages: [{ role: "user", content: "hi" }],
      ...body,
    }),
  });
}

const CROSS_SSE_BODY = `event: response.completed\ndata: ${JSON.stringify({
  type: "response.completed",
  response: { id: "resp_1", model: "gpt-5.6-luna", usage: { input_tokens: 10, output_tokens: 5 } },
})}\n\n`;

function crossSseResponse(headers: Record<string, string> = {}): Response {
  return new Response(CROSS_SSE_BODY, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function cancellableChunkedResponse(
  chunks: Uint8Array[],
  init: ResponseInit,
): { response: Response; cancel: ReturnType<typeof vi.fn> } {
  let nextChunk = 0;
  let closeTask: ReturnType<typeof setImmediate> | undefined;
  const cancel = vi.fn(() => {
    if (closeTask) clearImmediate(closeTask);
  });
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (nextChunk < chunks.length) {
        controller.enqueue(chunks[nextChunk++]);
        return;
      }
      // Schedule EOF only once the consumer has pulled every chunk. An
      // overflow handler can therefore cancel in the read continuation before
      // this task runs; an unbounded reader still gets a deterministic EOF.
      closeTask ??= setImmediate(() => controller.close());
    },
    cancel,
  }) as BodyInit, init);
  return { response, cancel };
}

describe("mountMessagesCrossProviderRoute", () => {
  it("does not continue OpenAI-routed messages into Anthropic account selection", async () => {
    const anthropicSelection = vi.fn();
    const app = express();
    const openAIPool = new OpenAITokenPool([makeRuntimeAccount("openai-victor")]);
    const openAIRouter = new SessionRouter<OpenAIAccount>(openAIPool);
    mountMessagesCrossProviderRoute(app, {
      openAIRouter,
      openAIPool,
      forwardOpenAI: async () => new Response(JSON.stringify({
        id: "resp_1",
        model: "gpt-5.5",
        output: [],
        usage: {},
      }), {
        headers: { "content-type": "application/json" },
      }),
    });
    app.use("/v1/messages", (_req, res) => {
      anthropicSelection();
      res.status(500).end();
    });

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(res.status).toBe(200);
      expect(anthropicSelection).not.toHaveBeenCalled();
    });
  });

  it("translates Claude Code openai/* messages into Responses and returns Anthropic-shaped JSON", async () => {
    const forwardedBodies: OpenAIResponsesRequest[] = [];
    const forward: ForwardOpenAI = async ({ body }) => {
      forwardedBodies.push(body);
      return new Response(JSON.stringify({
        id: "resp_1",
        model: "gpt-5.5",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done." }],
          },
        ],
        usage: { input_tokens: 4, output_tokens: 2 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: "resp_1",
        type: "message",
        role: "assistant",
        model: "gpt-5.5",
        content: [{ type: "text", text: "Done." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      });
      expect(forwardedBodies).toEqual([
        {
          model: "gpt-5.5",
          input: [
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
          ],
          max_output_tokens: 128,
          stream: false,
        },
      ]);
    });
  });

  it("applies configured OpenAI aliases when Claude Code cross-routes to OpenAI", async () => {
    const forwardedBodies: OpenAIResponsesRequest[] = [];
    const forward: ForwardOpenAI = async ({ body }) => {
      forwardedBodies.push(body);
      return new Response(JSON.stringify({
        id: "resp_1",
        model: "gpt-5-codex",
        output: [],
        usage: {},
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward, {
      modelRouting: { openAIAliases: { codex: "gpt-5-codex" } },
    });

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/codex",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(res.status).toBe(200);
      expect(forwardedBodies[0].model).toBe("gpt-5-codex");
    });
  });

  it("refreshes the selected OpenAI account before Claude Code cross-routing", async () => {
    const prepare = vi.fn().mockResolvedValue(true);
    const forward = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "resp_1",
      model: "gpt-5.5",
      output: [],
      usage: {},
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward, {
      prepareOpenAIAccount: prepare,
    });

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(res.status).toBe(200);
      expect(prepare).toHaveBeenCalledOnce();
      expect(forward).toHaveBeenCalledOnce();
    });
  });

  it("collapses OpenAI Responses SSE into Anthropic-shaped JSON for non-stream messages", async () => {
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.4-mini\"}}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Done.\"}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.4-mini\",\"usage\":{\"input_tokens\":4,\"output_tokens\":2}}}\n\n"));
          controller.close();
        },
      }) as BodyInit,
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.4-mini",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({
        id: "resp_1",
        type: "message",
        role: "assistant",
        model: "gpt-5.4-mini",
        content: [{ type: "text", text: "Done." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      });
    });
  });

  it("pauses translated Messages upstream reads while the client response is backpressured", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n'),
      encoder.encode('data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n'),
    ];
    let nextChunk = 0;
    const read = vi.fn(async () => nextChunk < chunks.length
      ? { value: chunks[nextChunk++], done: false as const }
      : { value: undefined, done: true as const });
    const cancel = vi.fn(async () => undefined);
    const upstream = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response;
    const firstWrite = deferred<ExpressResponse>();
    let writes = 0;
    const { app } = mountWithPool(
      [makeRuntimeAccount("openai-victor")],
      async () => upstream,
      {},
      app => app.use((_req, res, next) => {
        const originalWrite = res.write.bind(res);
        res.write = ((...args: unknown[]) => {
          writes++;
          const accepted = Reflect.apply(originalWrite, res, args) as boolean;
          if (writes === 1) {
            firstWrite.resolve(res);
            return false;
          }
          return accepted;
        }) as ExpressResponse["write"];
        next();
      }),
    );

    await withServer(app, async baseUrl => {
      const response = postMessages(baseUrl, { stream: true });
      const serverResponse = await firstWrite.promise;
      await new Promise(resolve => setImmediate(resolve));
      expect(read).toHaveBeenCalledTimes(1);
      expect(writes).toBe(1);

      serverResponse.emit("drain");
      const body = await (await response).text();
      expect(body).toContain('"type":"message_start"');
      expect(body).toContain('"type":"message_stop"');
      expect(read).toHaveBeenCalledTimes(3);
      expect(cancel).not.toHaveBeenCalled();
    });
  });

  it("cancels the translated Messages reader when the client closes during backpressure", async () => {
    const encoder = new TextEncoder();
    const neverRead = deferred<ReadableStreamReadResult<Uint8Array>>();
    const read = vi.fn()
      .mockResolvedValueOnce({
        value: encoder.encode('data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n'),
        done: false,
      })
      .mockImplementationOnce(() => neverRead.promise);
    const cancel = vi.fn(async () => undefined);
    const upstream = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response;
    const firstWrite = deferred<void>();
    let writes = 0;
    const { app } = mountWithPool(
      [makeRuntimeAccount("openai-victor")],
      async () => upstream,
      {},
      app => app.use((_req, res, next) => {
        const originalWrite = res.write.bind(res);
        res.write = ((...args: unknown[]) => {
          writes++;
          Reflect.apply(originalWrite, res, args);
          if (writes === 1) {
            firstWrite.resolve();
            return false;
          }
          return true;
        }) as ExpressResponse["write"];
        next();
      }),
    );
    const abort = new AbortController();
    await withServer(app, async baseUrl => {
      const pending = fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
        signal: abort.signal,
      }).then(res => res.text()).catch(() => undefined);
      try {
        await firstWrite.promise;
        await new Promise(resolve => setImmediate(resolve));
        expect(read).toHaveBeenCalledTimes(1);
        abort.abort();
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        expect(read).toHaveBeenCalledTimes(1);
        expect(writes).toBe(1);
      } finally {
        neverRead.resolve({ value: undefined, done: true });
        await pending;
      }
    });
  });

  it("cancels and safely rejects an oversized non-OK upstream body", async () => {
    const privateBody = "PRIVATE_NON_OK_BODY_" + "x".repeat(10 * 1024 * 1024);
    const upstream = cancellableChunkedResponse(
      [new TextEncoder().encode(privateBody)],
      { status: 429, headers: { "content-type": "application/json" } },
    );
    const { app } = mountWithPool(
      [makeRuntimeAccount("openai-victor")],
      async () => upstream.response,
    );

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, {});
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body).toEqual({
        type: "error",
        error: { type: "upstream_error", message: "Upstream response exceeded size limit" },
      });
      expect(JSON.stringify(body)).not.toContain("PRIVATE_NON_OK_BODY");
    });
    expect(upstream.cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["JSON", "application/json"],
    ["plain body", "text/plain"],
  ])("cancels and safely rejects an oversized successful upstream %s", async (_name, contentType) => {
    const privateBody = contentType === "application/json"
      ? JSON.stringify({
        id: "resp_private",
        model: "gpt-5.5",
        output: [],
        private: "PRIVATE_SUCCESS_BODY_" + "x".repeat(10 * 1024 * 1024),
      })
      : "PRIVATE_SUCCESS_BODY_" + "x".repeat(10 * 1024 * 1024);
    const upstream = cancellableChunkedResponse(
      [new TextEncoder().encode(privateBody)],
      { status: 200, headers: { "content-type": contentType } },
    );
    const { app } = mountWithPool(
      [makeRuntimeAccount("openai-victor")],
      async () => upstream.response,
    );

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, {});
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body).toEqual({
        type: "error",
        error: { type: "upstream_error", message: "Upstream response exceeded size limit" },
      });
      expect(JSON.stringify(body)).not.toContain("PRIVATE_SUCCESS_BODY");
    });
    expect(upstream.cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["JSON", "application/json"],
    ["text", "text/plain"],
  ])("joins real-stream cancellation and keeps a client-aborted bounded %s body read owned by the client", async (_name, contentType) => {
    const account = makeRuntimeAccount("openai-victor");
    const { records, telemetry } = captureIngressTelemetry();
    const readStarted = deferred<void>();
    const cancelStarted = deferred<void>();
    const cancelFinished = deferred<void>();
    let cancelCalls = 0;
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull() {
        readStarted.resolve();
      },
      cancel() {
        cancelCalls++;
        cancelStarted.resolve();
        return cancelFinished.promise;
      },
    }, { highWaterMark: 0 });
    const forward: ForwardOpenAI = async () => new Response(upstreamBody as BodyInit, {
      status: 200,
      headers: { "content-type": contentType },
    });
    const { app, activity, openAIPool } = mountWithPool([account], forward, { telemetry });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let client: ClientRequest | undefined;

    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({
        model: "openai/gpt-5.5",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      });
      const clientClosed = new Promise<void>(resolve => {
        client = httpRequest({
          host: "127.0.0.1",
          port,
          path: "/v1/messages",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        });
        client.on("error", () => resolve());
        client.on("close", () => resolve());
        client.end(body);
      });

      await readStarted.promise;
      client!.destroy();
      await clientClosed;
      await cancelStarted.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(activity).toEqual([]);
      cancelFinished.resolve();
      await vi.waitFor(() => expect(openAIPool.getInFlight(account.id)).toBe(0));
      await vi.waitFor(() => expect(activity).toHaveLength(1));

      expect(cancelCalls).toBe(1);
      expect(account.errorCount).toBe(0);
      expect(account.consecutiveErrors).toBe(0);
      expect(openAIPool.getGlobalCooldownUntil(account.id)).toBe(0);
      expect(activity[0]).toEqual(expect.objectContaining({ type: "route", statusCode: 200 }));
      expect(activity[0]?.details).toContain("client-cancelled");
      const telemetryWire = JSON.stringify(records);
      expect(telemetryWire).toContain('"outcome":"cancelled"');
      expect(records.filter(record => (record as unknown[])[0] === "log")).toHaveLength(0);
      expect(records.filter(record => (record as unknown[])[0] === "exception")).toHaveLength(0);
    } finally {
      client?.destroy();
      cancelFinished.resolve();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it("keeps a true bounded body reader rejection as one safe upstream failure", async () => {
    const privateFailure = "PRIVATE_TRUE_BODY_REJECTION";
    const reader = {
      read: vi.fn(async () => { throw new Error(privateFailure); }),
      cancel: vi.fn(async () => undefined),
    };
    const account = makeRuntimeAccount("openai-victor");
    const { records, telemetry } = captureIngressTelemetry();
    const { app, activity } = mountWithPool(
      [account],
      async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: { getReader: () => reader },
      }) as unknown as Response,
      { telemetry },
    );

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, {});
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body).toEqual({
        type: "error",
        error: { type: "upstream_error", message: "Malformed upstream stream" },
      });
      expect(JSON.stringify(body)).not.toContain(privateFailure);
    });

    expect(reader.read).toHaveBeenCalledOnce();
    expect(account.errorCount).toBe(1);
    expect(account.consecutiveErrors).toBe(1);
    expect(activity).toEqual([expect.objectContaining({ type: "error", statusCode: 502 })]);
    expect(records.filter(record => (record as unknown[])[0] === "log")).toHaveLength(1);
    expect(records.filter(record => (record as unknown[])[0] === "exception")).toHaveLength(0);
    expect(JSON.stringify(records)).not.toContain(privateFailure);
  });

  it("cancels an unterminated collected SSE frame after 64 KiB", async () => {
    const frame = 'data: {"type":"response.output_text.delta","delta":"PRIVATE_FRAME_'
      + "x".repeat(64 * 1024);
    const upstream = cancellableChunkedResponse(
      [new TextEncoder().encode(frame)],
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app } = mountWithPool(
      [makeRuntimeAccount("openai-victor")],
      async () => upstream.response,
    );

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, { stream: false });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body).toEqual({
        type: "error",
        error: { type: "upstream_error", message: "Upstream response exceeded size limit" },
      });
      expect(JSON.stringify(body)).not.toContain("PRIVATE_FRAME");
    });
    expect(upstream.cancel).toHaveBeenCalledOnce();
  });

  it("caps collected translated output at 10 MiB and cancels upstream", async () => {
    const delta = "x".repeat(60 * 1024);
    const frames = [
      'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n',
      ...Array.from(
        { length: Math.ceil((10 * 1024 * 1024 + 1) / delta.length) },
        () => `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`,
      ),
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n',
    ];
    const upstream = cancellableChunkedResponse(
      frames.map(frame => new TextEncoder().encode(frame)),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app } = mountWithPool(
      [makeRuntimeAccount("openai-victor")],
      async () => upstream.response,
    );

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, { stream: false });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        type: "error",
        error: { type: "upstream_error", message: "Upstream response exceeded size limit" },
      });
    });
    expect(upstream.cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["number", 7],
    ["object", { private: "PRIVATE_OBJECT_DELTA" }],
    ["array", ["PRIVATE_ARRAY_DELTA"]],
  ])("safely rejects a collected %s delta and joins reader cancellation before releasing its lease", async (_name, delta) => {
    const account = makeRuntimeAccount("openai-victor");
    const { records, telemetry } = captureIngressTelemetry();
    const cancelFinished = deferred<void>();
    const cancel = vi.fn(() => cancelFinished.promise);
    const wire = new TextEncoder().encode(
      'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n'
      + `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`,
    );
    let reads = 0;
    const reader = {
      read: vi.fn(async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        if (reads++ === 0) return { value: wire, done: false };
        return { value: undefined, done: true };
      }),
      cancel,
    };
    const { app, activity, openAIPool } = mountWithPool(
      [account],
      async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: { getReader: () => reader },
      }) as unknown as Response,
      { telemetry },
    );
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let pendingResponse: Promise<Response> | undefined;

    try {
      await withServer(app, async baseUrl => {
        let responseSettled = false;
        pendingResponse = postMessages(baseUrl, { stream: false });
        void pendingResponse.finally(() => { responseSettled = true; });

        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        expect(responseSettled).toBe(false);
        expect(activity).toEqual([]);
        expect(openAIPool.getInFlight(account.id)).toBe(1);

        cancelFinished.resolve();
        const res = await pendingResponse;
        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body).toEqual({
          type: "error",
          error: { type: "upstream_error", message: "Malformed upstream stream" },
        });
        expect(JSON.stringify(body)).not.toContain("PRIVATE_");
      });
    } finally {
      cancelFinished.resolve();
      await pendingResponse?.catch(() => undefined);
      const consoleWire = JSON.stringify(consoleLog.mock.calls);
      expect(consoleWire).not.toContain("PRIVATE_OBJECT_DELTA");
      expect(consoleWire).not.toContain("PRIVATE_ARRAY_DELTA");
      consoleLog.mockRestore();
    }

    expect(cancel).toHaveBeenCalledOnce();
    expect(openAIPool.getInFlight(account.id)).toBe(0);
    expect(account.errorCount).toBe(1);
    expect(account.consecutiveErrors).toBe(1);
    expect(activity).toEqual([expect.objectContaining({ type: "error", statusCode: 502 })]);
    const telemetryWire = JSON.stringify(records);
    expect(records.filter(record => (record as unknown[])[0] === "log")).toHaveLength(1);
    expect(records.filter(record => (record as unknown[])[0] === "exception")).toHaveLength(0);
    expect(telemetryWire).not.toContain("PRIVATE_OBJECT_DELTA");
    expect(telemetryWire).not.toContain("PRIVATE_ARRAY_DELTA");
  });

  it.each([
    [
      "response.completed",
      { type: "response.completed", response: { id: "resp_1", model: "gpt-5.5" } },
      200,
      "end_turn",
    ],
    [
      "response.incomplete",
      {
        type: "response.incomplete",
        response: {
          id: "resp_1",
          model: "gpt-5.5",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
      200,
      "max_tokens",
    ],
    [
      "response.failed",
      { type: "response.failed", response: { error: { message: "safe failure" } } },
      502,
      undefined,
    ],
  ])("preserves a %s terminal split across arbitrary chunks", async (_name, terminal, expectedStatus, stopReason) => {
    const wire = new TextEncoder().encode(
      'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n'
      + `data: ${JSON.stringify(terminal)}\n\n`,
    );
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < wire.byteLength; offset += 7) {
      chunks.push(wire.subarray(offset, Math.min(offset + 7, wire.byteLength)));
    }
    const upstream = cancellableChunkedResponse(chunks, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const { app } = mountWithPool(
      [makeRuntimeAccount("openai-victor")],
      async () => upstream.response,
    );

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, { stream: false });
      expect(res.status).toBe(expectedStatus);
      const body = await res.json() as { stop_reason?: string; error?: { message?: string } };
      if (expectedStatus === 200) expect(body.stop_reason).toBe(stopReason);
      else expect(body.error?.message).toBe("safe failure");
    });
    expect(upstream.cancel).not.toHaveBeenCalled();
  });

  it("cancels a streaming translation whose pending SSE frame exceeds 64 KiB", async () => {
    const frame = 'data: {"type":"response.output_text.delta","delta":"PRIVATE_STREAM_FRAME_'
      + "x".repeat(64 * 1024);
    const upstream = cancellableChunkedResponse(
      [new TextEncoder().encode(frame)],
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app, activity } = mountWithPool(
      [makeRuntimeAccount("openai-victor")],
      async () => upstream.response,
    );

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, { stream: true });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("PRIVATE_STREAM_FRAME");
    });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(activity).toContainEqual(expect.objectContaining({ type: "error", statusCode: 502 }));
  });

  it("collapses OpenAI Responses SSE ending in response.incomplete into Anthropic-shaped JSON with its usage, not a 502", async () => {
    // response.incomplete fires when generation stops without completing
    // (e.g. hitting max_output_tokens), but still carries a full response
    // with usage — a usable partial answer, not a transport failure.
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.4-mini\"}}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Par\"}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.4-mini\",\"usage\":{\"input_tokens\":4,\"output_tokens\":2},\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n"));
          controller.close();
        },
      }) as BodyInit,
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.4-mini",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({
        id: "resp_1",
        type: "message",
        role: "assistant",
        model: "gpt-5.4-mini",
        content: [{ type: "text", text: "Par" }],
        // The turn was cut off by the output-token ceiling, so it must not be
        // reported as a deliberate end_turn — and this reconstructed-response
        // path, not the JSON branch, is what a non-streaming client gets since
        // Codex always streams.
        stop_reason: "max_tokens",
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      });
    });

    expect(activity.some(entry => entry.type === "error")).toBe(false);
    const routeEntry = activity.find(entry => entry.type === "route");
    expect(routeEntry).toEqual(expect.objectContaining({ statusCode: 200 }));
  });

  it("reports a 502 when a non-stream collect never sees a completion event", async () => {
    // The terminal frame is malformed JSON: tolerant parsing drops it rather
    // than aborting the read, so without a completion check the collector
    // would hand the client a fabricated empty message on a 200.
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.5\"}}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Par\"}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.completed\",\"response\":{\"id\":\n\n"));
          controller.close();
        },
      }) as BodyInit,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });

      expect(res.status).toBe(502);
      const body = await res.json() as { type: string; error: { type: string } };
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("upstream_error");
    });

    expect(activity.some(entry => entry.type === "error" && entry.statusCode === 502)).toBe(true);
  });

  it("reports a 502 when a non-stream collect's terminal event carries no response object", async () => {
    // Well-formed SSE and a real terminal event type, but nothing to read a
    // response out of. Treating the type alone as terminal turned this into a
    // fabricated empty assistant turn on a 200.
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.5\"}}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Par\"}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.incomplete\",\"response\":null}\n\n"));
          controller.close();
        },
      }) as BodyInit,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });

      expect(res.status).toBe(502);
      const body = await res.json() as { type: string; error: { type: string } };
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("upstream_error");
    });

    expect(activity.some(entry => entry.type === "error" && entry.statusCode === 502)).toBe(true);
  });

  it("reports a 502 when a non-stream collect gets a truncated stream", async () => {
    // Every frame parses, but the stream simply stops before completing —
    // partial text must not be dressed up as a finished answer.
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Par\"}\n\n"));
          controller.close();
        },
      }) as BodyInit,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });

      expect(res.status).toBe(502);
    });
  });

  it("streams OpenAI Responses SSE back as Anthropic Messages SSE", async () => {
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.5\"}}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.5\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n\n"));
          controller.close();
        },
      }) as BodyInit,
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("data: {\"type\":\"message_start\"");
      expect(text).toContain("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}");
      expect(text).toContain("data: {\"type\":\"message_stop\"}");
    });
  });

  it("streams OpenAI Responses SSE ending in response.incomplete as Anthropic Messages SSE, recording the upstream 200 rather than a 502", async () => {
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.5\"}}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Par\"}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.5\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1},\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n"));
          controller.close();
        },
      }) as BodyInit,
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Par\"}}");
    });

    expect(activity.some(entry => entry.type === "error" && entry.statusCode === 502)).toBe(false);
    const routeEntry = activity.find(entry => entry.type === "route");
    expect(routeEntry).toEqual(expect.objectContaining({ statusCode: 200 }));
  });

  it("passes non-openai models to later Anthropic proxy middleware with route context and replayable raw body", async () => {
    const app = express();
    const nextSpy = vi.fn();
    const openAIPool = new OpenAITokenPool([]);
    const openAIRouter = new SessionRouter<OpenAIAccount>(openAIPool);

    mountMessagesCrossProviderRoute(app, {
      openAIRouter,
      openAIPool,
      forwardOpenAI: async () => new Response("unused"),
    });
    app.use("/v1/messages", (req, res) => {
      nextSpy();
      res.json({
        rawBody: req._ccRawBody?.toString("utf8"),
        routeContext: req._ccRouteContext,
      });
    });

    await withServer(app, async baseUrl => {
      const body = {
        model: "claude/sonnet",
        messages: [{ role: "user", content: "hi" }],
      };
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        rawBody: JSON.stringify(body),
        routeContext: {
          requestedModel: "claude-sonnet-4-5",
          modelFamily: "sonnet",
        },
      });
      expect(nextSpy).toHaveBeenCalledOnce();
    });
  });

  it.each([42, { future: "model" }])(
    "treats a non-string Messages model as the default Anthropic route: %j",
    async (model) => {
      const app = express();
      const openAIPool = new OpenAITokenPool([]);
      const openAIRouter = new SessionRouter<OpenAIAccount>(openAIPool);
      mountMessagesCrossProviderRoute(app, {
        openAIRouter,
        openAIPool,
        forwardOpenAI: async () => new Response("unused"),
      });
      app.use("/v1/messages", (req, res) => {
        res.json({ routeContext: req._ccRouteContext });
      });

      await withServer(app, async baseUrl => {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "hi" }],
          }),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          routeContext: {
            requestedModel: "claude-sonnet-4-5",
            modelFamily: "sonnet",
          },
        });
      });
    },
  );
});

describe("mountMessagesCrossProviderRoute crash safety (F1)", () => {
  it("returns a local 502 in the Anthropic error envelope when forwardOpenAI rejects, and does not crash the process", async () => {
    const forward: ForwardOpenAI = async () => {
      throw new Error("network down");
    };
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, {});

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          type: "error",
          error: expect.objectContaining({ type: "upstream_error" }),
        }),
      );
    });

    expect(activity.some(entry => entry.type === "error" && entry.statusCode === 502)).toBe(true);
  });

  it("turns an upstream response.failed on a 200 SSE stream into a 502, not an empty success", async () => {
    const forward: ForwardOpenAI = async () => new Response(
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5\"}}\n\n"
      + "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"model overloaded\"}}}\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, {});

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        type: "error",
        error: { type: "upstream_error", message: "model overloaded" },
      });
    });

    expect(activity.some(entry => entry.type === "error" && entry.statusCode === 502)).toBe(true);
  });

  it("relays an upstream JSON failure body as an Anthropic error envelope", async () => {
    const forward: ForwardOpenAI = async () => new Response(
      JSON.stringify({ error: { message: "rate limit reached" } }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, {});

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({
        type: "error",
        error: { type: "rate_limit_error", message: "rate limit reached" },
      });
    });
  });

  it("reports a bodyless collected stream as a failure even if the client left first", async () => {
    const account = makeRuntimeAccount("openai-victor");
    const forwardStarted = deferred<void>();
    const forward: ForwardOpenAI = async opts => {
      forwardStarted.resolve();
      // Hold the response until the ingress has actually registered the
      // disconnect — waiting on the client's own close event is not enough,
      // since the server observes it a tick later. That ordering is the whole
      // question here: whether a bodyless stream arriving after the hangup
      // reads as upstream's failure or as ours to ignore.
      await new Promise<void>(resolve => {
        if (opts.signal?.aborted) resolve();
        else opts.signal?.addEventListener("abort", () => resolve());
      });
      return new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const { app, activity } = mountWithPool([account], forward);

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let client: ClientRequest | undefined;

    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({
        model: "openai/gpt-5.6-luna",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      });
      const clientClosed = new Promise<void>(resolve => {
        client = httpRequest({
          host: "127.0.0.1",
          port,
          path: "/v1/messages",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        });
        client.on("error", () => resolve());
        client.on("close", () => resolve());
        client.end(body);
      });

      await forwardStarted.promise;
      client!.destroy();
      await clientClosed;

      await vi.waitFor(() => expect(activity).toHaveLength(1));
      // An event-stream response with no body is upstream's failure. A client
      // that happened to leave first does not make it disappear.
      expect(activity[0]).toEqual(expect.objectContaining({ type: "error", statusCode: 502 }));
      expect(account.errorCount).toBe(1);
    } finally {
      client?.destroy();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it("keeps bodyless successful JSON upstream-owned after the client already disconnected", async () => {
    const privatePrompt = "PRIVATE_BODYLESS_JSON_PROMPT";
    const account = makeRuntimeAccount("PRIVATE_BODYLESS_JSON_ACCOUNT");
    const forwardStarted = deferred<void>();
    const { records, telemetry } = captureIngressTelemetry();
    const forward: ForwardOpenAI = async opts => {
      forwardStarted.resolve();
      await new Promise<void>(resolve => {
        if (opts.signal?.aborted) resolve();
        else opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const { app, activity, openAIPool } = mountWithPool([account], forward, { telemetry });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let client: ClientRequest | undefined;

    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({
        model: "openai/gpt-5.6-luna",
        max_tokens: 128,
        messages: [{ role: "user", content: privatePrompt }],
        stream: false,
      });
      const clientClosed = new Promise<void>(resolve => {
        client = httpRequest({
          host: "127.0.0.1",
          port,
          path: "/v1/messages",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        });
        client.on("error", () => resolve());
        client.on("close", () => resolve());
        client.end(body);
      });

      await forwardStarted.promise;
      client!.destroy();
      await clientClosed;
      await vi.waitFor(() => expect(openAIPool.getInFlight(account.id)).toBe(0));
      await vi.waitFor(() => expect(activity).toHaveLength(1));

      expect(account.errorCount).toBe(1);
      expect(account.consecutiveErrors).toBe(1);
      expect(openAIPool.getGlobalCooldownUntil(account.id)).toBe(0);
      expect(activity).toEqual([
        expect.objectContaining({ type: "error", statusCode: 502 }),
      ]);
      expect(activity[0]?.details).not.toContain("client-cancelled");
      expect(records).toContainEqual([
        "span",
        "proxy.request",
        expect.objectContaining({
          httpStatusCode: 502,
          outcome: "upstream_error",
          streamOutcome: "upstream_error",
        }),
      ]);
      expect(records.filter(record => (record as unknown[])[0] === "log")).toEqual([
        ["log", expect.objectContaining({
          httpStatusCode: 502,
          outcome: "upstream_error",
          reason: "upstream_5xx",
        })],
      ]);
      expect(records.filter(record => (record as unknown[])[0] === "exception")).toHaveLength(0);
      const telemetryWire = JSON.stringify(records);
      expect(telemetryWire).not.toContain(privatePrompt);
      expect(telemetryWire).not.toContain(account.id);
    } finally {
      client?.destroy();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it("keeps bodyless successful text client-owned after the client already disconnected", async () => {
    const account = makeRuntimeAccount("openai-bodyless-text");
    const forwardStarted = deferred<void>();
    const { records, telemetry } = captureIngressTelemetry();
    const forward: ForwardOpenAI = async opts => {
      forwardStarted.resolve();
      await new Promise<void>(resolve => {
        if (opts.signal?.aborted) resolve();
        else opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return new Response(null, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    };
    const { app, activity, openAIPool } = mountWithPool([account], forward, { telemetry });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let client: ClientRequest | undefined;

    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({
        model: "openai/gpt-5.6-luna",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      });
      const clientClosed = new Promise<void>(resolve => {
        client = httpRequest({
          host: "127.0.0.1",
          port,
          path: "/v1/messages",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        });
        client.on("error", () => resolve());
        client.on("close", () => resolve());
        client.end(body);
      });

      await forwardStarted.promise;
      client!.destroy();
      await clientClosed;
      await vi.waitFor(() => expect(openAIPool.getInFlight(account.id)).toBe(0));
      await vi.waitFor(() => expect(activity).toHaveLength(1));

      expect(account.errorCount).toBe(0);
      expect(account.consecutiveErrors).toBe(0);
      expect(activity).toEqual([
        expect.objectContaining({ type: "route", statusCode: 200 }),
      ]);
      expect(activity[0]?.details).toContain("client-cancelled");
      const telemetryWire = JSON.stringify(records);
      expect(telemetryWire).toContain('"outcome":"cancelled"');
      expect(records.filter(record => (record as unknown[])[0] === "log")).toHaveLength(0);
      expect(records.filter(record => (record as unknown[])[0] === "exception")).toHaveLength(0);
    } finally {
      client?.destroy();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it("keeps an explicit response.failed when the client disconnects before EOF", async () => {
    const account = makeRuntimeAccount("openai-victor");
    const failedSent = deferred<void>();
    const forward: ForwardOpenAI = async opts => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"boom\"}}}\n\n"));
          failedSent.resolve();
          // Aborting a real fetch errors its body, so the pending read rejects
          // — which is what loses a verdict carried on the return value.
          opts.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      }) as BodyInit,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app, activity } = mountWithPool([account], forward);

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let client: ClientRequest | undefined;

    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({
        model: "openai/gpt-5.6-luna",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
      const clientClosed = new Promise<void>(resolve => {
        client = httpRequest({
          host: "127.0.0.1",
          port,
          path: "/v1/messages",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        });
        client.on("error", () => resolve());
        client.on("close", () => resolve());
        client.end(body);
      });

      await failedSent.promise;
      client!.destroy();
      await clientClosed;
      await vi.waitFor(() => expect(activity).toHaveLength(1));

      // The relay throws on the aborted read, after upstream had already said
      // the turn failed. Treating that as a cancellation would clear the
      // account's consecutive errors on a request that genuinely failed.
      expect(activity[0]).toEqual(expect.objectContaining({ type: "error", statusCode: 502 }));
      expect(account.errorCount).toBe(1);
      expect(account.consecutiveErrors).toBe(1);
    } finally {
      client?.destroy();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it("reports a 502 for a streamed response whose terminal frame is malformed, without altering the relayed bytes", async () => {
    // The terminal response.completed frame is malformed JSON: tolerant
    // parsing drops it rather than aborting the relay, so without a
    // completion check this stream would be reported as an ordinary success
    // even though the client never received a finished answer.
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.5\"}}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.completed\",\"response\":{\"id\":\n\n"));
          controller.close();
        },
      }) as BodyInit,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, { stream: true });
      // Headers are already flushed by the time the missing completion is
      // detected, so the client still gets the real HTTP 200 and whatever
      // normalized events had already streamed — only message_stop, which is
      // only emitted in response to response.completed, is missing.
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("message_start");
      expect(text).toContain("\"text\":\"Hi\"");
      expect(text).not.toContain("message_stop");
    });

    const errorEntry = activity.find(entry => entry.type === "error");
    expect(errorEntry).toEqual(expect.objectContaining({ statusCode: 502 }));
  });

  it("does not close a streamed message when the terminal frame carries no response object", async () => {
    // Well-formed SSE, real terminal event type, nothing inside it. The
    // lifecycle already reports this stream as failed; emitting message_stop
    // with end_turn would tell the client the opposite.
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.5\"}}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.incomplete\",\"response\":null}\n\n"));
          controller.close();
        },
      }) as BodyInit,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, { stream: true });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("message_start");
      expect(text).toContain("\"text\":\"Hi\"");
      expect(text).not.toContain("message_stop");
      expect(text).not.toContain("end_turn");
    });

    const errorEntry = activity.find(entry => entry.type === "error");
    expect(errorEntry).toEqual(expect.objectContaining({ statusCode: 502 }));
  });

  it("reports a 502 for a streamed response that stops before response.completed, without altering the relayed bytes", async () => {
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.5\"}}\n\n"));
          controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Par\"}\n\n"));
          controller.close();
        },
      }) as BodyInit,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, { stream: true });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("message_start");
      expect(text).not.toContain("message_stop");
    });

    const errorEntry = activity.find(entry => entry.type === "error");
    expect(errorEntry).toEqual(expect.objectContaining({ statusCode: 502 }));
  });

  it("keeps relaying valid events when a malformed SSE frame shares the chunk", async () => {
    const forward: ForwardOpenAI = async () => new Response(
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5\"}}\n\n"
      + "data: not-json\n\n"
      + "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n"
      + "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5\",\"usage\":{\"input_tokens\":7,\"output_tokens\":3}}}\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, { stream: true });
      const body = await res.text();

      expect(res.status).toBe(200);
      // The malformed frame is skipped; the surrounding valid events survive.
      expect(body).toContain("message_start");
      expect(body).toContain("hello");
      expect(body).toContain("message_stop");
    });

    const routed = activity.find(entry => entry.path === "/v1/messages");
    expect(routed?.inputTokens).toBe(7);
    expect(routed?.outputTokens).toBe(3);
  });
});

describe("mountMessagesCrossProviderRoute P1: real transport error relay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mountWithRealTransport(account: OpenAIAccount) {
    const app = express();
    const openAIPool = new OpenAITokenPool([account]);
    const openAIRouter = new SessionRouter<OpenAIAccount>(openAIPool);
    // forwardOpenAI is deliberately omitted: mountMessagesCrossProviderRoute
    // falls back to the real forwardOpenAICodexResponse transport, so these
    // tests exercise its actual content-type handling end to end rather than
    // a hand-rolled ForwardOpenAI stub.
    mountMessagesCrossProviderRoute(app, { openAIRouter, openAIPool });
    return { app };
  }

  /**
   * Stubs only the Codex backend call, not `fetch` itself: `postMessages`
   * below also calls the global `fetch` to reach this test's own local
   * server, so a blanket `mockResolvedValue` would swallow that request too
   * and never actually exercise the route under test.
   */
  function mockCodexUpstream(response: Response): void {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("chatgpt.com/backend-api/codex/responses")) return response;
      return realFetch(input, init);
    });
  }

  it("relays a real upstream 429 JSON failure through the actual Codex transport, not a synthesized 502", async () => {
    mockCodexUpstream(new Response(
      JSON.stringify({ error: { message: "rate limit reached" } }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "120",
          "x-codex-primary-used-percent": "100",
          // Must not survive the relay: hop-by-hop, and an upstream cookie.
          "connection": "keep-alive",
          "set-cookie": "session=leak",
        },
      },
    ));
    const { app } = mountWithRealTransport(makeRuntimeAccount("openai-victor"));

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, {});
      expect(res.status).toBe(429);
      // Without Retry-After a 429 tells the caller to back off but not for how long.
      expect(res.headers.get("retry-after")).toBe("120");
      expect(res.headers.get("x-codex-primary-used-percent")).toBe("100");
      expect(res.headers.get("set-cookie")).toBeNull();
      // The JSON envelope still owns the content type.
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({
        type: "error",
        error: { type: "rate_limit_error", message: "rate limit reached" },
      });
    });
  });

  it("relays a real upstream 401 JSON failure through the actual Codex transport", async () => {
    mockCodexUpstream(new Response(
      JSON.stringify({ error: { message: "invalid bearer token" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));
    const { app } = mountWithRealTransport(makeRuntimeAccount("openai-victor"));

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, {});
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        type: "error",
        error: { type: "authentication_error", message: "invalid bearer token" },
      });
    });
  });

  it("relays a real upstream non-JSON error body through the actual Codex transport, keeping its own content-type", async () => {
    mockCodexUpstream(new Response(
      "Service Unavailable",
      { status: 503, headers: { "content-type": "text/plain" } },
    ));
    const { app } = mountWithRealTransport(makeRuntimeAccount("openai-victor"));

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, {});
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        type: "error",
        error: { type: "upstream_error", message: "Service Unavailable" },
      });
    });
  });
});

describe("messages cross-route sticky routing", () => {
  it("routes repeated x-claude-code-session-id requests to the same account", async () => {
    const accounts = [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")];
    const seen: string[] = [];
    const forwardOpenAI = vi.fn(async (opts: { account: OpenAIAccount }) => {
      seen.push(opts.account.id);
      return crossSseResponse();
    });
    const { app } = mountWithPool(accounts, forwardOpenAI);

    await withServer(app, async baseUrl => {
      await (await postMessages(baseUrl, {}, { "x-claude-code-session-id": "s1" })).text();
      await (await postMessages(baseUrl, {}, { "x-claude-code-session-id": "s1" })).text();
      await (await postMessages(baseUrl, {}, { "x-claude-code-session-id": "s2" })).text();
    });

    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
  });

  it("applies x-codex-* headers from cross-route responses to the account snapshot", async () => {
    const account = makeRuntimeAccount("openai-a");
    const { app } = mountWithPool([account], vi.fn(async () => crossSseResponse({
      "x-codex-primary-used-percent": "33",
    })));

    await withServer(app, async baseUrl => {
      await (await postMessages(baseUrl, {})).text();
    });

    expect(account.rateLimits.buckets.get("codex")?.primary?.utilization).toBeCloseTo(0.33);
  });

  it("relays an upstream 429, cools the account, and rebinds the session's next request", async () => {
    const accounts = [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")];
    const seen: string[] = [];
    const forwardOpenAI = vi.fn(async (opts: { account: OpenAIAccount }) => {
      seen.push(opts.account.id);
      if (seen.length === 1) {
        return new Response("{\"error\":\"limit\"}", {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "60" },
        });
      }
      return crossSseResponse();
    });
    const { app, openAIPool } = mountWithPool(accounts, forwardOpenAI);

    await withServer(app, async baseUrl => {
      const first = await postMessages(baseUrl, {}, { "x-claude-code-session-id": "s1" });
      expect(first.status).toBe(429);
      await first.text();
      expect(openAIPool.isCoolingDown(seen[0]!)).toBe(true);

      const second = await postMessages(baseUrl, {}, { "x-claude-code-session-id": "s1" });
      expect(second.status).toBe(200);
      await second.text();
    });

    expect(seen[1]).not.toBe(seen[0]);
  });

  it("returns a local Anthropic-envelope 429 with Retry-After when everything is blocked", async () => {
    const account = makeRuntimeAccount("openai-a");
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 600),
    }, Date.now()), Date.now());
    const forwardOpenAI = vi.fn();
    const { app } = mountWithPool([account], forwardOpenAI as never);

    await withServer(app, async baseUrl => {
      const response = await postMessages(baseUrl, {});
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      const body = await response.json() as { type: string; error: { type: string } };
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("rate_limit_error");
    });

    expect(forwardOpenAI).not.toHaveBeenCalled();
  });
});
