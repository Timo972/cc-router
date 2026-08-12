import { context, ROOT_CONTEXT, SpanKind, TraceFlags, trace } from "@opentelemetry/api";
import { SamplingDecision } from "@opentelemetry/sdk-trace-base";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  startTransportCaptureServer,
  TELEMETRY_CANARY,
  type TransportCaptureServer,
} from "./telemetry-test-helpers.js";

const INSTALL_ID = "123e4567-e89b-42d3-a456-426614174000";
const SAMPLED_TRACE_ID = "0123456789abcdef0123456789abcdef";
const MALICIOUS_TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SAMPLED_BELOW_THRESHOLD = "00000000000000000000000019999998";
const UNSAMPLED_AT_THRESHOLD = "00000000000000000000000019999999";

function responseFor(url: URL): Response {
  if (url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/responses") {
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.hostname === "auth.openai.com" && url.pathname === "/oauth/token") {
    return new Response("", { status: 429 });
  }
  if (url.hostname === "claude.ai" && url.pathname === "/v1/oauth/token") {
    return new Response("provider-private-body", { status: 403 });
  }
  throw new Error(`telemetry runtime test blocked external request to ${url.hostname}`);
}

function wireFor(capture: TransportCaptureServer, path: string, from = 0): Buffer {
  return Buffer.concat(
    capture.requests
      .slice(from)
      .filter(request => request.url === path)
      .map(request => request.rawBody),
  );
}

function wireContainsTraceId(wire: Buffer, traceId: string): boolean {
  return wire.includes(Buffer.from(traceId, "hex")) || wire.toString("utf8").includes(traceId);
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

async function waitForRequest(
  capture: TransportCaptureServer,
  path: string,
  from: number,
): Promise<void> {
  await vi.waitFor(() => {
    expect(capture.requests.slice(from).some(request => request.url === path)).toBe(true);
  }, { timeout: 2_000 });
}

describe("proxy runtime sampling and propagation", () => {
  let capture: TransportCaptureServer;
  let testHome: string;
  let telemetryPath: string;
  let originalFetch: typeof globalThis.fetch;
  const posthogBodies: string[] = [];
  let returnMalformedOpenAIRefresh = false;
  let returnInvalidOpenAIRefresh = false;
  let codexStatus = 200;
  let codexUnexpected = false;
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    capture = await startTransportCaptureServer();
    testHome = mkdtempSync(join(tmpdir(), "cc-router-telemetry-runtime-"));
    telemetryPath = join(testHome, "telemetry.json");
    writeFileSync(telemetryPath, JSON.stringify({
      enabled: true,
      installId: INSTALL_ID,
      firstRunAt: "2026-08-01T00:00:00.000Z",
    }));

    for (const key of [
      "NODE_ENV",
      "TELEMETRY_PATH",
      "CC_ROUTER_TEST_OTLP_TRACE_URL",
      "CC_ROUTER_TEST_OTLP_LOG_URL",
      "CC_ROUTER_TEST_TRACE_ID",
    ]) {
      originalEnv[key] = process.env[key];
    }
    process.env["NODE_ENV"] = "test";
    process.env["TELEMETRY_PATH"] = telemetryPath;
    process.env["CC_ROUTER_TEST_OTLP_TRACE_URL"] = capture.endpoint("/i/v1/traces");
    process.env["CC_ROUTER_TEST_OTLP_LOG_URL"] = capture.endpoint("/i/v1/logs");
    process.env["CC_ROUTER_TEST_TRACE_ID"] = SAMPLED_TRACE_ID;

    originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname === "127.0.0.1" || url.hostname === "::1") {
        return originalFetch(input, init);
      }
      if (url.hostname === "eu.i.posthog.com") {
        const body = init?.body;
        posthogBodies.push(typeof body === "string" ? body : String(body ?? ""));
        return new Response("{}", { status: 200 });
      }
      if (returnMalformedOpenAIRefresh
        && url.hostname === "auth.openai.com"
        && url.pathname === "/oauth/token") {
        return new Response("PRIVATE_MALFORMED_REFRESH_BODY", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (returnInvalidOpenAIRefresh
        && url.hostname === "auth.openai.com"
        && url.pathname === "/oauth/token") {
        return new Response(JSON.stringify({ private: TELEMETRY_CANARY.prompt }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/responses") {
        if (codexUnexpected) throw new TypeError("PRIVATE_CODEX_FAILURE");
        return new Response("private codex response", {
          status: codexStatus,
          headers: { "content-type": "text/plain" },
        });
      }
      return responseFor(url);
    });
    vi.resetModules();
    const runtime = await import("../telemetry/runtime.js");
    expect(runtime.startProxyTelemetry("foreground")).toBe(true);
  });

  afterAll(async () => {
    try {
      const runtime = await import("../telemetry/runtime.js");
      await runtime.shutdownProxyTelemetryWithin(200);
    } catch {
      // A RED run may fail before the runtime can be initialized.
    }
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await capture.close();
    rmSync(testHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it("samples exact 10% trace-id boundaries and inherits local parent decisions", async () => {
    const { createProxyTraceSampler } = await import("../telemetry/runtime.js");
    const sampler = createProxyTraceSampler();
    const rootDecision = (traceId: string) => sampler.shouldSample(
      ROOT_CONTEXT,
      traceId,
      "generated name is irrelevant",
      SpanKind.SERVER,
      {},
      [],
    ).decision;

    expect(rootDecision(SAMPLED_BELOW_THRESHOLD)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(rootDecision(UNSAMPLED_AT_THRESHOLD)).toBe(SamplingDecision.NOT_RECORD);

    const sampledParent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: SAMPLED_TRACE_ID,
      spanId: "1111111111111111",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    });
    const unsampledParent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: SAMPLED_TRACE_ID,
      spanId: "2222222222222222",
      traceFlags: TraceFlags.NONE,
      isRemote: false,
    });
    expect(sampler.shouldSample(
      sampledParent,
      UNSAMPLED_AT_THRESHOLD,
      "child",
      SpanKind.CLIENT,
      {},
      [],
    ).decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(sampler.shouldSample(
      unsampledParent,
      SAMPLED_BELOW_THRESHOLD,
      "child",
      SpanKind.CLIENT,
      {},
      [],
    ).decision).toBe(SamplingDecision.NOT_RECORD);
  });

  it("keeps the network propagator inert for hostile carriers", async () => {
    const { proxyNetworkPropagator } = await import("../telemetry/runtime.js");
    const trusted = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: SAMPLED_TRACE_ID,
      spanId: "3333333333333333",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    });
    const hostile = {
      traceparent: `00-${MALICIOUS_TRACE_ID}-bbbbbbbbbbbbbbbb-01`,
      tracestate: "private=value",
      baggage: "private=value",
    };
    const extracted = proxyNetworkPropagator.extract(trusted, hostile, {
      keys: carrier => Object.keys(carrier),
      get: (carrier, key) => carrier[key as keyof typeof carrier],
    });
    const injected: Record<string, string> = {};
    proxyNetworkPropagator.inject(extracted, injected, {
      set: (carrier, key, value) => { carrier[key] = value; },
    });

    expect(trace.getSpanContext(extracted)).toEqual(trace.getSpanContext(trusted));
    expect(proxyNetworkPropagator.fields()).toEqual([]);
    expect(injected).toEqual({});
  });

  it("classifies only allowlisted direct or nested transport error codes", async () => {
    const { classifyExpectedRuntimeFailure } = await import("../telemetry/facade.js");
    const nestedNetwork = new TypeError("PRIVATE_FETCH_FAILURE");
    Object.defineProperty(nestedNetwork, "cause", {
      value: Object.assign(new Error("PRIVATE_SOCKET_FAILURE"), { code: "ECONNRESET" }),
    });
    const directTimeout = Object.assign(new Error("PRIVATE_TIMEOUT"), { code: "ETIMEDOUT" });

    expect(classifyExpectedRuntimeFailure(nestedNetwork)).toBe("network_failure");
    expect(classifyExpectedRuntimeFailure(directTimeout)).toBe("timeout");
    expect(classifyExpectedRuntimeFailure(new TypeError("PRIVATE_PARSER_FAILURE"))).toBeUndefined();
  });

  it("exports only classified runtime operations and never forwards hostile context", async () => {
    const runtime = await import("../telemetry/runtime.js");
    expect(runtime.startProxyTelemetry("foreground")).toBe(true);

    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { createAnthropicProxy } = await import("../proxy/anthropic-proxy.js");
    const {
      annotateActiveSpan,
      flushTelemetryWithin,
      recordSafeLog,
      withTelemetrySpan,
    } = await import("../telemetry/facade.js");
    const upstreamHeaders: Array<Record<string, string | string[] | undefined>> = [];
    const upstream = createServer((request, response) => {
      upstreamHeaders.push({ ...request.headers });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: {\"type\":\"message_stop\"}\n\n");
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("upstream did not bind");

    const app = express();
    app.use("/v1", (request, _response, next) => {
      annotateActiveSpan("proxy.request", {
        httpMethod: "POST",
        provider: "anthropic",
        route: "messages",
        modelFamily: "sonnet",
        requestSource: "api",
        streaming: true,
      });
      next();
    });
    app.use("/v1", createAnthropicProxy({
      target: `http://127.0.0.1:${upstreamAddress.port}`,
      timeoutMs: 2_000,
      on: {
        proxyReq: () => annotateActiveSpan("provider.inference", {
          provider: "anthropic",
          route: "messages",
          modelFamily: "sonnet",
          streaming: true,
        }),
      },
    }));
    const downstream = createServer(app);
    await new Promise<void>(resolve => downstream.listen(0, "127.0.0.1", resolve));
    const downstreamAddress = downstream.address();
    if (!downstreamAddress || typeof downstreamAddress === "string") throw new Error("proxy did not bind");

    try {
      const response = await originalFetch(`http://127.0.0.1:${downstreamAddress.port}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          traceparent: `00-${MALICIOUS_TRACE_ID}-bbbbbbbbbbbbbbbb-01`,
          tracestate: "private=value",
          baggage: `private=${TELEMETRY_CANARY.headerValue}`,
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: TELEMETRY_CANARY.prompt }],
          stream: true,
        }),
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();

      const traceStart = capture.requests.length;
      await flushTelemetryWithin(500);
      await waitForRequest(capture, "/i/v1/traces", traceStart);
      const proxyWire = wireFor(capture, "/i/v1/traces", traceStart);
      expect(wireContainsTraceId(proxyWire, SAMPLED_TRACE_ID)).toBe(true);
      expect(wireContainsTraceId(proxyWire, MALICIOUS_TRACE_ID)).toBe(false);
      expect(proxyWire.toString("utf8")).toContain("proxy.request");
      expect(proxyWire.toString("utf8")).toContain("provider.inference");
      expect(upstreamHeaders).toHaveLength(1);
      expect(upstreamHeaders[0]).not.toHaveProperty("traceparent");
      expect(upstreamHeaders[0]).not.toHaveProperty("tracestate");
      expect(upstreamHeaders[0]).not.toHaveProperty("baggage");

      const modules = await Promise.all([
        import("../providers/openai/codex-transport.js"),
        import("../providers/openai/token-refresher.js"),
        import("../proxy/token-refresher.js"),
        import("../providers/anthropic/usage-refresher.js"),
        import("../providers/model-discovery.js"),
      ]);
      const [codex, openAIRefresh, anthropicRefresh, usage, discovery] = modules;
      const openAIAccount = {
        id: TELEMETRY_CANARY.accountId,
        provider: "openai_subscription" as const,
        accessToken: TELEMETRY_CANARY.bearerToken,
        refreshToken: "PRIVATE_REFRESH_TOKEN",
        expiresAt: Date.now() + 1_000,
        enabled: true,
      };
      expect((await codex.forwardOpenAICodexResponse({
        account: openAIAccount,
        body: { model: "gpt-5-codex", input: [] },
        stream: false,
      })).status).toBe(200);
      expect(await openAIRefresh.refreshOpenAISubscriptionToken(openAIAccount)).toBe(false);

      const anthropicAccount = {
        id: TELEMETRY_CANARY.accountId,
        tokens: {
          accessToken: TELEMETRY_CANARY.bearerToken,
          refreshToken: "PRIVATE_ANTHROPIC_REFRESH_TOKEN",
          expiresAt: Date.now() + 1_000,
          scopes: ["private:scope"],
        },
        healthy: true,
        busy: false,
        requestCount: 0,
        errorCount: 0,
        lastUsed: 0,
        lastRefresh: 0,
        consecutiveErrors: 0,
        rateLimits: {
          status: "unknown" as const,
          fiveHourUtil: 0,
          fiveHourReset: 0,
          sevenDayUtil: 0,
          sevenDayReset: 0,
          claim: "",
          plan: "",
          requestsLimit: 0,
          lastUpdated: 0,
        },
        enabled: true,
        sessionLimitPercent: 100,
        weeklyLimitPercent: 100,
      };
      const localError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await anthropicRefresh.refreshAccountToken(anthropicAccount)).toBe(false);
      localError.mockRestore();

      const usageRefresher = new usage.AnthropicUsageRefresher({
        getAll: () => [anthropicAccount],
        findById: () => anthropicAccount,
      }, {
        fetchUsage: async () => ({
          ok: true,
          snapshot: { modelLimits: [], fetchedAt: 1, fetchStatus: "fresh" },
        }),
      });
      await usageRefresher.refreshNow(anthropicAccount);
      expect(await discovery.fetchAnthropicModels(anthropicAccount, async () => new Response(
        JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))).toEqual(["claude-sonnet-4-5"]);

      const operationStart = capture.requests.length;
      await flushTelemetryWithin(500);
      await waitForRequest(capture, "/i/v1/traces", operationStart);
      const operationWire = wireFor(capture, "/i/v1/traces", operationStart).toString("utf8");
      for (const operation of [
        "provider.inference",
        "oauth.refresh",
        "provider.usage_refresh",
        "model.discovery",
      ]) {
        expect(operationWire).toContain(operation);
      }

      const correlatedStart = capture.requests.length;
      let activeLogTraceId: string | undefined;
      await withTelemetrySpan("oauth.refresh", { provider: "openai" }, async () => {
        activeLogTraceId = trace.getActiveSpan()?.spanContext().traceId;
        recordSafeLog({
          operation: "oauth.refresh",
          provider: "openai",
          reason: "rate_limited",
          outcome: "rate_limited",
          httpStatusCode: 429,
          severity: "warn",
        });
      });
      await flushTelemetryWithin(500);
      await waitForRequest(capture, "/i/v1/logs", correlatedStart);
      const correlatedLog = wireFor(capture, "/i/v1/logs", correlatedStart);
      expect(activeLogTraceId).toBe(SAMPLED_TRACE_ID);
      expect(wireContainsTraceId(correlatedLog, SAMPLED_TRACE_ID)).toBe(true);

      const standaloneStart = capture.requests.length;
      recordSafeLog({
        operation: "oauth.refresh",
        provider: "openai",
        reason: "rate_limited",
        outcome: "rate_limited",
        httpStatusCode: 429,
        severity: "warn",
      });
      await flushTelemetryWithin(500);
      await waitForRequest(capture, "/i/v1/logs", standaloneStart);
      const standaloneLog = wireFor(capture, "/i/v1/logs", standaloneStart);
      expect(wireContainsTraceId(standaloneLog, SAMPLED_TRACE_ID)).toBe(false);

      const allWire = wireFor(capture, "/i/v1/traces").toString("utf8")
        + wireFor(capture, "/i/v1/logs").toString("utf8");
      for (const canary of [
        TELEMETRY_CANARY.prompt,
        TELEMETRY_CANARY.headerValue,
        TELEMETRY_CANARY.accountId,
        TELEMETRY_CANARY.bearerToken,
        "PRIVATE_REFRESH_TOKEN",
        "PRIVATE_ANTHROPIC_REFRESH_TOKEN",
        "provider-private-body",
      ]) {
        expect(allWire).not.toContain(canary);
      }

      const forgedUnsampled = trace.setSpanContext(ROOT_CONTEXT, {
        traceId: MALICIOUS_TRACE_ID,
        spanId: "bbbbbbbbbbbbbbbb",
        traceFlags: TraceFlags.NONE,
        isRemote: true,
      });
      const unsampledStart = capture.requests.length;
      await context.with(forgedUnsampled, async () => {
        recordSafeLog({
          operation: "proxy.request",
          provider: "anthropic",
          reason: "timeout",
          outcome: "timeout",
          severity: "warn",
        });
        await flushTelemetryWithin(500);
      });
      await waitForRequest(capture, "/i/v1/logs", unsampledStart);
      expect(wireContainsTraceId(
        wireFor(capture, "/i/v1/logs", unsampledStart),
        MALICIOUS_TRACE_ID,
      )).toBe(false);
    } finally {
      await new Promise<void>(resolve => downstream.close(() => resolve()));
      downstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      upstream.closeAllConnections();
    }
  }, 15_000);

  it("derives closed Responses route fields and records expected upstream failures", async () => {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { mountResponsesRoutes } = await import("../proxy/responses-server.js");
    const { flushTelemetryWithin } = await import("../telemetry/facade.js");
    const app = express();
    mountResponsesRoutes(app, {
      getOpenAIAccount: () => ({
        id: TELEMETRY_CANARY.accountId,
        provider: "openai_subscription",
        accessToken: TELEMETRY_CANARY.bearerToken,
        refreshToken: "private-refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      }),
      forwardOpenAI: async () => new Response("private upstream response", {
        status: 429,
        headers: { "content-type": "text/plain" },
      }),
    });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Responses app did not bind");
    const started = capture.requests.length;

    try {
      const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "private-desktop-secret",
        },
        body: JSON.stringify({
          model: "openai/gpt-5-codex",
          input: [{ role: "user", content: TELEMETRY_CANARY.prompt }],
          stream: true,
        }),
      });
      expect(response.status).toBe(429);
      expect(await response.text()).toBe("private upstream response");
      await flushTelemetryWithin(500);
      await Promise.all([
        waitForRequest(capture, "/i/v1/traces", started),
        waitForRequest(capture, "/i/v1/logs", started),
      ]);

      const traceWire = wireFor(capture, "/i/v1/traces", started).toString("utf8");
      expect(traceWire).toContain("proxy.request");
      expect(traceWire).toContain("cc_router.route");
      expect(traceWire).toContain("responses");
      expect(traceWire).toContain("cc_router.provider");
      expect(traceWire).toContain("openai");
      expect(traceWire).toContain("cc_router.model_family");
      expect(traceWire).toContain("codex");
      expect(traceWire).toContain("cc_router.request_source");
      expect(traceWire).toContain("desktop");
      expect(traceWire).toContain("cc_router.streaming");
      expect(traceWire).toContain("cc_router.outcome");
      expect(traceWire).toContain("rate_limited");

      const logWire = wireFor(capture, "/i/v1/logs", started).toString("utf8");
      expect(logWire).toContain("runtime.failure");
      expect(logWire).toContain("rate_limited");
      expect(logWire).toContain("429");
      const allWire = traceWire + logWire;
      expect(allWire).not.toContain(TELEMETRY_CANARY.prompt);
      expect(allWire).not.toContain(TELEMETRY_CANARY.accountId);
      expect(allWire).not.toContain("private-desktop-secret");
      expect(allWire).not.toContain("private upstream response");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
    }
  });

  it("records cross-routed Messages outcomes and usage without retaining translated content", async () => {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { mountMessagesCrossProviderRoute } = await import("../proxy/messages-cross-route.js");
    const { flushTelemetryWithin } = await import("../telemetry/facade.js");
    const app = express();
    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => ({
        id: TELEMETRY_CANARY.accountId,
        provider: "openai_subscription",
        accessToken: TELEMETRY_CANARY.bearerToken,
        refreshToken: "private-refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      }),
      forwardOpenAI: async () => new Response([
        'data: {"type":"response.created","response":{"id":"private-response-id","model":"gpt-5-codex"}}',
        'data: {"type":"response.output_text.delta","delta":"private translated output"}',
        'data: {"type":"response.completed","response":{"id":"private-response-id","model":"gpt-5-codex","usage":{"input_tokens":7,"output_tokens":11}}}',
        "",
      ].join("\n\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Messages app did not bind");
    const started = capture.requests.length;

    try {
      const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claude-code-session-id": "private-session-id",
        },
        body: JSON.stringify({
          model: "openai/gpt-5-codex",
          messages: [{ role: "user", content: TELEMETRY_CANARY.prompt }],
          stream: true,
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("private translated output");
      await flushTelemetryWithin(500);
      await waitForRequest(capture, "/i/v1/traces", started);

      const wire = wireFor(capture, "/i/v1/traces", started).toString("utf8");
      for (const safeValue of [
        "proxy.request",
        "cc_router.provider",
        "openai",
        "cc_router.route",
        "messages",
        "cc_router.model_family",
        "codex",
        "cc_router.request_source",
        "cli",
        "cc_router.streaming",
        "cc_router.outcome",
        "complete",
        "cc_router.stream_outcome",
        "cc_router.input_tokens",
        "cc_router.output_tokens",
      ]) {
        expect(wire).toContain(safeValue);
      }
      for (const privateValue of [
        TELEMETRY_CANARY.prompt,
        TELEMETRY_CANARY.accountId,
        TELEMETRY_CANARY.bearerToken,
        "private-session-id",
        "private-response-id",
        "private translated output",
      ]) {
        expect(wire).not.toContain(privateValue);
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
    }
  });

  it("keeps expected runtime failures in logs and sends only sanitized unexpected exceptions", async () => {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { mountMessagesCrossProviderRoute } = await import("../proxy/messages-cross-route.js");
    const { flushTelemetryWithin } = await import("../telemetry/facade.js");
    let unexpected = false;
    const app = express();
    mountMessagesCrossProviderRoute(app, {
      getOpenAIAccount: () => ({
        id: TELEMETRY_CANARY.accountId,
        provider: "openai_subscription",
        accessToken: TELEMETRY_CANARY.bearerToken,
        refreshToken: "private-refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      }),
      forwardOpenAI: async () => {
        if (unexpected) throw new TypeError("PRIVATE_UNEXPECTED_RUNTIME_MESSAGE");
        return new Response("private overloaded body", {
          status: 529,
          headers: { "content-type": "text/plain" },
        });
      },
    });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Messages failure app did not bind");

    const request = () => originalFetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-5-codex",
        messages: [{ role: "user", content: TELEMETRY_CANARY.prompt }],
      }),
    });

    try {
      const expectedStarted = capture.requests.length;
      const sdkBeforeExpected = posthogBodies.length;
      expect((await request()).status).toBe(529);
      await flushTelemetryWithin(500);
      await waitForRequest(capture, "/i/v1/logs", expectedStarted);
      const expectedLog = wireFor(capture, "/i/v1/logs", expectedStarted).toString("utf8");
      expect(expectedLog).toContain("runtime.failure");
      expect(expectedLog).toContain("upstream_5xx");
      expect(expectedLog).toContain("529");
      expect(expectedLog).not.toContain("private overloaded body");
      expect(posthogBodies).toHaveLength(sdkBeforeExpected);

      unexpected = true;
      const sdkBeforeUnexpected = posthogBodies.length;
      expect((await request()).status).toBe(500);
      await flushTelemetryWithin(500);
      await vi.waitFor(() => expect(posthogBodies.length).toBeGreaterThan(sdkBeforeUnexpected));
      const exceptionWire = posthogBodies.slice(sdkBeforeUnexpected).join("\n");
      expect(exceptionWire).toContain("$exception");
      expect(exceptionWire).toContain("type_error");
      expect(exceptionWire).not.toContain("PRIVATE_UNEXPECTED_RUNTIME_MESSAGE");
      expect(exceptionWire).not.toContain(TELEMETRY_CANARY.prompt);
      expect(exceptionWire).not.toContain(TELEMETRY_CANARY.accountId);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
    }
  });

  it("reclassifies an unexpected refresh parser failure after a successful HTTP response", async () => {
    const { refreshOpenAISubscriptionToken } = await import("../providers/openai/token-refresher.js");
    const { flushTelemetryWithin } = await import("../telemetry/facade.js");
    const started = capture.requests.length;
    const sdkStarted = posthogBodies.length;
    returnMalformedOpenAIRefresh = true;
    try {
      await expect(refreshOpenAISubscriptionToken({
        id: TELEMETRY_CANARY.accountId,
        provider: "openai_subscription",
        accessToken: TELEMETRY_CANARY.bearerToken,
        refreshToken: "private-refresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      })).rejects.toBeInstanceOf(SyntaxError);
      await flushTelemetryWithin(500);
      await Promise.all([
        waitForRequest(capture, "/i/v1/traces", started),
        waitForRequest(capture, "/i/v1/logs", started),
      ]);
      await vi.waitFor(() => expect(posthogBodies.length).toBeGreaterThan(sdkStarted));

      const traceWire = wireFor(capture, "/i/v1/traces", started).toString("utf8");
      expect(traceWire).toContain("oauth.refresh");
      expect(traceWire).toContain("upstream_error");
      const logWire = wireFor(capture, "/i/v1/logs", started).toString("utf8");
      expect(logWire).toContain("unexpected_response_shape");
      const remoteWire = traceWire + logWire + posthogBodies.slice(sdkStarted).join("\n");
      expect(remoteWire).not.toContain("PRIVATE_MALFORMED_REFRESH_BODY");
      expect(remoteWire).not.toContain(TELEMETRY_CANARY.accountId);
      expect(remoteWire).not.toContain(TELEMETRY_CANARY.bearerToken);
    } finally {
      returnMalformedOpenAIRefresh = false;
    }
  });

  it("emits one rate-limit diagnostic when the Codex leaf and route observe the same response", async () => {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { mountResponsesRoutes } = await import("../proxy/responses-server.js");
    const { flushTelemetryWithin } = await import("../telemetry/facade.js");
    const app = express();
    mountResponsesRoutes(app, {
      getOpenAIAccount: () => ({
        id: TELEMETRY_CANARY.accountId,
        provider: "openai_subscription",
        accessToken: TELEMETRY_CANARY.bearerToken,
        refreshToken: "private-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
    });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("exact-count app did not bind");
    const started = capture.requests.length;
    codexStatus = 429;

    try {
      const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5-codex", input: [] }),
      });
      expect(response.status).toBe(429);
      await response.arrayBuffer();
      await flushTelemetryWithin(500);
      await waitForRequest(capture, "/i/v1/logs", started);

      const logWire = wireFor(capture, "/i/v1/logs", started).toString("utf8");
      expect(countOccurrences(logWire, "runtime.failure")).toBe(1);
      expect(logWire).toContain("rate_limited");
      expect(logWire).not.toContain("private codex response");
    } finally {
      codexStatus = 200;
      await new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
    }
  });

  it("keeps the leaf refresh reason without adding a contradictory route diagnostic", async () => {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { mountResponsesRoutes } = await import("../proxy/responses-server.js");
    const { prepareOpenAIAccountForRequest } = await import("../providers/openai/token-refresher.js");
    const { flushTelemetryWithin } = await import("../telemetry/facade.js");
    const account = {
      id: TELEMETRY_CANARY.accountId,
      provider: "openai_subscription" as const,
      accessToken: TELEMETRY_CANARY.bearerToken,
      refreshToken: "private-refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };
    const app = express();
    mountResponsesRoutes(app, {
      getOpenAIAccount: () => account,
      prepareOpenAIAccount: candidate => prepareOpenAIAccountForRequest(candidate, [account], () => undefined),
      prepareOpenAIAccountOwnsDiagnostics: true,
    });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("refresh-count app did not bind");
    const started = capture.requests.length;

    try {
      const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5-codex", input: [] }),
      });
      expect(response.status).toBe(401);
      await response.arrayBuffer();
      await flushTelemetryWithin(500);
      await waitForRequest(capture, "/i/v1/logs", started);

      const logWire = wireFor(capture, "/i/v1/logs", started).toString("utf8");
      expect(countOccurrences(logWire, "runtime.failure")).toBe(1);
      expect(logWire).toContain("rate_limited");
      expect(logWire).not.toContain("unauthorized");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
    }
  });

  it("emits one sanitized exception when the Codex leaf and route observe the same throw", async () => {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { mountResponsesRoutes } = await import("../proxy/responses-server.js");
    const { flushTelemetryWithin } = await import("../telemetry/facade.js");
    const app = express();
    mountResponsesRoutes(app, {
      getOpenAIAccount: () => ({
        id: TELEMETRY_CANARY.accountId,
        provider: "openai_subscription",
        accessToken: TELEMETRY_CANARY.bearerToken,
        refreshToken: "private-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        enabled: true,
      }),
    });
    app.use((_error: unknown, _req: unknown, res: { status: (code: number) => { end: () => void } }, _next: unknown) => {
      res.status(500).end();
    });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("exception-count app did not bind");
    const sdkStarted = posthogBodies.length;
    codexUnexpected = true;

    try {
      const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5-codex", input: [] }),
      });
      expect(response.status).toBe(500);
      await response.arrayBuffer();
      await flushTelemetryWithin(500);
      await vi.waitFor(() => expect(posthogBodies.length).toBeGreaterThan(sdkStarted));

      const exceptionWire = posthogBodies.slice(sdkStarted).join("\n");
      expect(countOccurrences(exceptionWire, '"event":"$exception"')).toBe(1);
      expect(exceptionWire).not.toContain("PRIVATE_CODEX_FAILURE");
      expect(exceptionWire).not.toContain(TELEMETRY_CANARY.accountId);
    } finally {
      codexUnexpected = false;
      await new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
    }
  });

  it("reports invalid structured success payloads without retaining their content", async () => {
    const { refreshOpenAISubscriptionToken } = await import("../providers/openai/token-refresher.js");
    const { fetchAnthropicModels } = await import("../providers/model-discovery.js");
    const { flushTelemetryWithin } = await import("../telemetry/facade.js");
    const openAIAccount = {
      id: TELEMETRY_CANARY.accountId,
      provider: "openai_subscription" as const,
      accessToken: TELEMETRY_CANARY.bearerToken,
      refreshToken: "private-refresh",
      expiresAt: 12345,
      enabled: true,
    };
    const anthropicAccount = {
      id: TELEMETRY_CANARY.accountId,
      tokens: {
        accessToken: TELEMETRY_CANARY.bearerToken,
        refreshToken: "private-anthropic-refresh",
        expiresAt: Date.now() + 60_000,
        scopes: ["private:scope"],
      },
      healthy: true,
      busy: false,
      requestCount: 0,
      errorCount: 0,
      lastUsed: 0,
      lastRefresh: 0,
      consecutiveErrors: 0,
      rateLimits: {
        status: "unknown" as const,
        fiveHourUtil: 0,
        fiveHourReset: 0,
        sevenDayUtil: 0,
        sevenDayReset: 0,
        claim: "",
        plan: "",
        requestsLimit: 0,
        lastUpdated: 0,
      },
      enabled: true,
      sessionLimitPercent: 100,
      weeklyLimitPercent: 100,
    };
    const transportStarted = capture.requests.length;
    const sdkStarted = posthogBodies.length;
    returnInvalidOpenAIRefresh = true;

    try {
      await expect(refreshOpenAISubscriptionToken(openAIAccount)).rejects.toBeInstanceOf(TypeError);
      expect(openAIAccount).toEqual(expect.objectContaining({
        accessToken: TELEMETRY_CANARY.bearerToken,
        refreshToken: "private-refresh",
        expiresAt: 12345,
      }));
      await expect(fetchAnthropicModels(anthropicAccount, async () => new Response(JSON.stringify({
        private: TELEMETRY_CANARY.prompt,
      }), { status: 200, headers: { "content-type": "application/json" } }))).resolves.toEqual([]);
      await flushTelemetryWithin(500);
      await waitForRequest(capture, "/i/v1/logs", transportStarted);
      await vi.waitFor(() => expect(countOccurrences(
        posthogBodies.slice(sdkStarted).join("\n"),
        '"event":"$exception"',
      )).toBeGreaterThanOrEqual(2));

      const remoteWire = wireFor(capture, "/i/v1/logs", transportStarted).toString("utf8")
        + posthogBodies.slice(sdkStarted).join("\n");
      expect(countOccurrences(remoteWire, "unexpected_response_shape")).toBeGreaterThanOrEqual(2);
      expect(remoteWire).not.toContain(TELEMETRY_CANARY.prompt);
      expect(remoteWire).not.toContain(TELEMETRY_CANARY.accountId);
      expect(remoteWire).not.toContain(TELEMETRY_CANARY.bearerToken);
    } finally {
      returnInvalidOpenAIRefresh = false;
    }
  });

  it("preserves callback outcomes when span finalization throws", async () => {
    const { withTelemetrySpan } = await import("../telemetry/facade.js");
    const applicationError = new Error("application identity");
    const finalizationError = new Error("telemetry finalization");
    const getTracer = vi.spyOn(trace, "getTracer").mockReturnValue({
      startActiveSpan: (_name: string, _options: object, callback: (span: object) => unknown) => callback({
        setStatus: () => { throw finalizationError; },
        end: () => { throw finalizationError; },
      }),
    } as ReturnType<typeof trace.getTracer>);

    try {
      expect(withTelemetrySpan("model.discovery", { provider: "openai" }, () => 42)).toBe(42);
      await expect(withTelemetrySpan(
        "model.discovery",
        { provider: "openai" },
        async () => { throw applicationError; },
      )).rejects.toBe(applicationError);
    } finally {
      getTracer.mockRestore();
    }
  });

  it("discards queued runtime telemetry without transport calls when shutdown observes opt-out", async () => {
    const { recordSafeLog, withTelemetrySpan } = await import("../telemetry/facade.js");
    const runtime = await import("../telemetry/runtime.js");
    withTelemetrySpan("model.discovery", { provider: "anthropic" }, () => {
      recordSafeLog({
        operation: "model.discovery",
        provider: "anthropic",
        reason: "timeout",
        outcome: "timeout",
        severity: "warn",
      });
    });
    writeFileSync(telemetryPath, JSON.stringify({
      enabled: false,
      installId: INSTALL_ID,
      firstRunAt: "2026-08-01T00:00:00.000Z",
    }));
    const transportBefore = capture.requests.length;
    const posthogBefore = posthogBodies.length;
    const startedAt = Date.now();

    await runtime.shutdownProxyTelemetryWithin(100);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(capture.requests).toHaveLength(transportBefore);
    expect(posthogBodies).toHaveLength(posthogBefore);
  });
});
