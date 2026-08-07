import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "http";
import { forwardOpenAICodexResponse, toCodexBackendRequest } from "../providers/openai/codex-transport.js";
import { mountResponsesRoutes } from "../proxy/responses-server.js";
import type { ResponsesRoutesOptions } from "../proxy/responses-server.js";
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
  forwardOpenAI: ForwardOpenAI,
  extra: Partial<ResponsesRoutesOptions> = {},
) {
  const app = express();
  const openAIPool = new OpenAITokenPool(accounts);
  const openAIRouter = new SessionRouter<OpenAIAccount>(openAIPool);
  const activity: LogEntry[] = [];
  mountResponsesRoutes(app, {
    openAIRouter,
    openAIPool,
    forwardOpenAI,
    recordActivity: entry => activity.push(entry),
    ...extra,
  });
  return { app, openAIPool, openAIRouter, activity };
}

describe("mountResponsesRoutes", () => {
  afterEach(() => vi.restoreAllMocks());

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
    const forward: ForwardOpenAI = async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("data: {\"type\":\"response.created\"}\n\n"));
          setTimeout(() => {
            controller.enqueue(encoder.encode("data: {\"type\":\"response.completed\"}\n\n"));
            controller.close();
          }, 100);
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
});

const SSE_BODY = `event: response.completed\ndata: ${JSON.stringify({
  type: "response.completed",
  response: { id: "resp_1", model: "gpt-5.6-luna", usage: { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 60 } } },
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
