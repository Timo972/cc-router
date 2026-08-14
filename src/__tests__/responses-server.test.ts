import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "http";
import { forwardOpenAICodexResponse, toCodexBackendRequest } from "../providers/openai/codex-transport.js";
import { mountResponsesRoutes } from "../proxy/responses-server.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";

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

      const app = express();
      mountResponsesRoutes(app, {
        getOpenAIAccount: () => ({
          id: "openai-victor",
          provider: "openai_subscription",
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: Date.now() + 60_000,
          enabled: true,
        }),
      });

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

  it("aborts a successful SSE response that reaches EOF without a terminal event", async () => {
    const app = express();
    mountResponsesRoutes(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      }),
      forwardOpenAI: async () => new Response(
        'data: {"type":"response.created","response":{"id":"resp_cut_off"}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    });

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: true }),
      });

      expect(res.status).toBe(200);
      await expect(res.text()).rejects.toThrow();
    });
  });

  it.each([
    ["response.incomplete", { type: "response.incomplete", response: { id: "resp_1", status: "incomplete" } }],
    ["response.failed", { type: "response.failed", response: { error: { message: "failed" } } }],
    ["error", { type: "error", error: { message: "errored" } }],
  ])("relays a %s terminal event exactly once before closing", async (_name, event) => {
    const body = `data: ${JSON.stringify(event)}\n\n`;
    const app = express();
    mountResponsesRoutes(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      }),
      forwardOpenAI: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    });

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
    const record = vi.fn();
    const forward = vi.fn();
    const app = express();

    mountResponsesRoutes(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      }),
      forwardOpenAI: forward,
      recordActivity: record,
    });

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
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ type: "warn", statusCode: 400, accountId: "-" }),
      );
    });
  });

  it("accepts Codex Responses requests and strips the openai model prefix before forwarding", async () => {
    const forwardedBodies: OpenAIResponsesRequest[] = [];
    const app = express();

    mountResponsesRoutes(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async ({ body }) => {
        forwardedBodies.push(body);
        return new Response(JSON.stringify({ id: "resp_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
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
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("applies configured OpenAI model aliases before forwarding Responses requests", async () => {
    const forwardedBodies: OpenAIResponsesRequest[] = [];
    const app = express();

    mountResponsesRoutes(app, {
      modelRouting: { openAIAliases: { codex: "gpt-5-codex" } },
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async ({ body }) => {
        forwardedBodies.push(body);
        return new Response(JSON.stringify({ id: "resp_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/codex", input: [] }),
      });

      expect(res.status).toBe(200);
      expect(forwardedBodies[0].model).toBe("gpt-5-codex");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("refreshes the selected OpenAI account before forwarding", async () => {
    const prepare = vi.fn().mockResolvedValue(true);
    const forward = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const app = express();

    mountResponsesRoutes(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      }),
      prepareOpenAIAccount: prepare,
      forwardOpenAI: forward,
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
      });

      expect(res.status).toBe(200);
      expect(prepare).toHaveBeenCalledOnce();
      expect(forward).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("streams upstream Responses SSE chunks without waiting for the full body", async () => {
    const app = express();

    mountResponsesRoutes(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async () => new Response(
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
      ),
    });

    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    try {
      const res = await Promise.race([
        fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
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
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it("warns on an explicit max_output_tokens, then forwards and reconciles", async () => {
    const record = vi.fn();
    const forward = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "resp_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = express();

    mountResponsesRoutes(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      }),
      forwardOpenAI: forward,
      recordActivity: record,
    });

    await withServer(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], max_output_tokens: 256 }),
      });

      expect(res.status).toBe(200);
      expect(forward).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warn",
          accountId: "-",
          details: expect.stringContaining("max_output_tokens"),
        }),
      );
    });
  });

  it("reconciles a non-streaming request into a single JSON body", async () => {
    const app = express();

    mountResponsesRoutes(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async () => new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'));
            controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","output":[]}}\n\n'));
            controller.close();
          },
        }) as BodyInit,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    });

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
    const app = express();
    const errorBody = JSON.stringify({ error: { message: "upstream boom" } });

    mountResponsesRoutes(app, {
      getOpenAIAccount: () => ({
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
      forwardOpenAI: async () => new Response(errorBody, {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    });

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
});
