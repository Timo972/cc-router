import { createServer, request, type ClientRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import {
  createAnthropicRefreshMiddleware,
  createAnthropicRoutingMiddleware,
} from "../proxy/anthropic-routing.js";
import { SessionRouter } from "../proxy/session-router.js";
import { TokenPool } from "../proxy/token-pool.js";
import {
  needsRefresh,
  refreshAccountIfCurrent,
} from "../proxy/token-refresher.js";
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function successfulRefreshResponse(): Response {
  return {
    ok: true,
    json: async () => ({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 28800,
      scope: "user:inference",
      token_type: "Bearer",
    }),
  } as Response;
}

function send(options: Parameters<typeof request>[0]): Promise<{
  status: number;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request(options, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("production Anthropic routing middleware", () => {
  it("passes the Messages model context into Anthropic session acquisition", async () => {
    const pool = new TokenPool([makeAccount("a")]);
    const sessionRouter = new SessionRouter(pool);
    const acquire = vi.spyOn(sessionRouter, "acquire");
    const context = {
      requestedModel: "claude-opus-4-1",
      modelFamily: "opus",
    };
    const app = express();
    app.use((req, _res, next) => {
      req._ccRouteContext = context;
      next();
    });
    app.use(createAnthropicRoutingMiddleware({ sessionRouter }));
    app.use((req, res) => res.json({ modelFamily: req._ccRoute?.modelFamily }));
    const server = createServer(app);
    const port = await listen(server);

    try {
      const response = await send({
        host: "127.0.0.1",
        port,
        path: "/v1/messages",
        headers: { "X-Claude-Code-Session-Id": "session-a" },
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ modelFamily: "opus" });
      expect(acquire).toHaveBeenCalledWith("session-a", context);
    } finally {
      await close(server);
    }
  });

  it("rejects duplicate native HTTP session fields as unscoped", async () => {
    const pool = new TokenPool([makeAccount("a")]);
    const sessionRouter = new SessionRouter(pool);
    let observedHeaderFields = 0;
    const app = express();
    app.use(createAnthropicRoutingMiddleware({ sessionRouter }));
    app.use((req, res) => {
      observedHeaderFields = req.rawHeaders.filter(
        value => value.toLowerCase() === "x-claude-code-session-id",
      ).length;
      res.json({ reason: req._ccRoute?.reason });
    });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const response = await send({
        host: "127.0.0.1",
        port,
        path: "/v1/messages",
        headers: {
          "X-Claude-Code-Session-Id": ["session-a", "session-b"],
        },
      });

      expect(response.status).toBe(200);
      expect(observedHeaderFields).toBe(2);
      expect(JSON.parse(response.body)).toEqual({ reason: "unscoped" });
      expect(sessionRouter.getBindingCount()).toBe(0);
    } finally {
      await close(server);
    }
  });

  it("does not continue after the client disconnects during deferred refresh", async () => {
    const pool = new TokenPool([makeAccount("a")]);
    const sessionRouter = new SessionRouter(pool);
    const refreshStarted = deferred<void>();
    const refreshResult = deferred<boolean>();
    const forwarded = vi.fn();
    const app = express();
    app.use(createAnthropicRoutingMiddleware({ sessionRouter }));
    app.use(createAnthropicRefreshMiddleware({
      needsRefresh: () => true,
      refresh: async () => {
        refreshStarted.resolve();
        return refreshResult.promise;
      },
      onRefreshFailure: vi.fn(),
    }));
    app.use((_req, res) => {
      forwarded();
      res.end("forwarded");
    });
    const server = createServer(app);
    const port = await listen(server);
    let client: ClientRequest | undefined;

    try {
      const clientClosed = new Promise<void>(resolve => {
        client = request({
          host: "127.0.0.1",
          port,
          path: "/v1/messages",
          headers: { "X-Claude-Code-Session-Id": "session-a" },
        });
        client.on("error", () => resolve());
        client.end();
      });

      await refreshStarted.promise;
      expect(pool.getInFlight("a")).toBe(1);
      client.destroy();
      await clientClosed;
      await vi.waitFor(() => expect(pool.getInFlight("a")).toBe(0));

      refreshResult.resolve(true);
      await new Promise(resolve => setImmediate(resolve));

      expect(forwarded).not.toHaveBeenCalled();
      expect(pool.getInFlight("a")).toBe(0);
    } finally {
      refreshResult.resolve(true);
      client?.destroy();
      await close(server);
    }
  });

  it("joins an active forced refresh before forwarding a far-future token retry", async () => {
    const account = makeAccount("a");
    account.tokens.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
    const pool = new TokenPool([account]);
    const sessionRouter = new SessionRouter(pool);
    const refreshResponse = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => refreshResponse.promise));
    let persisted = false;
    const persist = vi.fn(() => { persisted = true; });
    const forcedRefresh = refreshAccountIfCurrent(account, pool, { persist });
    const preparationCheck = deferred<boolean>();
    let joinedRefresh: Promise<boolean> | undefined;
    let tokenAtForward = "";
    let persistedAtForward = false;
    const forwarded = vi.fn();

    const app = express();
    app.use(createAnthropicRoutingMiddleware({ sessionRouter }));
    app.use(createAnthropicRefreshMiddleware({
      needsRefresh: selected => {
        const required = needsRefresh(selected);
        preparationCheck.resolve(required);
        return required;
      },
      refresh: selected => {
        joinedRefresh = refreshAccountIfCurrent(selected, pool, { persist });
        return joinedRefresh;
      },
      onRefreshFailure: vi.fn(),
    }));
    app.use((_req, res) => {
      forwarded();
      tokenAtForward = account.tokens.accessToken;
      persistedAtForward = persisted;
      res.end("forwarded");
    });
    const server = createServer(app);
    const port = await listen(server);
    const retry = send({
      host: "127.0.0.1",
      port,
      path: "/v1/messages",
      headers: { "X-Claude-Code-Session-Id": "session-a" },
    });

    try {
      const preparationNeeded = await preparationCheck.promise;
      await new Promise(resolve => setImmediate(resolve));

      expect(preparationNeeded).toBe(true);
      expect(forwarded).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);

      refreshResponse.resolve(successfulRefreshResponse());
      expect(await forcedRefresh).toBe(true);
      expect((await retry).status).toBe(200);

      expect(joinedRefresh).toBe(forcedRefresh);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(tokenAtForward).toBe("rotated-access");
      expect(persistedAtForward).toBe(true);
    } finally {
      refreshResponse.resolve(successfulRefreshResponse());
      await Promise.allSettled([forcedRefresh, retry]);
      vi.unstubAllGlobals();
      await close(server);
    }
  });
});
