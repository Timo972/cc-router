import { createServer, request, type ClientRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicProxy } from "../proxy/anthropic-proxy.js";
import { applyUpstreamFailureRouting } from "../proxy/lease-lifecycle.js";
import {
  createAnthropicRefreshMiddleware,
  createAnthropicRoutingMiddleware,
} from "../proxy/anthropic-routing.js";
import { SessionRouter } from "../proxy/session-router.js";
import { TokenPool } from "../proxy/token-pool.js";
import type { Account } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";

function makeAccount(id: string): Account {
  return {
    id,
    tokens: {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 60_000,
      scopes: ["user:inference"],
    },
    healthy: true,
    busy: false,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
    rateLimits: { ...DEFAULT_RATE_LIMITS },
    enabled: true,
    sessionLimitPercent: 100,
    weeklyLimitPercent: 100,
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/**
 * Fail with `message` instead of hanging to the suite-level timeout. Timing
 * premises that go unmet otherwise surface as an opaque 5s stall.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms).unref();
    }),
  ]);
}

function collect(
  url: URL,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function startCollecting(
  url: URL,
  headers: Record<string, string> = {},
): {
  firstChunk: Promise<void>;
  completed: Promise<Buffer>;
  hasCompleted: () => boolean;
  request: ClientRequest;
} {
  const first = deferred();
  let completed = false;
  let clientRequest!: ClientRequest;
  const body = new Promise<Buffer>((resolve, reject) => {
    clientRequest = request(url, { headers }, response => {
      const chunks: Buffer[] = [];
      response.once("data", () => first.resolve());
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        completed = true;
        resolve(Buffer.concat(chunks));
      });
      response.on("error", reject);
    });
    clientRequest.on("error", reject);
    clientRequest.end();
  });
  return {
    firstChunk: first.promise,
    completed: body,
    hasCompleted: () => completed,
    request: clientRequest,
  };
}

describe("createAnthropicProxy", () => {
  it("forwards deliberately split SSE bytes without inserting or removing events", async () => {
    const chunks = [
      Buffer.from("event: message_start\nda"),
      Buffer.from("ta: {\"type\":\"message_start\"}\n\n"),
      Buffer.from("event: content_block_delta\ndata: {\"delta\":{\"text\":\"hello\"}}\n\n"),
      Buffer.from("event: message_"),
      Buffer.from("stop\ndata: {\"type\":\"message_stop\"}\n\n"),
    ];
    const upstreamBody = Buffer.concat(chunks);
    const observedChunks: Buffer[] = [];
    let upstreamPath = "";
    const upstream = createServer((_req, res) => {
      upstreamPath = _req.url ?? "";
      res.writeHead(200, { "content-type": "text/event-stream" });
      let index = 0;
      const writeNext = () => {
        if (index === chunks.length) {
          res.end();
          return;
        }
        res.write(chunks[index++]);
        setImmediate(writeNext);
      };
      writeNext();
    });
    const upstreamPort = await listen(upstream);

    const app = express();
    app.use("/v1", createAnthropicProxy({
      target: `http://127.0.0.1:${upstreamPort}`,
      timeoutMs: 2_000,
      on: {
        proxyRes: proxyResponse => {
          proxyResponse.on("data", chunk => observedChunks.push(Buffer.from(chunk)));
        },
      },
    }));
    const downstream = createServer(app);
    const downstreamPort = await listen(downstream);

    try {
      const response = await collect(new URL(`http://127.0.0.1:${downstreamPort}/v1/messages`));

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(upstreamPath).toBe("/v1/messages");
      expect(Buffer.compare(response.body, upstreamBody)).toBe(0);
      expect(Buffer.compare(Buffer.concat(observedChunks), upstreamBody)).toBe(0);
      expect(response.body.toString("utf8").match(/event: message_stop/g)).toHaveLength(1);
    } finally {
      await close(downstream);
      await close(upstream);
    }
  });

  it("keeps concurrent SSE responses open until each upstream stream terminates", async () => {
    const gates = new Map([
      ["/v1/one", deferred()],
      ["/v1/two", deferred()],
    ]);
    const expected = new Map<string, Buffer>();
    const upstream = createServer(async (req, res) => {
      const path = req.url ?? "";
      const gate = gates.get(path);
      if (!gate) {
        res.writeHead(404).end();
        return;
      }
      const prefix = Buffer.from(`event: ping\ndata: {\"stream\":\"${path}\"}\n\n`);
      const suffix = Buffer.from("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
      expected.set(path, Buffer.concat([prefix, suffix]));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(prefix);
      await gate.promise;
      res.end(suffix);
    });
    const upstreamPort = await listen(upstream);

    const app = express();
    app.use("/v1", createAnthropicProxy({
      target: `http://127.0.0.1:${upstreamPort}`,
      timeoutMs: 10_000,
      on: {},
    }));
    const downstream = createServer(app);
    const downstreamPort = await listen(downstream);

    const one = startCollecting(new URL(`http://127.0.0.1:${downstreamPort}/v1/one`));
    const two = startCollecting(new URL(`http://127.0.0.1:${downstreamPort}/v1/two`));
    try {
      await Promise.all([one.firstChunk, two.firstChunk]);
      expect(one.hasCompleted()).toBe(false);
      expect(two.hasCompleted()).toBe(false);

      gates.get("/v1/one")!.resolve();
      expect(await one.completed).toEqual(expected.get("/v1/one"));
      expect(two.hasCompleted()).toBe(false);

      gates.get("/v1/two")!.resolve();
      expect(await two.completed).toEqual(expected.get("/v1/two"));
    } finally {
      gates.get("/v1/one")!.resolve();
      gates.get("/v1/two")!.resolve();
      await Promise.allSettled([one.completed, two.completed]);
      await close(downstream);
      await close(upstream);
    }
  });

  it("does not abort a started SSE response after the pre-response timeout", async () => {
    // The timeout must elapse during the post-start wait for the assertion to
    // mean anything, but response arrival must not itself be a race: loopback
    // needs single-digit ms, and CI runners (Windows especially) are far slower
    // than a local run. 500ms gives ~100x headroom while still expiring well
    // inside the wait below.
    const preResponseTimeoutMs = 500;
    const postStartWaitMs = preResponseTimeoutMs * 2 + 100;
    const gate = deferred();
    const prefix = Buffer.from("event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n\n");
    const suffix = Buffer.from("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
    const upstream = createServer(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(prefix);
      await gate.promise;
      if (!res.destroyed) res.end(suffix);
    });
    const upstreamPort = await listen(upstream);
    const app = express();
    app.use("/v1", createAnthropicProxy({
      target: `http://127.0.0.1:${upstreamPort}`,
      timeoutMs: preResponseTimeoutMs,
      on: {},
    }));
    const downstream = createServer(app);
    const downstreamPort = await listen(downstream);
    const response = startCollecting(new URL(`http://127.0.0.1:${downstreamPort}/v1/messages`));
    void response.completed.catch(() => undefined);
    try {
      await withDeadline(
        response.firstChunk,
        preResponseTimeoutMs * 4,
        "upstream response never reached the client, so the post-timeout assertion below would be vacuous",
      );
      await new Promise(resolve => setTimeout(resolve, postStartWaitMs));
      expect(response.hasCompleted()).toBe(false);
      gate.resolve();
      await expect(response.completed).resolves.toEqual(Buffer.concat([prefix, suffix]));
    } finally {
      gate.resolve();
      response.request.destroy();
      await Promise.allSettled([response.completed]);
      await close(downstream);
      await close(upstream);
    }
  });

  it("routes concurrent production-stack SSE streams with sticky leases and abort cleanup", async () => {
    const gates = new Map([
      ["/v1/one", deferred()],
      ["/v1/two", deferred()],
      ["/v1/abort", deferred()],
    ]);
    const expected = new Map<string, Buffer>();
    const authorization = new Map<string, string>();
    const upstream = createServer(async (req, res) => {
      const path = req.url ?? "";
      authorization.set(path, String(req.headers.authorization ?? ""));
      const prefix = Buffer.from(`event: ping\ndata: {"stream":"${path}"}\n\n`);
      const suffix = Buffer.from("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
      expected.set(path, Buffer.concat([prefix, suffix]));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(prefix);
      const gate = gates.get(path);
      if (gate) await gate.promise;
      if (!res.destroyed) res.end(suffix);
    });
    const upstreamPort = await listen(upstream);
    const accounts = [makeAccount("a"), makeAccount("b")];
    const pool = new TokenPool(accounts);
    const sessionRouter = new SessionRouter(pool);
    const app = express();
    app.use("/v1", createAnthropicRoutingMiddleware({ sessionRouter }));
    app.use("/v1", createAnthropicRefreshMiddleware({
      needsRefresh: () => false,
      refresh: async () => true,
      onRefreshFailure: vi.fn(),
    }));
    app.use("/v1", createAnthropicProxy({
      target: `http://127.0.0.1:${upstreamPort}`,
      timeoutMs: 10_000,
      on: {
        proxyReq: (proxyRequest, req) => {
          const account = (req as express.Request)._ccAccount!;
          proxyRequest.setHeader("authorization", `Bearer ${account.tokens.accessToken}`);
        },
      },
    }));
    const downstream = createServer(app);
    const downstreamPort = await listen(downstream);
    const base = `http://127.0.0.1:${downstreamPort}`;
    const one = startCollecting(new URL(`${base}/v1/one`), {
      "X-Claude-Code-Session-Id": "session-one",
    });
    const two = startCollecting(new URL(`${base}/v1/two`), {
      "X-Claude-Code-Session-Id": "session-two",
    });
    let aborted: ReturnType<typeof startCollecting> | undefined;

    try {
      await Promise.all([one.firstChunk, two.firstChunk]);
      const sessionOneAuthorization = authorization.get("/v1/one");
      const sessionTwoAuthorization = authorization.get("/v1/two");
      expect(sessionOneAuthorization).toMatch(/^Bearer access-[ab]$/);
      expect(sessionTwoAuthorization).toMatch(/^Bearer access-[ab]$/);
      expect(sessionOneAuthorization).not.toBe(sessionTwoAuthorization);
      const sessionOneAccountId = sessionOneAuthorization!.endsWith("-a") ? "a" : "b";
      const sessionTwoAccountId = sessionTwoAuthorization!.endsWith("-a") ? "a" : "b";
      expect(pool.getInFlight(sessionOneAccountId)).toBe(1);
      expect(pool.getInFlight(sessionTwoAccountId)).toBe(1);
      expect(sessionRouter.getActiveSessionCountsSnapshot()).toEqual(new Map([
        ["a", 1],
        ["b", 1],
      ]));

      const follow = await collect(new URL(`${base}/v1/follow`), {
        "X-Claude-Code-Session-Id": "session-one",
      });
      expect(authorization.get("/v1/follow")).toBe(sessionOneAuthorization);
      expect(follow.body).toEqual(expected.get("/v1/follow"));
      expect(follow.body.toString("utf8").match(/event: message_stop/g)).toHaveLength(1);
      expect(pool.getInFlight(sessionOneAccountId)).toBe(1);

      aborted = startCollecting(new URL(`${base}/v1/abort`), {
        "X-Claude-Code-Session-Id": "session-two",
      });
      await aborted.firstChunk;
      expect(authorization.get("/v1/abort")).toBe(sessionTwoAuthorization);
      expect(pool.getInFlight(sessionTwoAccountId)).toBe(2);
      aborted.request.destroy();
      await Promise.allSettled([aborted.completed]);
      await vi.waitFor(() => expect(pool.getInFlight(sessionTwoAccountId)).toBe(1));

      gates.get("/v1/one")!.resolve();
      gates.get("/v1/two")!.resolve();
      const [oneBody, twoBody] = await Promise.all([one.completed, two.completed]);
      expect(oneBody).toEqual(expected.get("/v1/one"));
      expect(twoBody).toEqual(expected.get("/v1/two"));
      expect(oneBody.toString("utf8").match(/event: message_stop/g)).toHaveLength(1);
      expect(twoBody.toString("utf8").match(/event: message_stop/g)).toHaveLength(1);
      expect(pool.getInFlight("a")).toBe(0);
      expect(pool.getInFlight("b")).toBe(0);
    } finally {
      for (const gate of gates.values()) gate.resolve();
      one.request.destroy();
      two.request.destroy();
      aborted?.request.destroy();
      await Promise.allSettled([
        one.completed,
        two.completed,
        ...(aborted ? [aborted.completed] : []),
      ]);
      await close(downstream);
      await close(upstream);
    }
  });

  it("relays a failed response unchanged and mutates only the next-request routing state", async () => {
    const failureBody = Buffer.from("{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}\n");
    let upstreamRequests = 0;
    const upstream = createServer((_req, res) => {
      upstreamRequests++;
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "invalid",
      });
      res.write(failureBody.subarray(0, 11));
      res.end(failureBody.subarray(11));
    });
    const upstreamPort = await listen(upstream);
    const invalidate = vi.fn();
    const setCooldownForAccount = vi.fn();
    const route = {
      account: makeAccount("account-a"),
      sessionId: "session-a",
      bindingGeneration: 1,
    };

    const app = express();
    app.use("/v1", createAnthropicProxy({
      target: `http://127.0.0.1:${upstreamPort}`,
      timeoutMs: 2_000,
      on: {
        proxyRes: proxyResponse => {
          applyUpstreamFailureRouting(
            proxyResponse.statusCode ?? 0,
            proxyResponse.headers["retry-after"],
            route,
            { invalidate },
            { setCooldownForAccount },
          );
        },
      },
    }));
    const downstream = createServer(app);
    const downstreamPort = await listen(downstream);

    try {
      const response = await collect(new URL(`http://127.0.0.1:${downstreamPort}/v1/messages`));

      expect(response.status).toBe(429);
      expect(response.body).toEqual(failureBody);
      expect(upstreamRequests).toBe(1);
      expect(invalidate).toHaveBeenCalledWith("session-a", "account-a", 1);
      expect(setCooldownForAccount).toHaveBeenCalledWith(route.account, 60_000);
      expect(response.body.toString("utf8")).not.toContain("message_stop");
    } finally {
      await close(downstream);
      await close(upstream);
    }
  });
});
