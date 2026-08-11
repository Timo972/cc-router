import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "http";
import express from "express";
import { ReadableStream } from "stream/web";
import { mountMessagesCrossProviderRoute } from "../proxy/messages-cross-route.js";
import type { MessagesCrossProviderRouteOptions } from "../proxy/messages-cross-route.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";
import { SessionRouter } from "../proxy/session-router.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { applyCodexRateLimits, createOpenAIAccount, type OpenAIAccount } from "../providers/openai/account-state.js";
import { parseCodexRateLimits } from "../providers/openai/usage.js";
import type { LogEntry } from "../proxy/stats.js";

type ForwardOpenAI = (opts: { account: OpenAIAccount; body: OpenAIResponsesRequest; stream: boolean }) => Promise<Response>;

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
) {
  const app = express();
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
      { status: 429, headers: { "content-type": "application/json" } },
    ));
    const { app } = mountWithRealTransport(makeRuntimeAccount("openai-victor"));

    await withServer(app, async baseUrl => {
      const res = await postMessages(baseUrl, {});
      expect(res.status).toBe(429);
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
