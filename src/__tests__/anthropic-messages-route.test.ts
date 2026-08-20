import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import { mountAnthropicMessagesRoute } from "../proxy/anthropic-messages-route.js";
import type { AnthropicMessagesRouteOptions } from "../proxy/anthropic-messages-route.js";
import { SessionRouter } from "../proxy/session-router.js";
import { TokenPool } from "../proxy/token-pool.js";
import type { Account } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";
import type { LogEntry } from "../proxy/stats.js";

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

interface UpstreamCall {
  authorization: string;
  beta: string;
  apiKey: string | undefined;
  host: string | undefined;
  url: string;
  body: string;
}

/** Record every upstream request, answering via the provided script per call index. */
function scriptedUpstream(
  respond: (call: number, req: IncomingMessage, res: import("node:http").ServerResponse) => void,
): { server: Server; calls: UpstreamCall[] } {
  const calls: UpstreamCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      calls.push({
        authorization: String(req.headers.authorization ?? ""),
        beta: String(req.headers["anthropic-beta"] ?? ""),
        apiKey: req.headers["x-api-key"] as string | undefined,
        host: req.headers.host,
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      respond(calls.length, req, res);
    });
  });
  return { server, calls };
}

function mountRoute(
  accounts: Account[],
  upstreamPort: number,
  extra: Partial<AnthropicMessagesRouteOptions> = {},
) {
  const pool = new TokenPool(accounts);
  const sessionRouter = new SessionRouter(pool);
  const activity: LogEntry[] = [];
  const app = express();
  // Stand-in for the cross-provider dispatch that owns body parsing in
  // production: it buffers the raw body and hands Anthropic-bound requests on.
  app.post(
    "/v1/messages",
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        (req as Request)._ccRawBody = Buffer.from(buf);
      },
    }),
    (req, _res, next) => {
      req._ccRouteContext = { requestedModel: "claude-sonnet-5", modelFamily: "sonnet" };
      next();
    },
  );
  mountAnthropicMessagesRoute(app, {
    target: `http://127.0.0.1:${upstreamPort}`,
    timeoutMs: 2_000,
    pool,
    sessionRouter,
    needsRefresh: () => false,
    refresh: async () => true,
    onRefreshFailure: vi.fn(),
    recordActivity: entry => activity.push(entry),
    sameAccountRetryDelayMs: 5,
    ...extra,
  });
  return { app, pool, sessionRouter, activity };
}

async function withApp(
  app: ReturnType<typeof express>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(app);
  const port = await listen(server);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await close(server);
  }
}

function postMessages(
  baseUrl: string,
  headers: Record<string, string> = {},
  path = "/v1/messages",
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
  });
}

describe("mountAnthropicMessagesRoute", () => {
  it("fails a 429 over to a different account within one request and rebinds the session", async () => {
    const sseBody = "event: message_start\ndata: {\"type\":\"message_start\"}\n\n" +
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
    const { server, calls } = scriptedUpstream((call, _req, res) => {
      if (call === 1) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        res.end("{\"type\":\"error\"}");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sseBody);
    });
    const upstreamPort = await listen(server);
    const accounts = [makeAccount("a"), makeAccount("b")];
    const { app, pool, activity } = mountRoute(accounts, upstreamPort);

    try {
      await withApp(app, async baseUrl => {
        const response = await postMessages(baseUrl, { "x-claude-code-session-id": "session-1" });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(sseBody);

        expect(calls).toHaveLength(2);
        expect(calls[1]!.authorization).not.toBe(calls[0]!.authorization);
        const failedId = calls[0]!.authorization.endsWith("-a") ? "a" : "b";
        expect(pool.isEligible(failedId, { modelFamily: "sonnet" })).toBe(false);

        // The session sticks to the account that actually served it.
        const followUp = await postMessages(baseUrl, { "x-claude-code-session-id": "session-1" });
        expect(followUp.status).toBe(200);
        await followUp.text();
        expect(calls).toHaveLength(3);
        expect(calls[2]!.authorization).toBe(calls[1]!.authorization);
      });
    } finally {
      await close(server);
    }

    expect(activity).toHaveLength(3);
    expect(activity[0]).toEqual(expect.objectContaining({
      type: "error",
      statusCode: 429,
      details: expect.stringContaining(":will-retry"),
    }));
    expect(activity[1]).toEqual(expect.objectContaining({ type: "route", statusCode: 200 }));
  });

  it("retries a 500 on the same account after the delay and succeeds", async () => {
    const { server, calls } = scriptedUpstream((call, _req, res) => {
      if (call === 1) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end("{\"type\":\"error\"}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{\"id\":\"msg_1\"}");
    });
    const upstreamPort = await listen(server);
    const { app, activity } = mountRoute([makeAccount("solo")], upstreamPort);

    try {
      await withApp(app, async baseUrl => {
        const response = await postMessages(baseUrl);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("{\"id\":\"msg_1\"}");
      });
    } finally {
      await close(server);
    }

    expect(calls).toHaveLength(2);
    expect(calls[1]!.authorization).toBe(calls[0]!.authorization);
    expect(activity[0]).toEqual(expect.objectContaining({
      type: "error",
      statusCode: 500,
      details: expect.stringContaining(":will-retry"),
    }));
    expect(activity[1]).toEqual(expect.objectContaining({ type: "route", statusCode: 200 }));
  });

  it("passes a 429 through byte-for-byte when no other account is eligible", async () => {
    const failureBody = Buffer.from("{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}\n");
    const { server, calls } = scriptedUpstream((_call, _req, res) => {
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "60",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "x-upstream-marker": "preserved-verbatim",
      });
      res.write(failureBody.subarray(0, 11));
      res.end(failureBody.subarray(11));
    });
    const upstreamPort = await listen(server);
    const { app, activity } = mountRoute([makeAccount("solo")], upstreamPort);

    try {
      await withApp(app, async baseUrl => {
        const response = await postMessages(baseUrl, { "x-claude-code-session-id": "session-1" });
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("60");
        expect(response.headers.get("x-upstream-marker")).toBe("preserved-verbatim");
        expect(response.headers.get("anthropic-ratelimit-unified-representative-claim")).toBe("five_hour");
        expect(Buffer.from(await response.arrayBuffer())).toEqual(failureBody);
      });
    } finally {
      await close(server);
    }

    // The 429 cooldown leaves nothing to fail over to, so exactly one
    // upstream request happens and its response is relayed unchanged.
    expect(calls).toHaveLength(1);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.details).not.toContain(":will-retry");
    expect(activity[0]).toEqual(expect.objectContaining({ type: "error", statusCode: 429 }));
  });

  it("stops after the attempt budget and relays the final 500 unchanged", async () => {
    const { server, calls } = scriptedUpstream((_call, _req, res) => {
      res.writeHead(500, { "content-type": "application/json", "x-attempt-marker": "final" });
      res.end("{\"type\":\"error\",\"error\":{\"type\":\"api_error\"}}");
    });
    const upstreamPort = await listen(server);
    const { app, activity } = mountRoute([makeAccount("solo")], upstreamPort);

    try {
      await withApp(app, async baseUrl => {
        const response = await postMessages(baseUrl);
        expect(response.status).toBe(500);
        expect(response.headers.get("x-attempt-marker")).toBe("final");
        expect(await response.json()).toEqual({ type: "error", error: { type: "api_error" } });
      });
    } finally {
      await close(server);
    }

    expect(calls).toHaveLength(3);
    expect(activity).toHaveLength(3);
    expect(activity[0]!.details).toContain(":will-retry");
    expect(activity[1]!.details).toContain(":will-retry");
    expect(activity[2]!.details).not.toContain(":will-retry");
  });

  it("forwards auth, oauth beta, host, and query string; keeps SSE byte-transparent", async () => {
    const chunks = [
      Buffer.from("event: message_start\nda"),
      Buffer.from("ta: {\"type\":\"message_start\"}\n\n"),
      Buffer.from("event: content_block_delta\ndata: {\"delta\":{\"text\":\"hello\"}}\n\n"),
      Buffer.from("event: message_"),
      Buffer.from("stop\ndata: {\"type\":\"message_stop\"}\n\n"),
    ];
    const upstreamBody = Buffer.concat(chunks);
    const { server, calls } = scriptedUpstream((_call, _req, res) => {
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
    const upstreamPort = await listen(server);
    const { app } = mountRoute([makeAccount("solo")], upstreamPort);

    try {
      await withApp(app, async baseUrl => {
        const response = await fetch(`${baseUrl}/v1/messages?beta=true`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-beta": "context-1m-2025-08-07",
            "x-api-key": "should-be-stripped",
          },
          body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(Buffer.from(await response.arrayBuffer())).toEqual(upstreamBody);
      });
    } finally {
      await close(server);
    }

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("/v1/messages?beta=true");
    expect(call.authorization).toBe("Bearer access-solo");
    expect(call.beta.split(",")).toEqual(expect.arrayContaining(["context-1m-2025-08-07", "oauth-2025-04-20"]));
    expect(call.apiKey).toBeUndefined();
    expect(call.host).toContain("127.0.0.1");
    expect(call.body).toBe(JSON.stringify({ model: "claude-sonnet-5", messages: [] }));
  });

  it("relays the original failure when the failover account's token refresh fails", async () => {
    const { server, calls } = scriptedUpstream((_call, _req, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      res.end("{\"type\":\"error\"}");
    });
    const upstreamPort = await listen(server);
    const onRefreshFailure = vi.fn();
    const refresh = vi.fn(async () => refresh.mock.calls.length === 1);
    const { app } = mountRoute([makeAccount("a"), makeAccount("b")], upstreamPort, {
      needsRefresh: () => true,
      refresh,
      onRefreshFailure,
    });

    try {
      await withApp(app, async baseUrl => {
        const response = await postMessages(baseUrl, { "x-claude-code-session-id": "session-1" });
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("60");
      });
    } finally {
      await close(server);
    }

    // First refresh serves the initial account; the failover account's refresh
    // fails, so the held 429 is relayed and no second upstream request happens.
    expect(calls).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onRefreshFailure).toHaveBeenCalledTimes(1);
  });

  it("does not forward a retry for a client that disconnected during the delay", async () => {
    const { server, calls } = scriptedUpstream((_call, _req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{\"type\":\"error\"}");
    });
    const upstreamPort = await listen(server);
    const { app } = mountRoute([makeAccount("solo")], upstreamPort, {
      sameAccountRetryDelayMs: 200,
    });

    try {
      await withApp(app, async baseUrl => {
        const controller = new AbortController();
        const pending = fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
          signal: controller.signal,
        }).then(() => undefined, () => undefined);
        // Give the first upstream attempt time to fail, then hang up while the
        // route is waiting out the same-account delay.
        await vi.waitFor(() => expect(calls.length).toBe(1));
        controller.abort();
        await pending;
        // Wait well past the retry delay: the disconnect must have cancelled
        // the retry, so no second upstream request may appear.
        await new Promise(resolve => setTimeout(resolve, 400));
        expect(calls).toHaveLength(1);
      });
    } finally {
      await close(server);
    }
  });

  it("falls through to the next route when no raw body was buffered", async () => {
    const { server, calls } = scriptedUpstream((_call, _req, res) => {
      res.writeHead(200).end("unexpected");
    });
    const upstreamPort = await listen(server);
    const { app } = mountRoute([makeAccount("solo")], upstreamPort);

    try {
      await withApp(app, async baseUrl => {
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "not json",
        });
        // No fallback route exists in this test app, so Express 404s — the
        // point is that the retry route neither crashed nor forwarded.
        expect(response.status).toBe(404);
      });
    } finally {
      await close(server);
    }

    expect(calls).toHaveLength(0);
  });
});
