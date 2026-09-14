import { EventEmitter } from "node:events";
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
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetrySnapshot } from "../config/telemetry.js";
import type { PostHogTelemetryClient } from "../telemetry/posthog-client.js";

const INSTALL_ID = "123e4567-e89b-42d3-a456-426614174000";
const DIAGNOSTIC_ID = "123e4567-e89b-42d3-a456-426614174001";
const CONSENT_GENERATION = "123e4567-e89b-42d3-a456-426614174010";
const NEXT_CONSENT_GENERATION = "123e4567-e89b-42d3-a456-426614174011";

function snapshotOf(enabled = true, consentGeneration = CONSENT_GENERATION): TelemetrySnapshot {
  const state = {
    enabled,
    installId: INSTALL_ID,
    firstRunAt: "2026-08-01T00:00:00.000Z",
    consentGeneration,
    revision: 0,
  };
  return { state, environmentDisabled: false, enabled };
}

const shared = vi.hoisted(() => ({
  snapshot: undefined as unknown,
  claimed: undefined as unknown,
  runtimeStarts: [] as unknown[],
  runtimeFlushes: [] as number[],
  runtimeShutdowns: [] as number[],
}));

vi.mock("../config/telemetry.js", async importOriginal => ({
  ...await importOriginal<typeof import("../config/telemetry.js")>(),
  getTelemetrySnapshot: () => shared.snapshot,
  claimTelemetryFirstStart: () => {
    const claimed = shared.claimed;
    shared.claimed = undefined;
    return claimed;
  },
}));

vi.mock("../telemetry/runtime.js", () => ({
  startTelemetryRuntime: (options: unknown) => shared.runtimeStarts.push(options) > 0,
  isTelemetryRuntimeActive: () => shared.runtimeStarts.length > 0,
  flushTelemetryRuntimeWithin: async (ms: number) => { shared.runtimeFlushes.push(ms); },
  shutdownTelemetryRuntimeWithin: async (ms: number) => { shared.runtimeShutdowns.push(ms); },
  noopPropagator: { inject: () => undefined, extract: (value: unknown) => value, fields: () => [] },
}));

const {
  annotateActiveSpan,
  createTelemetryFacade,
  httpFailureReason,
  httpOutcome,
  modelFamilyOf,
  runtimeMode,
  startTelemetrySpan,
  telemetryRequestMiddleware,
  withTelemetrySpan,
} = await import("../telemetry/facade.js");

type CapturedEvent = { event: string; properties: Record<string, unknown>; distinctId?: string };
type CapturedException = { error: Error; diagnosticId: string };

function analyticsStub() {
  const events: CapturedEvent[] = [];
  const exceptions: CapturedException[] = [];
  const calls = { flush: 0, shutdown: 0, discard: 0 };
  const capture = (value: unknown): void => { exceptions.push(value as CapturedException); };
  const client = {
    captureAnalytics: (event: unknown) => { events.push(event as CapturedEvent); },
    // TEMP(A2): the donor client still declares captureAnalyticsImmediate.
    captureAnalyticsImmediate: async () => expect.unreachable("analytics are queued"),
    captureException: capture,
    captureExceptionImmediate: async (value: unknown) => capture(value),
    flushWithin: async () => { calls.flush += 1; },
    shutdownWithin: async () => { calls.shutdown += 1; },
    discardPending: () => { calls.discard += 1; },
  } as unknown as PostHogTelemetryClient;
  return { client, events, exceptions, calls };
}

const spanExporter = new InMemorySpanExporter();
const logExporter = new InMemoryLogRecordExporter();

function recordedSpans() {
  return spanExporter.getFinishedSpans()
    .map(span => ({ name: span.name, attributes: span.attributes, status: span.status.code }));
}

function recordedLogs() {
  return logExporter.getFinishedLogRecords().map(record =>
    ({ body: record.body, severityText: record.severityText, attributes: record.attributes }));
}

let analytics: ReturnType<typeof analyticsStub>;

function facadeFor(snapshot: () => TelemetrySnapshot) {
  return createTelemetryFacade({
    getSnapshot: snapshot,
    analytics: analytics.client,
    now: () => 1_800_000_000_000,
    randomUUID: () => DIAGNOSTIC_ID,
  });
}

beforeEach(() => {
  Object.assign(shared, {
    snapshot: snapshotOf(),
    claimed: undefined,
    runtimeStarts: [],
    runtimeFlushes: [],
    runtimeShutdowns: [],
  });
  analytics = analyticsStub();
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
  vi.restoreAllMocks();
});

describe("telemetry facade", () => {
  it("exposes only closed recording operations", () => {
    expect(Object.keys(facadeFor(snapshotOf)).sort().join(" ")).toBe([
      "flushTelemetryWithin recordApplicationStart recordExpectedSetupFailure recordProxyStarted",
      "recordRuntimeError recordSafeLog recordSetupResult recordSetupStage recordSetupStageFailure",
      "recordUnexpectedException recordUpstreamStatus shutdownTelemetryWithin startProxyHeartbeat",
    ].join(" "));
  });

  it("makes every capture a no-op while telemetry is disabled", () => {
    shared.snapshot = snapshotOf(false);
    const facade = facadeFor(() => snapshotOf(false));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    facade.recordApplicationStart();
    facade.recordProxyStarted(4);
    facade.startProxyHeartbeat(() => 4);
    facade.recordSafeLog({ operation: "proxy.request", reason: "timeout", severity: "warn" });
    facade.recordUpstreamStatus("provider.inference", "openai", 503);
    facade.recordRuntimeError(new Error("private"), { operation: "provider.inference" });
    facade.recordSetupStage({
      provider: "openai", method: "device_oauth", stage: "token_exchange",
      diagnosticId: DIAGNOSTIC_ID,
    });
    expect(facade.recordUnexpectedException(new Error("private"), {
      category: "runtime", reason: "other",
    })).toBeUndefined();
    startTelemetrySpan("provider.inference", { provider: "openai" }).end("ok");

    expect(analytics.events).toEqual([]);
    expect(analytics.exceptions).toEqual([]);
    expect(recordedLogs()).toEqual([]);
    expect(recordedSpans()).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(shared.runtimeStarts).toEqual([]);
  });

  it("claims app.first_start once, and only for this consent generation", () => {
    shared.claimed = snapshotOf();
    const facade = facadeFor(snapshotOf);
    facade.recordApplicationStart();
    facade.recordApplicationStart();

    shared.claimed = snapshotOf(true, NEXT_CONSENT_GENERATION);
    facadeFor(snapshotOf).recordApplicationStart();

    expect(analytics.events.map(event => event.event)).toEqual(["app.first_start"]);
    expect(analytics.events[0]?.distinctId).toBe(INSTALL_ID);
    expect(analytics.events[0]?.properties).toEqual({
      serviceVersion: expect.any(String),
      osFamily: expect.any(String),
      runtimeMode: "foreground",
    });
  });

  it("clamps proxy lifecycle counts and unrefs the hourly heartbeat", () => {
    vi.useFakeTimers();
    try {
      const facade = facadeFor(snapshotOf);
      facade.recordProxyStarted(50_000);
      facade.startProxyHeartbeat(() => -20);
      vi.advanceTimersByTime(60 * 60 * 1_000);
      vi.advanceTimersByTime(60 * 60 * 1_000 - 1);

      expect(analytics.events.map(event => event.event)).toEqual(["proxy.started", "proxy.heartbeat"]);
      expect(analytics.events[0]?.properties["accountPoolSize"]).toBe(10_000);
      expect(analytics.events[1]?.properties["accountPoolSize"]).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps runtime failure logs through the closed key map", () => {
    facadeFor(snapshotOf).recordSafeLog({
      operation: "provider.inference",
      provider: "openai",
      reason: "upstream_5xx",
      severity: "error",
      httpStatusCode: 503,
      attempt: 2,
      operationDurationMs: 1_200,
      diagnosticId: DIAGNOSTIC_ID,
      ...{ prompt: "never-exported", accountId: "never-exported" },
    });

    expect(recordedLogs()).toEqual([{
      body: "runtime.failure",
      severityText: "ERROR",
      attributes: {
        "cc_router.operation": "provider.inference",
        "cc_router.provider": "openai",
        "cc_router.reason": "upstream_5xx",
        "http.response.status_code": 503,
        "cc_router.attempt": 2,
        "cc_router.operation_duration_ms": 1_200,
        "cc_router.diagnostic_id": DIAGNOSTIC_ID,
        "service.version": expect.any(String),
        "os.type": expect.any(String),
        "cc_router.runtime_mode": "foreground",
      },
    }]);
    expect(shared.runtimeStarts).toEqual([{ tracing: false, runtimeMode: "foreground" }]);
  });

  it("derives upstream reasons and outcomes from the status code alone", () => {
    expect([401, 403, 429, 418, 503].map(httpFailureReason))
      .toEqual(["unauthorized", "forbidden", "rate_limited", "upstream_4xx", "upstream_5xx"]);
    expect([200, 429, 503].map(httpOutcome))
      .toEqual(["complete", "rate_limited", "upstream_error"]);

    facadeFor(snapshotOf).recordUpstreamStatus("oauth.refresh", "anthropic", 429, { attempt: 3 });

    expect(recordedLogs()[0]).toMatchObject({
      severityText: "WARN",
      attributes: {
        "cc_router.operation": "oauth.refresh",
        "cc_router.reason": "rate_limited",
        "cc_router.outcome": "rate_limited",
        "http.response.status_code": 429,
        "cc_router.attempt": 3,
      },
    });
  });

  it("logs expected transport failures and sanitizes unexpected ones", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const facade = facadeFor(snapshotOf);

    facade.recordRuntimeError(
      Object.assign(new Error("PRIVATE_SOCKET_FAILURE"), { code: "ECONNRESET" }),
      { operation: "provider.inference", provider: "openai" },
    );
    facade.recordRuntimeError(new TypeError("PRIVATE_PARSER_FAILURE"), {
      operation: "provider.inference" });

    expect(recordedLogs()).toHaveLength(1);
    expect(recordedLogs()[0]?.attributes["cc_router.reason"]).toBe("network_failure");
    expect(analytics.exceptions).toHaveLength(1);
    expect(analytics.exceptions[0]?.diagnosticId).toBe(DIAGNOSTIC_ID);
    expect(analytics.exceptions[0]?.error.message).not.toContain("PRIVATE_PARSER_FAILURE");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(DIAGNOSTIC_ID),
      expect.any(TypeError),
    );

    // A diagnostic id must be a fresh random UUID and never the install id.
    for (const identity of ["not-a-uuid", INSTALL_ID]) {
      expect(facade.recordUnexpectedException(new Error("private"), {
        category: "setup", reason: "other",
      }, identity)).toBeUndefined();
    }
    expect(analytics.exceptions).toHaveLength(1);
  });

  it("records the setup funnel with one diagnostic id per attempt", () => {
    const facade = facadeFor(snapshotOf);
    const attempt = {
      provider: "openai", method: "device_oauth",
      diagnosticId: DIAGNOSTIC_ID, durationBucket: "under_1s",
    } as const;

    facade.recordSetupStage({ ...attempt, stage: "attempt_start" });
    facade.recordSetupStage({ ...attempt, stage: "token_exchange" });
    facade.recordSetupStageFailure({ ...attempt, stage: "token_exchange", reason: "rate_limited" });
    facade.recordExpectedSetupFailure({ ...attempt, stage: "token_exchange", reason: "unauthorized" });
    facade.recordSetupResult({ ...attempt, result: "cancelled" });

    expect(analytics.events.map(event => event.event)).toEqual([
      "account_setup.started", "account_setup.stage_completed",
      "account_setup.failed", "account_setup.cancelled",
    ]);
    expect(new Set(analytics.events.map(event => event.properties["diagnosticId"])))
      .toEqual(new Set([DIAGNOSTIC_ID]));
    expect(recordedLogs().map(log => log.attributes["cc_router.stage"])).toEqual([
      "attempt_start", "token_exchange", "token_exchange", "token_exchange", "cancellation",
    ]);
    expect(recordedLogs().every(log => log.body === "account.setup.diagnostic")).toBe(true);
  });

  it("keeps span handles idempotent and callbacks single-shot", async () => {
    const handle = startTelemetrySpan("provider.inference", { provider: "openai", attempt: 1 });
    handle.annotate({ outcome: "complete" });
    handle.end("ok");
    handle.end("error");
    handle.annotate({ outcome: "timeout" });

    let calls = 0;
    await expect(withTelemetrySpan("oauth.refresh", { provider: "anthropic" }, async () => {
      calls += 1;
      throw new Error("private");
    })).rejects.toThrow("private");
    await withTelemetrySpan("model.discovery", { provider: "anthropic" }, async () => {
      annotateActiveSpan("model.discovery", { outcome: "complete" });
      return undefined;
    });

    expect(calls).toBe(1);
    expect(recordedSpans().map(span => span.name))
      .toEqual(["provider.inference", "oauth.refresh", "model.discovery"]);
    expect(recordedSpans()[0]?.attributes).toEqual({
      "cc_router.operation": "provider.inference",
      "cc_router.provider": "openai",
      "cc_router.attempt": 1,
      "cc_router.outcome": "complete",
    });
    expect(recordedSpans()[1]?.status).toBe(2);
    expect(recordedSpans()[2]?.attributes["cc_router.outcome"]).toBe("complete");
  });

  it("wraps only the inference routes in an active proxy.request span", () => {
    const middleware = telemetryRequestMiddleware();
    const run = (path: string): { nextCalls: number; activeSpans: number } => {
      const response = Object.assign(new EventEmitter(), { statusCode: 503 });
      let nextCalls = 0;
      let activeSpans = 0;
      middleware({ path, method: "POST" } as Request, response as unknown as Response, () => {
        nextCalls += 1;
        if (trace.getActiveSpan()) activeSpans += 1;
      });
      response.emit("finish");
      response.emit("close");
      return { nextCalls, activeSpans };
    };

    expect(run("/v1/messages")).toEqual({ nextCalls: 1, activeSpans: 1 });
    expect(run("/health")).toEqual({ nextCalls: 1, activeSpans: 0 });

    expect(recordedSpans()).toEqual([{
      name: "proxy.request",
      status: 2,
      attributes: {
        "cc_router.operation": "proxy.request",
        "http.request.method": "POST",
        "cc_router.route": "messages",
        "http.response.status_code": 503,
      },
    }]);
  });

  it("latches off after a consent change, then discards on flush and shutdown", async () => {
    let snapshot = snapshotOf();
    const facade = facadeFor(() => snapshot);
    facade.recordProxyStarted(1);
    await facade.flushTelemetryWithin(500);

    // A new generation is an explicit choice: this facade never resumes.
    snapshot = snapshotOf(true, NEXT_CONSENT_GENERATION);
    facade.recordProxyStarted(1);
    snapshot = snapshotOf();
    facade.recordProxyStarted(1);
    await facade.shutdownTelemetryWithin(500);

    expect(analytics.events).toHaveLength(1);
    expect(analytics.calls).toEqual({ flush: 1, shutdown: 1, discard: 2 });
    expect(shared.runtimeFlushes).toEqual([500]);
    expect(shared.runtimeShutdowns).toEqual([500]);
  });

  it("classifies model families and runtime modes from closed inputs", () => {
    expect([
      "claude-fable-5-20260219", "claude-sonnet-4-5", "claude-opus-4-1",
      "claude-3-5-haiku", "gpt-5.2-codex", "mistral-large",
    ].map(modelFamilyOf)).toEqual(["fable", "sonnet", "opus", "haiku", "codex", "other"]);

    expect(runtimeMode()).toBe("foreground");
    process.env["CC_ROUTER_DAEMON"] = "1";
    expect(runtimeMode()).toBe("daemon");
    process.env["CC_ROUTER_SERVICE"] = "1";
    expect(runtimeMode()).toBe("service");
    delete process.env["CC_ROUTER_DAEMON"];
    delete process.env["CC_ROUTER_SERVICE"];
  });
});
