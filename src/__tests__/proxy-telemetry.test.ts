import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Request } from "express";
import { context, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetrySnapshot } from "../config/telemetry.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";
import { createOpenAIAccount, type OpenAIAccount } from "../providers/openai/account-state.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { gzipSync } from "node:zlib";
import { mountAnthropicMessagesRoute } from "../proxy/anthropic-messages-route.js";
import { mountResponsesRoutes } from "../proxy/responses-server.js";
import { SessionRouter } from "../proxy/session-router.js";
import type { LogEntry } from "../proxy/stats.js";
import { TokenPool } from "../proxy/token-pool.js";
import { DEFAULT_RATE_LIMITS, type Account } from "../proxy/types.js";

const INSTALL_ID = "123e4567-e89b-42d3-a456-426614174000";
const CONSENT_GENERATION = "123e4567-e89b-42d3-a456-426614174010";

/** Account ids and upstream error text that must never reach a span or log. */
const SECRET = {
  anthropicAccount: "telemetry-secret-anthropic-account",
  openAIAccount: "telemetry-secret-openai-account",
  openAIFailover: "telemetry-secret-openai-failover",
  networkMessage: "connect ECONNREFUSED telemetry-secret-upstream-host:443",
} as const;

const snapshot: TelemetrySnapshot = {
  state: {
    enabled: true,
    installId: INSTALL_ID,
    firstRunAt: "2026-08-01T00:00:00.000Z",
    consentGeneration: CONSENT_GENERATION,
  },
  environmentDisabled: false,
  enabled: true,
};

vi.mock("../config/telemetry.js", async importOriginal => ({
  ...await importOriginal<typeof import("../config/telemetry.js")>(),
  getTelemetrySnapshot: () => snapshot,
  claimTelemetryFirstStart: () => undefined,
}));

// The proxy must reach the tracer/logger providers this file installs, never a
// real OTLP or PostHog transport.
vi.mock("../telemetry/runtime.js", () => ({
  startTelemetryRuntime: () => true,
  isTelemetryRuntimeActive: () => true,
  flushTelemetryRuntimeWithin: async () => undefined,
  shutdownTelemetryRuntimeWithin: async () => undefined,
  noopPropagator: { inject: () => undefined, extract: (value: unknown) => value, fields: () => [] },
}));

const { telemetryRequestMiddleware } = await import("../telemetry/facade.js");

const spanExporter = new InMemorySpanExporter();
const logExporter = new InMemoryLogRecordExporter();

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
}

function spansNamed(name: string): RecordedSpan[] {
  return spanExporter.getFinishedSpans()
    .filter(span => span.name === name)
    .map(span => ({ name: span.name, attributes: { ...span.attributes } }));
}

function recordedLogs() {
  return logExporter.getFinishedLogRecords().map(record =>
    ({ body: record.body, severityText: record.severityText, attributes: { ...record.attributes } }));
}

/** Everything telemetry produced, in the shape a leak would take on the wire. */
function telemetryText(): string {
  return JSON.stringify([spanExporter.getFinishedSpans().map(span =>
    ({ name: span.name, attributes: span.attributes })), recordedLogs()]);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
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

function anthropicAccount(id: string): Account {
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

function openAIAccount(id: string): OpenAIAccount {
  return createOpenAIAccount({
    id,
    provider: "openai_subscription",
    accessToken: "header.e30.sig",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
    enabled: true,
  });
}

type ForwardOpenAI = (opts: {
  account: OpenAIAccount;
  body: OpenAIResponsesRequest;
  stream: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<Response>;

function mountOpenAI(accounts: OpenAIAccount[], forwardOpenAI: ForwardOpenAI) {
  const app = express();
  app.use(telemetryRequestMiddleware());
  const openAIPool = new OpenAITokenPool(accounts);
  const activity: LogEntry[] = [];
  mountResponsesRoutes(app, {
    openAIRouter: new SessionRouter<OpenAIAccount>(openAIPool),
    openAIPool,
    forwardOpenAI,
    recordActivity: entry => activity.push(entry),
    sameAccountRetryDelayMs: 1,
  });
  return { app, activity };
}

function postResponses(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", session_id: "codex-session-1" },
    body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
  });
}

async function withApp(
  app: ReturnType<typeof express>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(app);
  const port = await listen(server);
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await close(server);
  }
}

beforeEach(() => {
  // An explicit resource keeps span and log export synchronous in tests.
  const resource = resourceFromAttributes({ "service.name": "cc-router" });
  new NodeTracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor(spanExporter)] })
    .register();
  logs.setGlobalLoggerProvider(new LoggerProvider({
    resource,
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  }));
});

afterEach(() => {
  spanExporter.reset();
  logExporter.reset();
  for (const api of [trace, context, propagation, logs]) api.disable();
});

describe("proxy telemetry", () => {
  it("spans every OpenAI upstream attempt without exporting account identity", async () => {
    const seen: string[] = [];
    const forward: ForwardOpenAI = async ({ account }) => {
      seen.push(account.id);
      return seen.length === 1
        ? new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
        : new Response(JSON.stringify({ id: "resp_ok", output: [], usage: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
    };
    const { app } = mountOpenAI(
      [openAIAccount(SECRET.openAIAccount), openAIAccount(SECRET.openAIFailover)],
      forward,
    );

    await withApp(app, async baseUrl => {
      expect((await postResponses(baseUrl)).status).toBe(200);
    });
    await waitFor(() => spansNamed("provider.inference").length >= 2);

    const attempts = spansNamed("provider.inference");
    expect(attempts).toHaveLength(2);
    expect(attempts.map(span => span.attributes["cc_router.attempt"])).toEqual([1, 2]);
    expect(attempts[0]?.attributes).toMatchObject({
      "cc_router.operation": "provider.inference",
      "cc_router.provider": "openai",
      "cc_router.route": "responses",
      "cc_router.outcome": "upstream_error",
      "http.response.status_code": 503,
    });
    expect(attempts[1]?.attributes).toMatchObject({
      "cc_router.outcome": "complete",
      "http.response.status_code": 200,
    });
    expect(spansNamed("proxy.request")[0]?.attributes).toMatchObject({
      "cc_router.provider": "openai",
      "cc_router.request_source": "other",
      "cc_router.account_pool_size": 2,
      "http.response.status_code": 200,
    });
    expect(seen).toHaveLength(2);
    expect(telemetryText()).not.toContain(SECRET.openAIAccount);
    expect(telemetryText()).not.toContain(SECRET.openAIFailover);
  });

  it("records a closed runtime failure for a thrown forward, never its message", async () => {
    const forward: ForwardOpenAI = async () => {
      throw Object.assign(new Error(SECRET.networkMessage), { code: "ECONNREFUSED" });
    };
    const { app } = mountOpenAI([openAIAccount(SECRET.openAIAccount)], forward);

    await withApp(app, async baseUrl => {
      expect((await postResponses(baseUrl)).status).toBe(502);
    });
    await waitFor(() => recordedLogs().length >= 1);

    const failures = recordedLogs().filter(record => record.body === "runtime.failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severityText).toBe("ERROR");
    expect(failures[0]?.attributes).toMatchObject({
      "cc_router.operation": "provider.inference",
      "cc_router.provider": "openai",
      "cc_router.reason": "network_failure",
      "cc_router.attempt": 1,
    });
    expect(telemetryText()).not.toContain(SECRET.networkMessage);
    expect(telemetryText()).not.toContain("ECONNREFUSED");
    expect(telemetryText()).not.toContain(SECRET.openAIAccount);
  });

  it("spans every Anthropic upstream attempt without exporting account identity", async () => {
    let call = 0;
    const upstream = createServer((_req: IncomingMessage, res: ServerResponse) => {
      call += 1;
      if (call === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", usage: { input_tokens: 7, output_tokens: 3 } }));
    });
    const upstreamPort = await listen(upstream);

    const pool = new TokenPool([
      anthropicAccount(SECRET.anthropicAccount),
      anthropicAccount(`${SECRET.anthropicAccount}-b`),
    ]);
    const app = express();
    app.use(telemetryRequestMiddleware());
    app.post(
      "/v1/messages",
      express.json({
        limit: "10mb",
        verify: (req, _res, buf) => { (req as Request)._ccRawBody = Buffer.from(buf); },
      }),
      (req, _res, next) => {
        req._ccRouteContext = { requestedModel: "claude-sonnet-5", modelFamily: "sonnet" };
        next();
      },
    );
    mountAnthropicMessagesRoute(app, {
      target: `http://127.0.0.1:${upstreamPort}`,
      timeoutMs: 5_000,
      pool,
      sessionRouter: new SessionRouter(pool),
      needsRefresh: () => false,
      refresh: async () => true,
      onRefreshFailure: () => undefined,
      recordActivity: () => undefined,
      sameAccountRetryDelayMs: 1,
    });

    try {
      await withApp(app, async baseUrl => {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-5", messages: [], stream: false }),
        });
        expect(res.status).toBe(200);
        await res.text();
      });
    } finally {
      await close(upstream);
    }
    await waitFor(() => spansNamed("provider.inference").length >= 2);

    const attempts = spansNamed("provider.inference");
    expect(attempts).toHaveLength(2);
    expect(attempts.map(span => span.attributes["cc_router.attempt"])).toEqual([1, 2]);
    expect(attempts[0]?.attributes).toMatchObject({
      "cc_router.provider": "anthropic",
      "cc_router.route": "messages",
      "cc_router.model_family": "sonnet",
      "cc_router.outcome": "upstream_error",
      "http.response.status_code": 503,
    });
    expect(attempts[1]?.attributes).toMatchObject({
      "cc_router.outcome": "complete",
      "http.response.status_code": 200,
    });
    expect(spansNamed("proxy.request")[0]?.attributes).toMatchObject({
      "cc_router.provider": "anthropic",
      "cc_router.route": "messages",
      "cc_router.request_source": "api",
      "cc_router.account_pool_size": 2,
    });
    expect(call).toBe(2);
    expect(telemetryText()).not.toContain(SECRET.anthropicAccount);
  });

  function mountAnthropic(upstreamPort: number) {
    const pool = new TokenPool([anthropicAccount(SECRET.anthropicAccount)]);
    const app = express();
    app.use(telemetryRequestMiddleware());
    app.post(
      "/v1/messages",
      express.json({
        limit: "10mb",
        verify: (req, _res, buf) => { (req as Request)._ccRawBody = Buffer.from(buf); },
      }),
      (req, _res, next) => {
        req._ccRouteContext = { requestedModel: "claude-sonnet-5", modelFamily: "sonnet" };
        next();
      },
    );
    mountAnthropicMessagesRoute(app, {
      target: `http://127.0.0.1:${upstreamPort}`,
      timeoutMs: 5_000,
      pool,
      sessionRouter: new SessionRouter(pool),
      needsRefresh: () => false,
      refresh: async () => true,
      onRefreshFailure: () => undefined,
      recordActivity: () => undefined,
      sameAccountRetryDelayMs: 1,
    });
    return app;
  }

  async function postMessages(app: express.Express, stream: boolean): Promise<void> {
    await withApp(app, async baseUrl => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", messages: [], stream }),
      });
      expect(res.status).toBe(200);
      await res.text();
    });
  }

  it("waits for a compressed body's usage before ending the Anthropic provider span", async () => {
    const upstream = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(JSON.stringify({ type: "message", usage: { input_tokens: 7, output_tokens: 3 } })));
    });
    const upstreamPort = await listen(upstream);
    try {
      await postMessages(mountAnthropic(upstreamPort), false);
    } finally {
      await close(upstream);
    }
    await waitFor(() => spansNamed("provider.inference").length >= 1);

    expect(spansNamed("provider.inference")[0]?.attributes).toMatchObject({
      "cc_router.outcome": "complete",
      "cc_router.stream_outcome": "complete",
      "cc_router.input_tokens": 7,
      "cc_router.output_tokens": 3,
    });
  });

  it("classifies an SSE stream that ends without message_stop as an upstream failure", async () => {
    const upstream = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 4 } } })}\n\n`);
      res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error" } })}\n\n`);
      res.end();
    });
    const upstreamPort = await listen(upstream);
    try {
      await postMessages(mountAnthropic(upstreamPort), true);
    } finally {
      await close(upstream);
    }
    await waitFor(() => spansNamed("provider.inference").length >= 1);

    expect(spansNamed("provider.inference")[0]?.attributes).toMatchObject({
      "http.response.status_code": 200,
      "cc_router.outcome": "upstream_error",
      "cc_router.stream_outcome": "upstream_error",
    });
  });
});
