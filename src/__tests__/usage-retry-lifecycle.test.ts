import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request } from "express";
import { DEFAULT_RATE_LIMITS, type Account } from "../proxy/types.js";
import { TokenPool } from "../proxy/token-pool.js";
import { SessionRouter } from "../proxy/session-router.js";
import { mountAnthropicMessagesRoute } from "../proxy/anthropic-messages-route.js";
import { startUsageRuntime } from "../usage/runtime.js";
import { UsageStore } from "../usage/store.js";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return (server.address() as { port: number }).port;
}
it.each(["failed", "rejected", "timeout", "disconnect"])("discards repeated unsent Anthropic retry candidates after %s without a shutdown-only observation", async outcome => {
  const directory = mkdtempSync(join(tmpdir(), "usage-retry-")); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = startUsageRuntime(directory, [{ id: "a" }, { id: "b" }]); cleanups.push(() => runtime.close());
  let calls = 0;
  const upstream = createServer((req, res) => {
    req.resume(); req.on("end", () => { calls++; expect(req.headers.authorization).toBe("Bearer access-a"); res.writeHead(429, { "content-type": "application/json", "retry-after": "60" }); res.end('{"error":{"type":"rate_limit_error","message":"held failure"}}'); });
  });
  const upstreamPort = await listen(upstream);
  for (let iteration = 0; iteration < 2; iteration++) {
    const pool = new TokenPool(["a", "b"].map((id): Account => ({ id, tokens: { accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + 3600000, scopes: ["user:inference"] }, healthy: true, busy: false, enabled: true, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0, consecutiveErrors: 0, rateLimits: { ...DEFAULT_RATE_LIMITS }, sessionLimitPercent: 100, weeklyLimitPercent: 100 })));
    const router = new SessionRouter(pool); const app = express(); const controller = new AbortController();
    let resolveRefresh: ((ok: boolean) => void) | undefined;
    const refresh = vi.fn(() => outcome === "failed" ? Promise.resolve(false) : outcome === "rejected" ? Promise.reject(new Error("fixture refresh failed")) : new Promise<boolean>(resolve => { resolveRefresh = resolve; }));
    app.post("/v1/messages", express.json({ verify: (req, _res, bytes) => { (req as Request)._ccRawBody = Buffer.from(bytes); } }), (req, _res, next) => { req._ccRouteContext = { requestedModel: "claude-sonnet-4-6", modelFamily: "sonnet" }; next(); });
    mountAnthropicMessagesRoute(app, { target: `http://127.0.0.1:${upstreamPort}`, timeoutMs: 1000, pool, sessionRouter: router, usageRuntime: runtime,
      needsRefresh: account => account.id === "b", refresh, onRefreshFailure: vi.fn(), maxAttempts: 2, retryRefreshTimeoutMs: outcome === "disconnect" ? 5000 : 20 });
    const port = await listen(createServer(app));
    const pending = fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [], max_tokens: 10 }), signal: controller.signal });
    if (outcome === "disconnect") {
      const rejected = expect(pending).rejects.toThrow(); await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce()); controller.abort(); await rejected;
    } else {
      const response = await pending; expect(response.status).toBe(429); expect(await response.text()).toBe('{"error":{"type":"rate_limit_error","message":"held failure"}}');
    }
    await vi.waitFor(() => { expect(pool.getInFlight("a")).toBe(0); expect(pool.getInFlight("b")).toBe(0); });
    resolveRefresh?.(true); await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce(); expect(calls).toBe(iteration + 1);
    expect(runtime.snapshot().observations).toHaveLength(iteration + 1);
  }
  const beforeClose = runtime.snapshot().observations; runtime.close();
  expect(UsageStore.read(directory).observations).toEqual(beforeClose);
});
