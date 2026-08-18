import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Response as ExpressResponse } from "express";
import { createServer, request as httpRequest, type ClientRequest } from "http";
import type { AddressInfo } from "net";
import { forwardOpenAICodexResponse, toCodexBackendRequest } from "../providers/openai/codex-transport.js";
import { mountResponsesRoutes } from "../proxy/responses-server.js";
import type { ResponsesRoutesOptions } from "../proxy/responses-server.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";
import { SessionRouter } from "../proxy/session-router.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { applyCodexRateLimits, createOpenAIAccount, type OpenAIAccount } from "../providers/openai/account-state.js";
import { parseCodexRateLimits } from "../providers/openai/usage.js";
import { stats, type LogEntry } from "../proxy/stats.js";

type ForwardOpenAI = (opts: { account: OpenAIAccount; body: OpenAIResponsesRequest; stream: boolean }) => Promise<Response>;

const networkFetch = globalThis.fetch;

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
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  }
}

/**
 * Snapshot the process-global error total once nothing is still settling.
 *
 * A handler finishes its stats and activity bookkeeping *after* the client's
 * response resolves, so a test that ends the moment it reads the body can
 * leave a tail still to run. That tail then lands inside a later test's
 * window and turns an exact `before + 1` assertion into an intermittent
 * `before + 2`. Waiting for a full turn with no change absorbs it before the
 * baseline is taken, which keeps the assertions exact instead of loosening
 * them to hide the race.
 */
async function drainedErrorTotal(): Promise<number> {
  let previous = -1;
  for (let attempt = 0; attempt < 20 && previous !== stats.totalErrors; attempt++) {
    previous = stats.totalErrors;
    await new Promise(resolve => setImmediate(resolve));
  }
  return stats.totalErrors;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("forwardOpenAICodexResponse", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards Responses requests to the ChatGPT Codex backend with account bearer token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{\"id\":\"resp_1\"}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const upstream = await forwardOpenAICodexResponse({
      account: {
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      },
      body: { model: "gpt-5.5", input: [] },
      stream: false,
    });

    expect(upstream.status).toBe(200);
    expect(await upstream.text()).toBe("{\"id\":\"resp_1\"}");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer access",
          "content-type": "application/json",
        }),
      }),
    );
  });

  it("marks ChatGPT Codex streaming responses as text/event-stream when upstream omits content-type", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("event: response.completed\ndata: {}\n\n", {
      status: 200,
    }));

    const upstream = await forwardOpenAICodexResponse({
      account: {
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      },
      body: { model: "gpt-5.5", input: [] },
      stream: false,
    });

    expect(upstream.headers.get("content-type")).toBe("text/event-stream");
  });

  it("keeps a non-OK response's real content-type instead of rewriting it to text/event-stream", async () => {
    const errorBody = JSON.stringify({ error: { message: "rate limited" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(errorBody, {
      status: 429,
      headers: { "content-type": "application/json" },
    }));

    const upstream = await forwardOpenAICodexResponse({
      account: {
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      },
      body: { model: "gpt-5.5", input: [] },
      stream: false,
    });

    expect(upstream.status).toBe(429);
    expect(upstream.headers.get("content-type")).toBe("application/json");
    expect(await upstream.text()).toBe(errorBody);
  });
});

describe("toCodexBackendRequest", () => {
  it("adds ChatGPT Codex backend required fields and strips unsupported output caps", () => {
    expect(toCodexBackendRequest({
      model: "gpt-5.4-mini",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      max_output_tokens: 32,
    })).toEqual({
      model: "gpt-5.4-mini",
      instructions: "You are a concise coding assistant.",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      store: false,
      stream: true,
    });
  });
});

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
  forwardOpenAI?: ForwardOpenAI,
  extra: Partial<ResponsesRoutesOptions> = {},
  beforeMount?: (app: ReturnType<typeof express>) => void,
) {
  const app = express();
  beforeMount?.(app);
  const openAIPool = new OpenAITokenPool(accounts);
  const openAIRouter = new SessionRouter<OpenAIAccount>(openAIPool);
  const activity: LogEntry[] = [];
  mountResponsesRoutes(app, {
    openAIRouter,
    openAIPool,
    ...(forwardOpenAI ? { forwardOpenAI } : {}),
    recordActivity: entry => activity.push(entry),
    ...extra,
  });
  return { app, openAIPool, openAIRouter, activity };
}

describe("mountResponsesRoutes", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])(
    "preserves default-forwarder JSON errors and only forwards safe response headers (stream=%s)",
    async stream => {
      const privateBody = JSON.stringify({ error: { message: "private upstream detail" } });
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.hostname === "chatgpt.com") {
          return new Response(privateBody, {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "17",
              "set-cookie": "private_session=secret",
              "x-upstream-secret": "do-not-forward",
            },
          });
        }
        return networkFetch(input, init);
      });

      const { app } = mountWithPool([makeRuntimeAccount("openai-victor")]);

      await withServer(app, async baseUrl => {
        const res = await networkFetch(`${baseUrl}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream }),
        });

        expect(res.status).toBe(429);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(res.headers.get("retry-after")).toBe("17");
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(res.headers.get("x-upstream-secret")).toBeNull();
        expect(await res.text()).toBe(privateBody);
      });
    },
  );

  it("reports premature EOF without mutating bytes already relayed to the client", async () => {
    const body = 'data: {"type":"response.created","response":{"id":"resp_cut_off"}}\n\n';
    const { app, activity } = mountWithPool(
      [makeRuntimeAccount("openai-victor")],
      async () => new Response(
        body,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(body);
      await vi.waitFor(() => expect(activity).toHaveLength(1));
      expect(activity[0]).toEqual(expect.objectContaining({ type: "error", statusCode: 502 }));
    });
  });

  it("relays an oversized frame byte-for-byte while the bounded observer recovers for a later terminal", async () => {
    let upstreamCancelled = false;
    const oversized = `data: ${"x".repeat(64 * 1024 + 1)}\n`;
    const terminal = 'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n';
    const { app, activity } = mountWithPool(
      [makeRuntimeAccount("openai-victor")],
      async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.enqueue(new TextEncoder().encode(terminal));
          controller.close();
        },
        cancel() {
          upstreamCancelled = true;
        },
      }) as BodyInit, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
      });
      expect(await res.text()).toBe(oversized + terminal);
      expect(upstreamCancelled).toBe(false);
      await vi.waitFor(() => expect(activity).toHaveLength(1));
      expect(activity[0]).toEqual(expect.objectContaining({ type: "route", statusCode: 200 }));
    });
  });

  it.each([
    ["response.incomplete", { type: "response.incomplete", response: { id: "resp_1", status: "incomplete" } }],
    ["response.failed", { type: "response.failed", response: { error: { message: "failed" } } }],
    ["error", { type: "error", error: { message: "errored" } }],
  ])("relays a %s terminal event exactly once before closing", async (_name, event) => {
    const body = `data: ${JSON.stringify(event)}\n\n`;
    const { app } = mountWithPool(
      [makeRuntimeAccount("openai-victor")],
      async () => new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(body);
    });
  });

  it("rejects an explicit store:true with 400 and records exactly one warn entry", async () => {
    const forward = vi.fn();
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], store: true }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: {
          type: "invalid_request_error",
          message: expect.stringContaining("store:true"),
        },
      });
      expect(forward).not.toHaveBeenCalled();
      expect(activity).toHaveLength(1);
      expect(activity[0]).toEqual(
        expect.objectContaining({ type: "warn", statusCode: 400, accountId: "-" }),
      );
    });
  });

  it("bounds an oversized client model name in every retained activity entry", async () => {
    // A 10mb body limit means the model string is a client-controlled lever on
    // how much the 100-entry activity buffer retains, and on how much the
    // health response re-serializes each time it is read.
    const oversized = `openai/${"g".repeat(50_000)}`;
    let forwardedModel: string | undefined;
    const forward: ForwardOpenAI = async opts => {
      forwardedModel = opts.body.model;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      // A pre-routing rejection and a fully routed request are separate
      // activity paths; both retain the model.
      const warned = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: oversized, input: [], store: true }),
      });
      expect(warned.status).toBe(400);

      const routed = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: oversized, input: [] }),
      });
      expect(routed.status).toBe(200);
    });

    expect(activity).toHaveLength(2);
    for (const entry of activity) expect(entry.model.length).toBeLessThanOrEqual(64);
    // Bounding is for what we retain — the request forwarded upstream still
    // carries exactly the model the client asked for.
    expect(forwardedModel).toBe(oversized.slice("openai/".length));
  });

  it("rejects a non-openai_subscription model with 501", async () => {
    const forward = vi.fn();
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/claude-sonnet-4-20250514", input: [] }),
      });

      expect(res.status).toBe(501);
      expect(await res.json()).toEqual(
        expect.objectContaining({ error: expect.objectContaining({ type: "unsupported_provider" }) }),
      );
      expect(forward).not.toHaveBeenCalled();
    });
  });

  it("accepts Codex Responses requests and strips the openai model prefix before forwarding", async () => {
    const forwardedBodies: OpenAIResponsesRequest[] = [];
    const forward: ForwardOpenAI = async ({ body }) => {
      forwardedBodies.push(body);
      return new Response(JSON.stringify({ id: "resp_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          input: [
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
          ],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "resp_1" });
      expect(forwardedBodies).toEqual([
        {
          model: "gpt-5.5",
          input: [
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
          ],
          stream: false,
        },
      ]);
    });
  });

  it("applies configured OpenAI model aliases before forwarding Responses requests", async () => {
    const forwardedBodies: OpenAIResponsesRequest[] = [];
    const forward: ForwardOpenAI = async ({ body }) => {
      forwardedBodies.push(body);
      return new Response(JSON.stringify({ id: "resp_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward, {
      modelRouting: { openAIAliases: { codex: "gpt-5-codex" } },
    });

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/codex", input: [] }),
      });

      expect(res.status).toBe(200);
      expect(forwardedBodies[0].model).toBe("gpt-5-codex");
    });
  });

  it("refreshes the selected OpenAI account before forwarding", async () => {
    const prepare = vi.fn().mockResolvedValue(true);
    const forward = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward, {
      prepareOpenAIAccount: prepare,
    });

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(200);
      expect(prepare).toHaveBeenCalledOnce();
      expect(forward).toHaveBeenCalledOnce();
    });
  });

  it("streams upstream Responses SSE chunks without waiting for the full body", async () => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("data: {\"type\":\"response.created\"}\n\n"));
          // The test asserts on the first chunk and returns, so the relay
          // cancels this reader while the timer is still pending. Enqueuing
          // into a cancelled controller throws, so stop producing — as a real
          // upstream body does when its consumer goes away.
          const pending = setTimeout(() => {
            controller.enqueue(encoder.encode("data: {\"type\":\"response.completed\"}\n\n"));
            controller.close();
          }, 100);
          timers.push(pending);
        },
        cancel() {
          for (const timer of timers.splice(0)) clearTimeout(timer);
        },
      }) as BodyInit,
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await Promise.race([
        fetch(`${baseUrl}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("response headers were buffered")), 50)),
      ]);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body?.getReader();
      if (!reader) throw new Error("response body is missing");

      const firstChunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("first chunk was buffered")), 50)),
      ]);
      expect(new TextDecoder().decode(firstChunk.value)).toContain("response.created");
      await reader.cancel();
    });
  });

  it("pauses native Responses upstream reads while the client response is backpressured", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'),
      encoder.encode('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n'),
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
      const response = fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
      });

      const serverResponse = await firstWrite.promise;
      await new Promise(resolve => setImmediate(resolve));
      expect(read).toHaveBeenCalledTimes(1);
      expect(writes).toBe(1);

      serverResponse.emit("drain");
      const body = await (await response).text();
      expect(body).toBe(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8"));
      expect(read).toHaveBeenCalledTimes(3);
      expect(cancel).not.toHaveBeenCalled();
    });
  });

  it("cancels the native Responses reader when the client closes during backpressure", async () => {
    const encoder = new TextEncoder();
    const neverRead = deferred<ReadableStreamReadResult<Uint8Array>>();
    const read = vi.fn()
      .mockResolvedValueOnce({
        value: encoder.encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'),
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
    const response = withServer(app, async baseUrl => {
      const pending = fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
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
    await response;
  });

  it("warns on an explicit max_output_tokens, then forwards and reconciles", async () => {
    const forward = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "resp_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], max_output_tokens: 256 }),
      });

      expect(res.status).toBe(200);
      expect(forward).toHaveBeenCalledOnce();
      expect(activity.some(entry =>
        entry.type === "warn" && entry.accountId === "-" && entry.details?.includes("max_output_tokens"),
      )).toBe(true);
    });
  });

  it("reconciles a non-streaming request into a single JSON body", async () => {
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","output":[]}}\n\n'));
          controller.close();
        },
      }) as BodyInit,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ id: "resp_1", model: "gpt-5.5", output: [] });
    });
  });

  it("reconciles a non-streaming request whose terminal event is response.incomplete into a 200 JSON body, not a 502", async () => {
    // response.incomplete fires when generation stops without completing
    // (e.g. hitting max_output_tokens) but still carries a full response with
    // usage — a usable partial answer, not a transport failure.
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"response.incomplete","response":{"id":"resp_1","model":"gpt-5.5","output":[{"type":"message"}],"usage":{"input_tokens":40,"output_tokens":10},"incomplete_details":{"reason":"max_output_tokens"}}}\n\n'));
          controller.close();
        },
      }) as BodyInit,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({
        id: "resp_1",
        model: "gpt-5.5",
        output: [{ type: "message" }],
        usage: { input_tokens: 40, output_tokens: 10 },
        incomplete_details: { reason: "max_output_tokens" },
      });
    });

    expect(activity.some(e => e.type === "error")).toBe(false);
    const entry = activity.find(e => e.type === "route");
    expect(entry?.inputTokens).toBe(40);
    expect(entry?.outputTokens).toBe(10);
  });

  it("passes a non-2xx upstream through as text on the non-streaming path", async () => {
    const errorBody = JSON.stringify({ error: { message: "upstream boom" } });
    const forward: ForwardOpenAI = async () => new Response(errorBody, {
      status: 429,
      headers: { "content-type": "application/json" },
    });
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.text()).toBe(errorBody);
    });
  });

  it("mirrors upstream Retry-After and x-codex-* headers on a non-streaming failure relay", async () => {
    const errorBody = JSON.stringify({ error: { message: "rate limited" } });
    const forward: ForwardOpenAI = async () => new Response(errorBody, {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "120",
        "x-codex-primary-used-percent": "100",
      },
    });
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("120");
      expect(res.headers.get("x-codex-primary-used-percent")).toBe("100");
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.text()).toBe(errorBody);
    });
  });

  it("strips the full hop-by-hop header set, including Connection-nominated headers, on a non-streaming failure relay", async () => {
    const errorBody = JSON.stringify({ error: { message: "rate limited" } });
    const forward: ForwardOpenAI = async () => new Response(errorBody, {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "120",
        "x-codex-primary-used-percent": "100",
        te: "trailers",
        trailer: "x-trace-id",
        upgrade: "h2c",
        "proxy-authenticate": "Basic",
        connection: "close, x-internal-token",
        "x-internal-token": "secret",
      },
    });
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("120");
      expect(res.headers.get("x-codex-primary-used-percent")).toBe("100");
      // Fixed RFC 7230 hop-by-hop headers.
      expect(res.headers.get("te")).toBeNull();
      expect(res.headers.get("trailer")).toBeNull();
      expect(res.headers.get("upgrade")).toBeNull();
      expect(res.headers.get("proxy-authenticate")).toBeNull();
      // Nominated dynamically via this response's own Connection header.
      expect(res.headers.get("x-internal-token")).toBeNull();
      expect(await res.text()).toBe(errorBody);
    });
  });
});

describe("mountResponsesRoutes crash safety and relay correctness (F1/F5/F6/F10)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a local 502 when forwardOpenAI rejects, and does not crash the process (F1a)", async () => {
    const forward: ForwardOpenAI = async () => {
      throw new Error("network down");
    };
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual(
        expect.objectContaining({ error: expect.objectContaining({ type: "upstream_error" }) }),
      );
    });

    expect(activity.some(entry => entry.type === "error" && entry.statusCode === 502)).toBe(true);
  });

  it("returns a local 401 when prepareOpenAIAccount throws (F1b)", async () => {
    const forward = vi.fn();
    const prepare = vi.fn().mockRejectedValue(new Error("refresh exploded"));
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward, {
      prepareOpenAIAccount: prepare,
    });

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(
        expect.objectContaining({ error: expect.objectContaining({ type: "authentication_error" }) }),
      );
    });

    expect(forward).not.toHaveBeenCalled();
    expect(activity.some(entry => entry.type === "error" && entry.statusCode === 401)).toBe(true);
  });

  it("does not count a client-cancelled forward against the account", async () => {
    const account = makeRuntimeAccount("openai-victor");
    const forwardStarted = deferred<void>();
    // Behaves like fetch under an abort: pending until the signal fires, then
    // rejects with an AbortError.
    const forward: ForwardOpenAI = async opts => {
      forwardStarted.resolve();
      return new Promise<Response>((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        });
      });
    };
    const { app, activity, openAIPool } = mountWithPool([account], forward);

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let client: ClientRequest | undefined;

    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({ model: "openai/gpt-5.5", input: [] });
      const clientClosed = new Promise<void>(resolve => {
        client = httpRequest({
          host: "127.0.0.1",
          port,
          path: "/v1/responses",
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

      // The user pressed Ctrl-C. Nothing upstream failed, so none of this may
      // be charged to the account — repeated cancellations would otherwise
      // walk it to the unhealthy threshold and a cooldown.
      expect(account.errorCount).toBe(0);
      expect(account.consecutiveErrors).toBe(0);
      expect(activity).toHaveLength(0);
    } finally {
      client?.destroy();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it("does not count a client-cancelled relay against the account", async () => {
    const account = makeRuntimeAccount("openai-victor");
    const firstChunk = deferred<void>();
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'));
          firstChunk.resolve();
          // No terminal event will ever arrive — the client leaves first.
        },
      }) as BodyInit,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app, activity, openAIPool } = mountWithPool([account], forward);

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let client: ClientRequest | undefined;

    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true });
      const clientClosed = new Promise<void>(resolve => {
        client = httpRequest({
          host: "127.0.0.1",
          port,
          path: "/v1/responses",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        });
        client.on("error", () => resolve());
        client.on("close", () => resolve());
        client.end(body);
      });

      await firstChunk.promise;
      client!.destroy();
      await clientClosed;
      await vi.waitFor(() => expect(openAIPool.getInFlight(account.id)).toBe(0));
      await vi.waitFor(() => expect(activity).toHaveLength(1));

      // A stream cut short never reaches its terminal event, so the observer
      // reports a failure and the relay may reject outright — both are the
      // disconnect's doing, not the account's.
      expect(account.errorCount).toBe(0);
      expect(account.consecutiveErrors).toBe(0);
      expect(activity[0]).toEqual(expect.objectContaining({ type: "route", statusCode: 200 }));
      expect(activity[0]?.details).toContain("client-cancelled");
    } finally {
      client?.destroy();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it.each([
    ["streaming", true],
    ["collected", false],
  ])("keeps a bodyless successful-SSE %s response owned by upstream after client disconnect", async (_name, stream) => {
    const account = makeRuntimeAccount("openai-victor");
    const forwardStarted = deferred<void>();
    const forward: ForwardOpenAI = async opts => {
      forwardStarted.resolve();
      // Make the server observe the disconnect before the bodyless successful
      // SSE arrives. Upstream's invalid response must still own the outcome.
      await new Promise<void>(resolve => {
        if (opts.signal?.aborted) resolve();
        else opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return new Response(null, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const { app, activity, openAIPool } = mountWithPool([account], forward);
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let client: ClientRequest | undefined;

    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({ model: "openai/gpt-5.5", input: [], stream });
      const clientClosed = new Promise<void>(resolve => {
        client = httpRequest({
          host: "127.0.0.1",
          port,
          path: "/v1/responses",
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

      expect(activity[0]).toEqual(expect.objectContaining({ type: "error", statusCode: 502 }));
      expect(activity[0]?.details).not.toContain("client-cancelled");
      expect(account.errorCount).toBe(1);
      expect(account.consecutiveErrors).toBe(1);
      // A synthesized generic 502 counts against the account but is not an
      // overload/rate-limit signal and must not invent a cooldown horizon.
      expect(openAIPool.getGlobalCooldownUntil(account.id)).toBe(0);
    } finally {
      client?.destroy();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it("still counts an explicit response.failed when the client disconnects after it", async () => {
    const account = makeRuntimeAccount("openai-victor");
    const failureSent = deferred<void>();
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n'));
          failureSent.resolve();
          // Upstream has said the turn failed; the client leaves before EOF.
        },
      }) as BodyInit,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app, activity, openAIPool } = mountWithPool([account], forward);

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let client: ClientRequest | undefined;

    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true });
      const clientClosed = new Promise<void>(resolve => {
        client = httpRequest({
          host: "127.0.0.1",
          port,
          path: "/v1/responses",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        });
        client.on("error", () => resolve());
        client.on("close", () => resolve());
        client.end(body);
      });

      await failureSent.promise;
      client!.destroy();
      await clientClosed;
      await vi.waitFor(() => expect(openAIPool.getInFlight(account.id)).toBe(0));
      await vi.waitFor(() => expect(activity).toHaveLength(1));

      // A disconnect can truncate a stream; it cannot make upstream announce
      // a failure. Reading this as a cancellation would clear the account's
      // consecutive errors on the strength of a request that actually failed.
      expect(activity[0]).toEqual(expect.objectContaining({ type: "error", statusCode: 502 }));
      expect(account.errorCount).toBe(1);
      expect(account.consecutiveErrors).toBe(1);
    } finally {
      client?.destroy();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it("records a relay failure after headers were sent as a failure status, not the upstream 200", async () => {
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'));
          controller.error(new Error("upstream stream exploded"));
        },
      }) as BodyInit,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
      });
      // Headers are already on the wire, so the client keeps the upstream 200
      // and simply loses the connection partway through.
      expect(res.status).toBe(200);
      await res.text().catch(() => undefined);
    });

    // What the request *became* is a failure, and the recorded status has to
    // say so — an entry typed "error" carrying 200 contradicts itself and
    // reads as a success anywhere the status is what gets inspected.
    await vi.waitFor(() => expect(activity).toHaveLength(1));
    expect(activity[0]).toEqual(expect.objectContaining({ type: "error", statusCode: 502 }));
  });

  it("aborts the upstream request when the client disconnects mid-stream", async () => {
    const account = makeRuntimeAccount("openai-victor");
    const firstChunk = deferred<void>();
    let upstreamSignal: AbortSignal | undefined;
    let upstreamCancelled = false;
    const forward: ForwardOpenAI = async opts => {
      upstreamSignal = opts.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'));
            firstChunk.resolve();
            // Deliberately never closed: a stream that would keep the
            // account's upstream slot until it completes on its own.
          },
          cancel() { upstreamCancelled = true; },
        }) as BodyInit,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const { app, openAIPool } = mountWithPool([account], forward);

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let client: ClientRequest | undefined;

    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true });
      const clientClosed = new Promise<void>(resolve => {
        client = httpRequest({
          host: "127.0.0.1",
          port,
          path: "/v1/responses",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        });
        client.on("error", () => resolve());
        client.on("close", () => resolve());
        client.end(body);
      });

      await firstChunk.promise;
      expect(upstreamSignal?.aborted).toBe(false);

      client!.destroy();
      await clientClosed;

      // Releasing the lease only frees local capacity. Unless the upstream
      // request is cancelled too, the pool reports the account idle while a
      // Codex request is still running on it.
      await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
      await vi.waitFor(() => expect(upstreamCancelled).toBe(true));
      expect(openAIPool.getInFlight(account.id)).toBe(0);
    } finally {
      client?.destroy();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it("does not forward after the client disconnects during token refresh (P2 disconnect)", async () => {
    const account = makeRuntimeAccount("openai-victor");
    const refreshStarted = deferred<void>();
    const refreshResult = deferred<boolean>();
    const forward = vi.fn();
    const prepare = vi.fn(async () => {
      refreshStarted.resolve();
      return refreshResult.promise;
    });
    const { app, openAIPool } = mountWithPool([account], forward, { prepareOpenAIAccount: prepare });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let client: ClientRequest | undefined;

    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({ model: "openai/gpt-5.5", input: [] });
      const clientClosed = new Promise<void>(resolve => {
        client = httpRequest({
          host: "127.0.0.1",
          port,
          path: "/v1/responses",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        });
        client.on("error", () => resolve());
        client.on("close", () => resolve());
        client.end(body);
      });

      await refreshStarted.promise;
      expect(openAIPool.getInFlight(account.id)).toBe(1);
      client!.destroy();
      await clientClosed;
      await vi.waitFor(() => expect(openAIPool.getInFlight(account.id)).toBe(0));

      // Resolve the refresh only after the disconnect was observed — the
      // handler must see the terminated response and stop before forwarding.
      refreshResult.resolve(true);
      await new Promise(resolve => setImmediate(resolve));

      expect(forward).not.toHaveBeenCalled();
      expect(openAIPool.getInFlight(account.id)).toBe(0);
    } finally {
      refreshResult.resolve(true);
      client?.destroy();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it("fails a session over to another account after a token refresh failure", async () => {
    const forward = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    // Only the first account's refresh is broken; the second is healthy.
    const prepare = vi.fn(async (account: OpenAIAccount) => account.id !== "openai-broken");
    const { app, openAIPool } = mountWithPool(
      [makeRuntimeAccount("openai-broken"), makeRuntimeAccount("openai-good")],
      forward,
      { prepareOpenAIAccount: prepare },
    );

    await withServer(app, async baseUrl => {
      const send = () => fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", session_id: "session-failover" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      // The pool ranks the broken account first, so the sticky session binds
      // to it and gets a local 401.
      const first = await send();
      expect(first.status).toBe(401);

      // Without binding invalidation + cooldown the session would stay pinned
      // to the broken account and 401 forever.
      const second = await send();
      expect(second.status).toBe(200);
    });

    expect(openAIPool.getGlobalCooldownUntil("openai-broken")).toBeGreaterThan(0);
    expect(forward).toHaveBeenCalledOnce();
    expect(forward.mock.calls[0][0].account.id).toBe("openai-good");
  });

  it("returns a local 500 proxy_error when routing itself throws unexpectedly (F1c)", async () => {
    const app = express();
    const openAIPool = new OpenAITokenPool([makeRuntimeAccount("openai-victor")]);
    const brokenRouter = {
      acquire: () => {
        throw new Error("routing exploded");
      },
    } as unknown as SessionRouter<OpenAIAccount>;
    const activity: LogEntry[] = [];
    const forward = vi.fn();
    mountResponsesRoutes(app, {
      openAIRouter: brokenRouter,
      openAIPool,
      forwardOpenAI: forward,
      recordActivity: entry => activity.push(entry),
    });
    const before = await drainedErrorTotal();

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(
        expect.objectContaining({ error: expect.objectContaining({ type: "proxy_error" }) }),
      );
    });

    expect(forward).not.toHaveBeenCalled();
    expect(activity.some(entry => entry.type === "error" && entry.statusCode === 500)).toBe(true);
    // An unexpected routing failure must count toward totalErrors exactly
    // like the empty-pool and no-eligible-account branches immediately above
    // it in runOpenAIIngress — otherwise the daemon's stats would silently
    // under-report a whole class of routing failures.
    expect(stats.totalErrors).toBe(before + 1);
  });

  it("returns a local 502 when the relay throws before any bytes reach the client (F1d)", async () => {
    const forward: ForwardOpenAI = async () => new Response("data: x\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream", "retry-after": "1" },
    });
    const app = express();
    // Force the relay's header-mirroring loop to throw for one specific
    // header, before res.status()/write() ever runs — simulates a relay
    // failure that happens strictly before any upstream bytes are committed.
    app.use((_req, res: ExpressResponse, next) => {
      const original = res.setHeader.bind(res);
      res.setHeader = ((name: string, value: unknown) => {
        if (String(name).toLowerCase() === "retry-after") throw new Error("setHeader boom");
        return original(name, value);
      }) as typeof res.setHeader;
      next();
    });
    const openAIPool = new OpenAITokenPool([makeRuntimeAccount("openai-victor")]);
    const openAIRouter = new SessionRouter<OpenAIAccount>(openAIPool);
    const activity: LogEntry[] = [];
    mountResponsesRoutes(app, {
      openAIRouter,
      openAIPool,
      forwardOpenAI: forward,
      recordActivity: entry => activity.push(entry),
    });

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
      });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual(
        expect.objectContaining({ error: expect.objectContaining({ type: "upstream_error" }) }),
      );
    });

    expect(activity.some(entry => entry.type === "error" && entry.statusCode === 502)).toBe(true);
  });

  it("tears down gracefully and still records an error entry when the relay throws after bytes were already flushed (F1e)", async () => {
    const forward: ForwardOpenAI = async () => {
      let calls = 0;
      const reader = {
        read: async () => {
          calls++;
          if (calls === 1) {
            return { value: new TextEncoder().encode("data: partial\n\n"), done: false };
          }
          throw new Error("connection reset mid-stream");
        },
        cancel: async () => undefined,
      };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: { getReader: () => reader },
      } as unknown as Response;
    };
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
      });

      // Status/headers were already committed before the failure — the best
      // we can do is stop, not retract what was already sent.
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("data: partial\n\n");
    });

    expect(activity.some(entry => entry.type === "error")).toBe(true);
  });

  it("does not crash when upstream response classification (header/rate-limit parsing) throws", async () => {
    let forEachCalls = 0;
    const fakeUpstream = {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
        forEach: (_cb: (value: string, key: string) => void) => {
          forEachCalls++;
          if (forEachCalls === 1) throw new Error("headers boom");
          // Second call is the relay's own header-mirror loop — a no-op here.
        },
      },
      // Deliberately no .json() method, so if classification's throw were
      // ever left unguarded and crashed the daemon, this test would hang or
      // reject instead of observing a clean response below.
    } as unknown as Response;
    const forward: ForwardOpenAI = async () => fakeUpstream;
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(502);
    });

    expect(activity.some(entry => entry.type === "error")).toBe(true);
  });

  it("never mirrors content-encoding or set-cookie to the client, but keeps retry-after intact (F6)", async () => {
    const rawBody = "plain-text-body-not-actually-gzipped";
    const forward: ForwardOpenAI = async () => new Response(rawBody, {
      status: 429,
      headers: {
        "content-type": "text/plain",
        "content-encoding": "gzip",
        "set-cookie": "sess=abc; HttpOnly",
        "retry-after": "120",
      },
    });
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("retry-after")).toBe("120");
      // If content-encoding leaked through, fetch would try to gunzip a body
      // that was never actually compressed and .text() would throw instead
      // of resolving — a stronger signal than just checking header absence.
      await expect(res.text()).resolves.toBe(rawBody);
    });
  });

  it("strips the full hop-by-hop header set on a streaming relay, without altering the relayed bytes", async () => {
    const rawBody = JSON.stringify({ error: { message: "rate limited" } });
    const forward: ForwardOpenAI = async () => new Response(rawBody, {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "120",
        "x-codex-primary-used-percent": "100",
        te: "trailers",
        trailer: "x-trace-id",
        upgrade: "h2c",
        "proxy-authenticate": "Basic",
        connection: "close, x-internal-token",
        "x-internal-token": "secret",
      },
    });
    const { app } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("120");
      expect(res.headers.get("x-codex-primary-used-percent")).toBe("100");
      // Fixed RFC 7230 hop-by-hop headers.
      expect(res.headers.get("te")).toBeNull();
      expect(res.headers.get("trailer")).toBeNull();
      expect(res.headers.get("upgrade")).toBeNull();
      expect(res.headers.get("proxy-authenticate")).toBeNull();
      // Nominated dynamically via this response's own Connection header.
      expect(res.headers.get("x-internal-token")).toBeNull();
      // The relay is byte-transparent: header filtering must never touch the body.
      await expect(res.text()).resolves.toBe(rawBody);
    });
  });

  it("classifies a synthesized 502 (upstream 200 SSE ending in response.failed) as a client-facing error, not a success (F10)", async () => {
    const forward: ForwardOpenAI = async () => new Response(
      'data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const account = makeRuntimeAccount("openai-victor");
    const { app, activity } = mountWithPool([account], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual(
        expect.objectContaining({ error: expect.objectContaining({ type: "upstream_error", message: "boom" }) }),
      );
    });

    // Counted through this test's own observables, not the process-global
    // `stats.totalErrors`: the handler's bookkeeping runs after the client's
    // response resolves, so an exact assertion on a shared counter picks up
    // whatever an earlier test left settling. `account.errorCount` and
    // `activity` are created by this test and are incremented from the same
    // `failedFinal` branch as the global total.
    await vi.waitFor(() => expect(activity).toHaveLength(1));
    expect(activity[0]).toEqual(expect.objectContaining({ type: "error", statusCode: 502 }));
    expect(account.errorCount).toBe(1);
  });

  it("relays a streamed upstream 200 ending in response.failed byte-for-byte, but reports it as a 502 error", async () => {
    const failedBody = 'data: {"type":"response.failed","response":{"error":{"message":"stream boom"}}}\n\n';
    const forward: ForwardOpenAI = async () => new Response(failedBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const account = makeRuntimeAccount("openai-victor");
    const { app, activity } = mountWithPool([account], forward);
    const errorCountBefore = account.errorCount;

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
      });

      // The client-visible status/body reflect the RELAY's synthesized
      // failure for stats/activity purposes, but the bytes written to the
      // wire are byte-identical to what upstream sent — the relay never
      // rewrites the stream itself.
      expect(await res.text()).toBe(failedBody);
    });

    // Per-test observables rather than the shared `stats.totalErrors` — see
    // the note on the preceding test.
    await vi.waitFor(() => expect(activity).toHaveLength(1));
    expect(activity[0]).toEqual(expect.objectContaining({ type: "error", statusCode: 502 }));
    // A relay-synthesized failure on an otherwise-200 upstream must still be
    // counted against the account exactly once — not silently dropped, and
    // not double-counted if upstream classification already counted it
    // (it did not here, since upstream.status was 200).
    expect(account.errorCount).toBe(errorCountBefore + 1);
    expect(account.consecutiveErrors).toBe(1);
  });

  it("reports a 502 for a streamed upstream 200 whose terminal frame is malformed, but relays the bytes byte-for-byte", async () => {
    // The terminal response.completed frame is malformed JSON: tolerant
    // parsing drops it rather than aborting the relay, so without a
    // completion check the observer would report an ordinary 200 success
    // even though the client never actually received a finished answer.
    const malformedTail = 'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'
      + 'data: {"type":"response.output_text.delta","delta":"Par"}\n\n'
      + 'data: {"type":"response.completed","response":{"id":\n\n';
    const forward: ForwardOpenAI = async () => new Response(malformedTail, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
      });
      // Byte-transparent relay: what upstream sent is exactly what the client
      // receives, regardless of how the relay classifies it for stats.
      expect(await res.text()).toBe(malformedTail);
    });

    const errorEntry = activity.find(entry => entry.type === "error");
    expect(errorEntry).toEqual(expect.objectContaining({ statusCode: 502 }));
  });

  it("reports a 502 for a streamed upstream 200 that stops before response.completed, but relays the bytes byte-for-byte", async () => {
    const partialBody = 'data: {"type":"response.output_text.delta","delta":"Par"}\n\n';
    const forward: ForwardOpenAI = async () => new Response(partialBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
      });
      expect(await res.text()).toBe(partialBody);
    });

    const errorEntry = activity.find(entry => entry.type === "error");
    expect(errorEntry).toEqual(expect.objectContaining({ statusCode: 502 }));
  });

  it("invokes onUpstreamAuthFailure with the routed account when a relayed upstream 401 occurs (F5)", async () => {
    const account = makeRuntimeAccount("openai-victor");
    const forward: ForwardOpenAI = async () => new Response(
      JSON.stringify({ error: { message: "invalid token" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
    const onUpstreamAuthFailure = vi.fn();
    const { app } = mountWithPool([account], forward, { onUpstreamAuthFailure });

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });
      expect(res.status).toBe(401);
    });

    expect(onUpstreamAuthFailure).toHaveBeenCalledTimes(1);
    expect(onUpstreamAuthFailure).toHaveBeenCalledWith(expect.objectContaining({ id: "openai-victor" }));
  });
});

const SSE_BODY = `event: response.completed\ndata: ${JSON.stringify({
  type: "response.completed",
  response: { id: "resp_1", model: "gpt-5.6-luna", usage: { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 60 } } },
})}\n\n`;

// response.incomplete is also a terminal Responses event — generation
// stopped without completing (e.g. hitting max_output_tokens), but the frame
// still carries a full response with usage. It must relay and account like
// any other successful route, not like response.failed/error.
const INCOMPLETE_SSE_BODY = `event: response.incomplete\ndata: ${JSON.stringify({
  type: "response.incomplete",
  response: {
    id: "resp_2",
    model: "gpt-5.6-luna",
    usage: { input_tokens: 40, output_tokens: 10, input_tokens_details: { cached_tokens: 5 } },
    incomplete_details: { reason: "max_output_tokens" },
  },
})}\n\n`;

function sseResponse(headers: Record<string, string> = {}): Response {
  return new Response(SSE_BODY, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function post(baseUrl: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "openai/gpt-5.6-luna", input: [], stream: true, ...body }),
  });
}

describe("mountResponsesRoutes sticky routing", () => {
  it("pins a session to one account across turns while a second session uses the idle account", async () => {
    const accounts = [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")];
    const seen: string[] = [];
    const forwardOpenAI = vi.fn(async (opts: { account: OpenAIAccount }) => {
      seen.push(opts.account.id);
      return sseResponse();
    });
    const { app } = mountWithPool(accounts, forwardOpenAI);

    await withServer(app, async baseUrl => {
      await (await post(baseUrl, {}, { "session_id": "s1" })).text();
      await (await post(baseUrl, {}, { "session_id": "s1" })).text();
      await (await post(baseUrl, {}, { "session_id": "s2" })).text();
    });

    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
  });

  it("populates the account snapshot from x-codex-* response headers", async () => {
    const account = makeRuntimeAccount("openai-a");
    const forwardOpenAI = vi.fn(async () => sseResponse({
      "x-codex-primary-used-percent": "42",
      "x-codex-secondary-used-percent": "5",
    }));
    const { app } = mountWithPool([account], forwardOpenAI);

    await withServer(app, async baseUrl => {
      await (await post(baseUrl, {})).text();
    });

    const bucket = account.rateLimits.buckets.get("codex");
    expect(bucket?.primary?.utilization).toBeCloseTo(0.42);
    expect(bucket?.secondary?.utilization).toBeCloseTo(0.05);
  });

  it("relays a 429 byte-for-byte with its headers, sets a global cooldown, and rebinds the retry", async () => {
    const accounts = [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")];
    const seen: string[] = [];
    const forwardOpenAI = vi.fn(async (opts: { account: OpenAIAccount }) => {
      seen.push(opts.account.id);
      if (seen.length === 1) {
        return new Response("upstream-429", {
          status: 429,
          headers: { "content-type": "text/event-stream", "retry-after": "120" },
        });
      }
      return sseResponse();
    });
    const { app, openAIPool } = mountWithPool(accounts, forwardOpenAI);

    await withServer(app, async baseUrl => {
      const first = await post(baseUrl, {}, { "session_id": "s1" });
      expect(first.status).toBe(429);
      expect(first.headers.get("retry-after")).toBe("120");
      expect(await first.text()).toBe("upstream-429");
      expect(openAIPool.isCoolingDown(seen[0]!)).toBe(true);

      const second = await post(baseUrl, {}, { "session_id": "s1" });
      expect(second.status).toBe(200);
      await second.text();
    });

    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it("records the real upstream status for a streamed non-SSE error, not a synthesized 502", async () => {
    // A stream:true request whose upstream answers with a plain JSON 429 has no
    // SSE events to observe, so the missing-completion check must not fire —
    // the client already received 429 and the activity log has to agree.
    const account = makeRuntimeAccount("openai-a");
    const forwardOpenAI = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "rate limit reached" } }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } },
    ));
    const { app, activity } = mountWithPool([account], forwardOpenAI);

    await withServer(app, async baseUrl => {
      const res = await post(baseUrl, {});
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(await res.text()).toBe(JSON.stringify({ error: { message: "rate limit reached" } }));
    });

    const entry = activity.find(e => e.type === "error");
    expect(entry?.statusCode).toBe(429);
    expect(activity.some(e => e.statusCode === 502)).toBe(false);
  });

  it("scopes a 429 with x-codex-active-limit to the named bucket only", async () => {
    const account = makeRuntimeAccount("openai-a");
    const forwardOpenAI = vi.fn(async () => {
      if (forwardOpenAI.mock.calls.length === 1) {
        return new Response("bucket-429", {
          status: 429,
          headers: {
            "content-type": "text/event-stream",
            "x-codex-active-limit": "codex-bengalfox",
            "x-codex-bengalfox-primary-used-percent": "100",
            "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
          },
        });
      }
      return sseResponse();
    });
    const { app } = mountWithPool([account], forwardOpenAI);

    await withServer(app, async baseUrl => {
      const first = await post(baseUrl, { model: "openai/gpt-5.6-sol" });
      expect(first.status).toBe(429);
      await first.text();

      const sameModel = await post(baseUrl, { model: "openai/gpt-5.6-sol" });
      expect(sameModel.status).toBe(429);
      const localBody = await sameModel.json() as { error: { type: string } };
      expect(localBody.error.type).toBe("rate_limit_exceeded");
      expect(forwardOpenAI).toHaveBeenCalledTimes(1); // zero upstream calls for the blocked model

      const otherModel = await post(baseUrl, { model: "openai/gpt-5.6-luna" });
      expect(otherModel.status).toBe(200);
      await otherModel.text();
      expect(forwardOpenAI).toHaveBeenCalledTimes(2);
    });
  });

  it("returns a local 429 with Retry-After and zero upstream calls when all accounts are blocked", async () => {
    const account = makeRuntimeAccount("openai-a");
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 600),
    }, Date.now()), Date.now());
    const forwardOpenAI = vi.fn();
    const { app, activity } = mountWithPool([account], forwardOpenAI as never);

    await withServer(app, async baseUrl => {
      const response = await post(baseUrl, {});
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      const body = await response.json() as { error: { type: string } };
      expect(body.error.type).toBe("rate_limit_exceeded");
    });

    expect(forwardOpenAI).not.toHaveBeenCalled();
    expect(activity.some(entry => entry.type === "error" && entry.details?.includes("rate-limited"))).toBe(true);
  });

  it("streams responses byte-for-byte and captures token usage into activity", async () => {
    const account = makeRuntimeAccount("openai-a");
    const { app, activity } = mountWithPool([account], vi.fn(async () => sseResponse()));

    await withServer(app, async baseUrl => {
      const response = await post(baseUrl, {});
      expect(await response.text()).toBe(SSE_BODY); // byte-identical relay
    });

    const entry = activity.find(e => e.type === "route");
    expect(entry?.inputTokens).toBe(100);
    expect(entry?.outputTokens).toBe(25);
    expect(entry?.cacheReadTokens).toBe(60);
  });

  it("streams a response.incomplete terminal event byte-for-byte and records it as a successful route with usage, not a 502", async () => {
    const account = makeRuntimeAccount("openai-a");
    const forwardOpenAI = vi.fn(async () => new Response(INCOMPLETE_SSE_BODY, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const { app, activity } = mountWithPool([account], forwardOpenAI);

    await withServer(app, async baseUrl => {
      const response = await post(baseUrl, {});
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(INCOMPLETE_SSE_BODY); // byte-identical relay
    });

    expect(activity.some(e => e.type === "error")).toBe(false);
    const entry = activity.find(e => e.type === "route");
    expect(entry).toBeDefined();
    expect(entry?.inputTokens).toBe(40);
    expect(entry?.outputTokens).toBe(10);
    expect(entry?.cacheReadTokens).toBe(5);
  });

  it("relays a stream byte-for-byte and still records activity when a malformed SSE data line precedes a valid frame", async () => {
    const account = makeRuntimeAccount("openai-a");
    const malformedChunk = "data: not-json\n\n";
    const encoder = new TextEncoder();
    const upstreamStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(malformedChunk));
        controller.enqueue(encoder.encode(SSE_BODY));
        controller.close();
      },
    });
    const forwardOpenAI = vi.fn(async () => new Response(upstreamStream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const { app, activity } = mountWithPool([account], forwardOpenAI);

    let bodyText = "";
    await withServer(app, async baseUrl => {
      const response = await post(baseUrl, {});
      expect(response.status).toBe(200);
      bodyText = await response.text();
    });

    // Byte-for-byte relay: the malformed frame never blocks or mutates the
    // stream written to the client, it only breaks usage capture for the
    // observer (which is allowed to miss tokens, never to throw).
    expect(bodyText).toBe(malformedChunk + SSE_BODY);

    const entry = activity.find(e => e.type === "route");
    expect(entry).toBeDefined();
  });

  it("keeps returning 503 no_accounts for an empty pool", async () => {
    const { app } = mountWithPool([], vi.fn() as never);
    await withServer(app, async baseUrl => {
      const response = await post(baseUrl, {});
      expect(response.status).toBe(503);
      const body = await response.json() as { error: { type: string } };
      expect(body.error.type).toBe("no_accounts");
    });
  });
});

describe("activity entries are shaped like the Claude path's", () => {
  it("records the request method and a codex source so the dashboard renders a full row", async () => {
    // The dashboard needs BOTH method and path to print "POST /v1/responses"
    // (Dashboard.tsx), otherwise it falls back to the bare entry type and the
    // row reads "route"; an absent source blanks the client column. The Claude
    // path sets all three, so Codex rows looked different for no good reason.
    const forward: ForwardOpenAI = async () => new Response(
      JSON.stringify({ id: "resp_1", object: "response", status: "completed", output: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-victor")], forward);

    await withServer(app, async baseUrl => {
      await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: false }),
      });
    });

    const routed = activity.find(e => e.type === "route");
    expect(routed).toBeDefined();
    expect(routed).toEqual(expect.objectContaining({
      method: "POST",
      path: "/v1/responses",
      source: "codex",
    }));
  });
});
