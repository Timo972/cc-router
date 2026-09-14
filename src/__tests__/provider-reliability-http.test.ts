import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { expect, it, vi } from "vitest";
import { createOpenAIAccount } from "../providers/openai/account-state.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { SessionRouter } from "../proxy/session-router.js";
import { mountResponsesRoutes } from "../proxy/responses-server.js";
import { stats, type LogEntry } from "../proxy/stats.js";

it("preserves progressing HTTP streams and distinguishes router timeouts from client cancellation", async () => {
  const realFetch = globalThis.fetch;
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const activity: LogEntry[] = [];
  let cancelledUpstream = false;
  const event = (res: ServerResponse, data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const mode = JSON.parse(raw).input[0].content[0].text;
    if (mode === "headers") return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, { type: "response.created", response: { id: "test" } });
    if (mode === "idle") return;
    let chunks = 0;
    const timer = setInterval(() => {
      event(res, { type: "response.output_text.delta", delta: "x" });
      if (mode === "active" && ++chunks === 8) {
        clearInterval(timer);
        intervals.delete(timer);
        event(res, { type: "response.completed", response: { id: "test", status: "completed", output: [] } });
        res.end();
      }
    }, 100);
    intervals.add(timer);
    res.once("close", () => {
      clearInterval(timer);
      intervals.delete(timer);
      if (mode === "cancel") cancelledUpstream = true;
    });
  });
  const account = createOpenAIAccount({
    id: "test", provider: "openai_subscription", enabled: true,
    accessToken: "synthetic", refreshToken: "synthetic", expiresAt: Date.now() + 3_600_000,
  });
  const pool = new OpenAITokenPool([account]);
  const app = express();
  mountResponsesRoutes(app, {
    openAIPool: pool, openAIRouter: new SessionRouter(pool), timeoutMs: 500,
    prepareOpenAIAccount: async () => true, recordActivity: entry => activity.push(entry),
  });
  const proxy = createServer(app);
  try {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/v1/responses`;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
      expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
      return realFetch(upstreamUrl, options);
    });
    const request = (mode: string, signal = AbortSignal.timeout(5_000)) => realFetch(proxyUrl, {
      method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: mode }] }] }),
    });

    const started = performance.now();
    const active = await request("active");
    expect(await active.text()).toContain("response.completed");
    expect(performance.now() - started).toBeGreaterThan(500);
    await vi.waitFor(() => expect(activity).toHaveLength(1));
    expect(account.errorCount).toBe(0);

    const headers = await request("headers");
    expect(headers.status).toBe(504);
    await headers.text();
    const idle = await request("idle");
    expect(idle.status).toBe(200);
    await expect(idle.text()).rejects.toThrow();
    await vi.waitFor(() => expect(activity).toHaveLength(3));
    expect(activity.map(entry => entry.statusCode)).toEqual([200, 504, 502]);
    expect(account.errorCount).toBe(2);
    await vi.waitFor(() => expect(pool.getInFlight(account.id)).toBe(0));

    const beforeErrors = stats.totalErrors;
    const cancel = new AbortController();
    const response = await request("cancel", cancel.signal);
    const reader = response.body!.getReader();
    await reader.read();
    cancel.abort();
    await reader.cancel().catch(() => {});
    await vi.waitFor(() => expect(cancelledUpstream).toBe(true));
    await vi.waitFor(() => expect(activity).toHaveLength(4));
    expect(account.errorCount).toBe(2);
    expect(stats.totalErrors).toBe(beforeErrors);
    await vi.waitFor(() => expect(pool.getInFlight(account.id)).toBe(0));
    expect(activity[3].details).toContain("client-cancelled");
    expect(activity[0]).toMatchObject({
      refreshDurationMs: expect.any(Number), headerDurationMs: expect.any(Number),
      firstByteDurationMs: expect.any(Number), correlationId: expect.stringMatching(/^oai-/),
    });
  } finally {
    vi.restoreAllMocks();
    for (const timer of intervals) clearInterval(timer);
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([proxy, upstream].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}, 10_000);
