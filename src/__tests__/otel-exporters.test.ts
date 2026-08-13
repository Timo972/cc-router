import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import type { TelemetrySnapshot } from "../config/telemetry.js";
import { startTransportCaptureServer, TELEMETRY_CANARY } from "./telemetry-test-helpers.js";
import {
  createPostHogOtlpExporters,
  createPrivacySafeLogExporter,
  createPrivacySafeSpanExporter,
} from "../telemetry/otel-exporters.js";

const INSTALL_ID = "70d8062e-1fa0-4ae4-a115-bf782ecca462";
const CANDIDATE_ID = "916ce1d6-2e8d-48b2-a70e-0337bdf82df7";
const DIAGNOSTIC_ID = "ad94f035-1e08-4e29-8517-fd56bdc83d99";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "0123456789abcdef";
const PARENT_SPAN_ID = "fedcba9876543210";
const PRIVATE_CANARY = "PRIVATE prompt token@example.test /Users/alice ?secret=true";

function snapshot(enabled = true, revision = 0): TelemetrySnapshot {
  return {
    state: {
      enabled,
      installId: INSTALL_ID,
      firstRunAt: "2026-08-03T00:00:00.000Z",
      revision,
    },
    environmentDisabled: false,
    enabled,
  };
}

function unsafeResource() {
  return resourceFromAttributes({
    "service.name": "cc-router",
    "service.version": "0.8.2",
    "service.instance.id": CANDIDATE_ID,
    "process.runtime.version": "22.18.0",
    "os.type": "macos",
    "host.arch": "arm64",
    "cc_router.runtime_mode": "daemon",
    "host.name": PRIVATE_CANARY,
    "process.command_args": [PRIVATE_CANARY],
  });
}

function unsafeSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  const candidate: ReadableSpan = {
    name: `/v1/messages/${PRIVATE_CANARY}`,
    kind: SpanKind.SERVER,
    spanContext: () => ({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }),
    parentSpanContext: { traceId: TRACE_ID, spanId: PARENT_SPAN_ID, traceFlags: TraceFlags.SAMPLED },
    startTime: [1_800_000_000, 250_000_000],
    endTime: [1_800_000_001, 500_000_000],
    duration: [1, 250_000_000],
    status: { code: SpanStatusCode.OK, message: PRIVATE_CANARY },
    attributes: {
      "cc_router.operation": "proxy.request",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "cc_router.provider": "anthropic",
      "cc_router.route": "messages",
      "cc_router.model_family": "sonnet",
      "cc_router.request_source": "cli",
      "cc_router.runtime_mode": "daemon",
      "cc_router.streaming": true,
      "cc_router.stream_outcome": "complete",
      "cc_router.outcome": "complete",
      "cc_router.attempt": 2,
      "cc_router.account_pool_size": 3,
      "cc_router.concurrency": 1,
      "cc_router.input_tokens": 100,
      "cc_router.output_tokens": 20,
      "cc_router.operation_duration_ms": 1_200,
      "http.request.header.authorization": PRIVATE_CANARY,
      "url.full": PRIVATE_CANARY,
      prompt: PRIVATE_CANARY,
      "private.canaries": Object.values(TELEMETRY_CANARY),
    },
    links: [{ context: { traceId: TRACE_ID, spanId: PARENT_SPAN_ID, traceFlags: 1 }, attributes: { prompt: PRIVATE_CANARY } }],
    events: [{ name: PRIVATE_CANARY, time: [1_800_000_000, 0], attributes: { prompt: PRIVATE_CANARY }, droppedAttributesCount: 0 }],
    ended: true,
    resource: unsafeResource(),
    instrumentationScope: { name: "cc-router", version: PRIVATE_CANARY },
    droppedAttributesCount: 9,
    droppedEventsCount: 8,
    droppedLinksCount: 7,
  };
  return { ...candidate, ...overrides };
}

function exportSpans(exporter: SpanExporter, spans: ReadableSpan[]): Promise<{ code: number; error?: Error }> {
  return new Promise(resolve => exporter.export(spans, resolve));
}

function unsafeLog(overrides: Partial<ReadableLogRecord> = {}): ReadableLogRecord {
  const candidate: ReadableLogRecord = {
    hrTime: [1_800_000_000, 250_000_000],
    hrTimeObserved: [1_800_000_000, 999_000_000],
    spanContext: { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED },
    severityText: "WARN",
    severityNumber: SeverityNumber.WARN,
    body: "account.setup.diagnostic",
    eventName: PRIVATE_CANARY,
    resource: unsafeResource(),
    instrumentationScope: {
      name: "cc-router",
      version: PRIVATE_CANARY,
      attributes: { prompt: PRIVATE_CANARY },
      droppedAttributesCount: 9,
    },
    attributes: {
      "cc_router.provider": "openai",
      "cc_router.method": "device_oauth",
      "cc_router.stage": "token_exchange",
      "cc_router.reason": "unauthorized",
      "cc_router.outcome": "upstream_error",
      "http.response.status_code": 401,
      "cc_router.duration_bucket": "5s_to_30s",
      "service.version": "0.8.2",
      "os.type": "macos",
      "cc_router.runtime_mode": "foreground",
      "cc_router.diagnostic_id": CANDIDATE_ID,
      prompt: PRIVATE_CANARY,
      error: PRIVATE_CANARY,
      "private.canaries": Object.values(TELEMETRY_CANARY),
    },
    droppedAttributesCount: 8,
  };
  return { ...candidate, ...overrides };
}

function exportLogs(
  exporter: LogRecordExporter,
  logs: ReadableLogRecord[],
): Promise<{ code: number; error?: Error }> {
  return new Promise(resolve => exporter.export(logs, resolve));
}

describe("privacy-safe span exporter", () => {
  it("rebuilds a span from only the closed trace and resource schema", async () => {
    const delegated: ReadableSpan[][] = [];
    const delegate: SpanExporter = {
      export(spans, callback) {
        delegated.push(spans);
        callback({ code: 0 });
      },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    };
    const candidate = unsafeSpan();
    const exporter = createPrivacySafeSpanExporter({
      delegate,
      getSnapshot: () => snapshot(),
    });

    await expect(exportSpans(exporter, [candidate])).resolves.toEqual({ code: 0 });

    expect(delegated).toHaveLength(1);
    const safe = delegated[0]![0]!;
    expect(safe).not.toBe(candidate);
    expect(safe.name).toBe("proxy.request");
    expect(safe.kind).toBe(SpanKind.SERVER);
    expect(safe.spanContext()).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED });
    expect(safe.parentSpanContext).toEqual({ traceId: TRACE_ID, spanId: PARENT_SPAN_ID, traceFlags: TraceFlags.SAMPLED });
    expect(safe.startTime).toEqual([1_800_000_000, 250_000_000]);
    expect(safe.duration).toEqual([1, 250_000_000]);
    expect(safe.endTime).toEqual([1_800_000_001, 500_000_000]);
    expect(safe.status).toEqual({ code: SpanStatusCode.OK });
    expect(safe.attributes).toEqual({
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "cc_router.provider": "anthropic",
      "cc_router.route": "messages",
      "cc_router.model_family": "sonnet",
      "cc_router.request_source": "cli",
      "cc_router.runtime_mode": "daemon",
      "cc_router.streaming": true,
      "cc_router.stream_outcome": "complete",
      "cc_router.outcome": "complete",
      "cc_router.attempt": 2,
      "cc_router.account_pool_size": 3,
      "cc_router.concurrency": 1,
      "cc_router.input_tokens": 100,
      "cc_router.output_tokens": 20,
      "cc_router.operation_duration_ms": 1_200,
    });
    expect(safe.resource.attributes).toEqual({
      "service.name": "cc-router",
      "service.version": "0.8.2",
      "service.instance.id": INSTALL_ID,
      "process.runtime.version": "22.18.0",
      "os.type": "macos",
      "host.arch": "arm64",
      "cc_router.runtime_mode": "daemon",
    });
    expect(safe.instrumentationScope).toEqual({ name: "cc-router" });
    expect(safe.events).toEqual([]);
    expect(safe.links).toEqual([]);
    expect(safe.droppedAttributesCount).toBe(0);
    expect(safe.droppedEventsCount).toBe(0);
    expect(safe.droppedLinksCount).toBe(0);
    expect(JSON.stringify(safe)).not.toContain(PRIVATE_CANARY);
    expect(JSON.stringify(safe)).not.toContain(CANDIDATE_ID);
  });

  it("bounds force-flush and shutdown even when the delegate never settles", async () => {
    vi.useFakeTimers();
    try {
      const delegate: SpanExporter = {
        export: () => undefined,
        forceFlush: () => new Promise<void>(() => undefined),
        shutdown: () => new Promise<void>(() => undefined),
      };
      const exporter = createPrivacySafeSpanExporter({
        delegate,
        getSnapshot: () => snapshot(),
        lifecycleTimeoutMillis: 10,
      });

      const flush = exporter.forceFlush?.();
      await vi.advanceTimersByTimeAsync(11);
      await expect(flush).resolves.toBeUndefined();

      const shutdown = exporter.shutdown();
      await vi.advanceTimersByTimeAsync(11);
      await expect(shutdown).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps every delegated batch at the configured safe maximum", async () => {
    const delegated: ReadableSpan[][] = [];
    const delegate: SpanExporter = {
      export(spans, callback) {
        delegated.push(spans);
        callback({ code: 0 });
      },
      shutdown: async () => undefined,
    };
    const exporter = createPrivacySafeSpanExporter({
      delegate,
      getSnapshot: () => snapshot(),
      maxBatchSize: 2,
    });

    await exportSpans(exporter, [unsafeSpan(), unsafeSpan(), unsafeSpan()]);

    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toHaveLength(2);
  });

  it("does not flush a delegate after telemetry is disabled", async () => {
    let flushes = 0;
    const delegate: SpanExporter = {
      export: (_spans, callback) => callback({ code: 0 }),
      forceFlush: async () => {
        flushes += 1;
      },
      shutdown: async () => undefined,
    };
    const exporter = createPrivacySafeSpanExporter({
      delegate,
      getSnapshot: () => snapshot(false),
    });

    await exporter.forceFlush?.();

    expect(flushes).toBe(0);
  });

  it("drops unknown scopes and malformed records without calling the delegate", async () => {
    let delegateCalls = 0;
    const delegate: SpanExporter = {
      export: (_spans, callback) => {
        delegateCalls += 1;
        callback({ code: 0 });
      },
      shutdown: async () => undefined,
    };
    const exporter = createPrivacySafeSpanExporter({
      delegate,
      getSnapshot: () => snapshot(),
    });

    await expect(exportSpans(exporter, [
      unsafeSpan({ instrumentationScope: { name: "unknown-library" } }),
      unsafeSpan({ resource: resourceFromAttributes({ "service.name": "wrong-service" }) }),
    ])).resolves.toEqual({ code: 0 });

    expect(delegateCalls).toBe(0);
  });

  it("drops a reconstructed queued batch when telemetry turns off before delegation", async () => {
    let delegateCalls = 0;
    let reads = 0;
    const delegate: SpanExporter = {
      export: (_spans, callback) => {
        delegateCalls += 1;
        callback({ code: 0 });
      },
      shutdown: async () => undefined,
    };
    const exporter = createPrivacySafeSpanExporter({
      delegate,
      getSnapshot: () => {
        reads += 1;
        return snapshot(reads === 1);
      },
    });

    await expect(exportSpans(exporter, [unsafeSpan()])).resolves.toEqual({ code: 0 });

    expect(reads).toBe(2);
    expect(delegateCalls).toBe(0);
  });

  it("latches an old automatic-span exporter off across off then on and lets a new exporter adopt the revision", async () => {
    let current = snapshot(true, 30);
    let delegateCalls = 0;
    const delegate: SpanExporter = {
      export: (_spans, callback) => { delegateCalls += 1; callback({ code: 0 }); },
      shutdown: async () => undefined,
    };
    const oldExporter = createPrivacySafeSpanExporter({ delegate, getSnapshot: () => current });

    current = snapshot(true, 32);
    await exportSpans(oldExporter, [unsafeSpan()]);
    current = snapshot(true, 30);
    await exportSpans(oldExporter, [unsafeSpan()]);
    expect(delegateCalls).toBe(0);

    current = snapshot(true, 32);
    const newExporter = createPrivacySafeSpanExporter({ delegate, getSnapshot: () => current });
    await exportSpans(newExporter, [unsafeSpan()]);
    expect(delegateCalls).toBe(1);
  });

  it("contains synchronous and callback delegate failures without forwarding raw errors", async () => {
    const thrown = createPrivacySafeSpanExporter({
      delegate: {
        export() {
          throw new Error(PRIVATE_CANARY);
        },
        shutdown: async () => undefined,
      },
      getSnapshot: () => snapshot(),
    });
    const callbackFailure = createPrivacySafeSpanExporter({
      delegate: {
        export(_spans, callback) {
          callback({ code: 1, error: new Error(PRIVATE_CANARY) });
        },
        shutdown: async () => undefined,
      },
      getSnapshot: () => snapshot(),
    });

    await expect(exportSpans(thrown, [unsafeSpan()])).resolves.toEqual({ code: 1 });
    await expect(exportSpans(callbackFailure, [unsafeSpan()])).resolves.toEqual({ code: 1 });
  });

  it("fails closed within a deadline when a delegate never invokes its callback", async () => {
    vi.useFakeTimers();
    try {
      const exporter = createPrivacySafeSpanExporter({
        delegate: {
          export: () => undefined,
          shutdown: async () => undefined,
        },
        getSnapshot: () => snapshot(),
        exportTimeoutMillis: 10,
      });

      const result = exportSpans(exporter, [unsafeSpan()]);
      await vi.advanceTimersByTimeAsync(11);

      await expect(result).resolves.toEqual({ code: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("privacy-safe log exporter", () => {
  it("rebuilds a log from a fixed body and separately trusted diagnostic identity", async () => {
    const delegated: ReadableLogRecord[][] = [];
    const delegate: LogRecordExporter = {
      export(logs, callback) {
        delegated.push(logs);
        callback({ code: 0 });
      },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    };
    const candidate = unsafeLog();
    const exporter = createPrivacySafeLogExporter({
      delegate,
      getSnapshot: () => snapshot(),
      getDiagnosticId: record => record === candidate ? DIAGNOSTIC_ID : undefined,
    });

    await expect(exportLogs(exporter, [candidate])).resolves.toEqual({ code: 0 });

    expect(delegated).toHaveLength(1);
    const safe = delegated[0]![0]!;
    expect(safe).not.toBe(candidate);
    expect(safe.hrTime).toEqual([1_800_000_000, 250_000_000]);
    expect(safe.hrTimeObserved).toEqual([1_800_000_000, 250_000_000]);
    expect(safe.spanContext).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED });
    expect(safe.severityText).toBe("WARN");
    expect(safe.severityNumber).toBe(SeverityNumber.WARN);
    expect(safe.body).toBe("account.setup.diagnostic");
    expect(safe.eventName).toBeUndefined();
    expect(safe.resource.attributes).toEqual({
      "service.name": "cc-router",
      "service.version": "0.8.2",
      "service.instance.id": INSTALL_ID,
      "process.runtime.version": "22.18.0",
      "os.type": "macos",
      "host.arch": "arm64",
      "cc_router.runtime_mode": "daemon",
    });
    expect(safe.instrumentationScope).toEqual({ name: "cc-router" });
    expect(safe.attributes).toEqual({
      "cc_router.provider": "openai",
      "cc_router.method": "device_oauth",
      "cc_router.stage": "token_exchange",
      "cc_router.reason": "unauthorized",
      "cc_router.outcome": "upstream_error",
      "http.response.status_code": 401,
      "cc_router.duration_bucket": "5s_to_30s",
      "service.version": "0.8.2",
      "os.type": "macos",
      "cc_router.runtime_mode": "foreground",
      "cc_router.diagnostic_id": DIAGNOSTIC_ID,
    });
    expect(safe.droppedAttributesCount).toBe(0);
    expect(JSON.stringify(safe)).not.toContain(PRIVATE_CANARY);
    expect(JSON.stringify(safe)).not.toContain(CANDIDATE_ID);
  });

  it("drops setup logs whose scope or diagnostic identity is not independently trusted", async () => {
    let delegateCalls = 0;
    const delegate: LogRecordExporter = {
      export: (_logs, callback) => {
        delegateCalls += 1;
        callback({ code: 0 });
      },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    };
    const exporter = createPrivacySafeLogExporter({
      delegate,
      getSnapshot: () => snapshot(),
      getDiagnosticId: () => undefined,
    });

    await expect(exportLogs(exporter, [
      unsafeLog({ instrumentationScope: { name: "unknown-library" } }),
      unsafeLog(),
    ])).resolves.toEqual({ code: 0 });

    expect(delegateCalls).toBe(0);
  });

  it("caps every delegated log batch at the configured safe maximum", async () => {
    const delegated: ReadableLogRecord[][] = [];
    const delegate: LogRecordExporter = {
      export(logs, callback) {
        delegated.push(logs);
        callback({ code: 0 });
      },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    };
    const exporter = createPrivacySafeLogExporter({
      delegate,
      getSnapshot: () => snapshot(),
      getDiagnosticId: () => DIAGNOSTIC_ID,
      maxBatchSize: 2,
    });

    await exportLogs(exporter, [unsafeLog(), unsafeLog(), unsafeLog()]);

    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toHaveLength(2);
  });

  it("does not flush a log delegate after telemetry is disabled", async () => {
    let flushes = 0;
    const delegate: LogRecordExporter = {
      export: (_logs, callback) => callback({ code: 0 }),
      forceFlush: async () => {
        flushes += 1;
      },
      shutdown: async () => undefined,
    };
    const exporter = createPrivacySafeLogExporter({
      delegate,
      getSnapshot: () => snapshot(false),
      getDiagnosticId: () => DIAGNOSTIC_ID,
    });

    await exporter.forceFlush();

    expect(flushes).toBe(0);
  });

  it("drops a reconstructed queued log batch when telemetry turns off before delegation", async () => {
    let delegateCalls = 0;
    let reads = 0;
    const delegate: LogRecordExporter = {
      export: (_logs, callback) => {
        delegateCalls += 1;
        callback({ code: 0 });
      },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    };
    const exporter = createPrivacySafeLogExporter({
      delegate,
      getSnapshot: () => {
        reads += 1;
        return snapshot(reads === 1);
      },
      getDiagnosticId: () => DIAGNOSTIC_ID,
    });

    await expect(exportLogs(exporter, [unsafeLog()])).resolves.toEqual({ code: 0 });

    expect(reads).toBe(2);
    expect(delegateCalls).toBe(0);
  });

  it("latches an old log exporter off across off then on and lets a new exporter adopt the revision", async () => {
    let current = snapshot(true, 40);
    let delegateCalls = 0;
    const delegate: LogRecordExporter = {
      export: (_logs, callback) => { delegateCalls += 1; callback({ code: 0 }); },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    };
    const oldExporter = createPrivacySafeLogExporter({
      delegate,
      getSnapshot: () => current,
      getDiagnosticId: () => DIAGNOSTIC_ID,
    });

    current = snapshot(true, 42);
    await exportLogs(oldExporter, [unsafeLog()]);
    current = snapshot(true, 40);
    await exportLogs(oldExporter, [unsafeLog()]);
    expect(delegateCalls).toBe(0);

    current = snapshot(true, 42);
    const newExporter = createPrivacySafeLogExporter({
      delegate,
      getSnapshot: () => current,
      getDiagnosticId: () => DIAGNOSTIC_ID,
    });
    await exportLogs(newExporter, [unsafeLog()]);
    expect(delegateCalls).toBe(1);
  });

  it("contains synchronous and callback log delegate failures without forwarding raw errors", async () => {
    const thrown = createPrivacySafeLogExporter({
      delegate: {
        export() {
          throw new Error(PRIVATE_CANARY);
        },
        forceFlush: async () => undefined,
        shutdown: async () => undefined,
      },
      getSnapshot: () => snapshot(),
      getDiagnosticId: () => DIAGNOSTIC_ID,
    });
    const callbackFailure = createPrivacySafeLogExporter({
      delegate: {
        export(_logs, callback) {
          callback({ code: 1, error: new Error(PRIVATE_CANARY) });
        },
        forceFlush: async () => undefined,
        shutdown: async () => undefined,
      },
      getSnapshot: () => snapshot(),
      getDiagnosticId: () => DIAGNOSTIC_ID,
    });

    await expect(exportLogs(thrown, [unsafeLog()])).resolves.toEqual({ code: 1 });
    await expect(exportLogs(callbackFailure, [unsafeLog()])).resolves.toEqual({ code: 1 });
  });

  it("bounds log force-flush and shutdown when the delegate never settles", async () => {
    vi.useFakeTimers();
    try {
      const delegate: LogRecordExporter = {
        export: () => undefined,
        forceFlush: () => new Promise<void>(() => undefined),
        shutdown: () => new Promise<void>(() => undefined),
      };
      const exporter = createPrivacySafeLogExporter({
        delegate,
        getSnapshot: () => snapshot(),
        getDiagnosticId: () => DIAGNOSTIC_ID,
        lifecycleTimeoutMillis: 10,
      });

      let flushSettled = false;
      const flush = exporter.forceFlush().then(() => {
        flushSettled = true;
      });
      await vi.advanceTimersByTimeAsync(9);
      expect(flushSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(flushSettled).toBe(true);
      await expect(flush).resolves.toBeUndefined();

      let shutdownSettled = false;
      const shutdown = exporter.shutdown().then(() => {
        shutdownSettled = true;
      });
      await vi.advanceTimersByTimeAsync(9);
      expect(shutdownSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(shutdownSettled).toBe(true);
      await expect(shutdown).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed within a deadline when a log delegate never invokes its callback", async () => {
    vi.useFakeTimers();
    try {
      const exporter = createPrivacySafeLogExporter({
        delegate: {
          export: () => undefined,
          forceFlush: async () => undefined,
          shutdown: async () => undefined,
        },
        getSnapshot: () => snapshot(),
        getDiagnosticId: () => DIAGNOSTIC_ID,
        exportTimeoutMillis: 10,
      });

      let resultCode: number | undefined;
      const result = exportLogs(exporter, [unsafeLog()]).then(value => {
        resultCode = value.code;
        return value;
      });
      await vi.advanceTimersByTimeAsync(9);
      expect(resultCode).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      expect(resultCode).toBe(1);

      await expect(result).resolves.toEqual({ code: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("official PostHog EU OTLP delegates", () => {
  it("serializes safe protobuf traces and documented JSON logs through loopback endpoints", async () => {
    const traceCapture = await startTransportCaptureServer();
    const logCapture = await startTransportCaptureServer();
    const log = unsafeLog();
    const span = unsafeSpan();
    const exporters = createPostHogOtlpExporters({
      traceUrl: traceCapture.endpoint("/i/v1/traces"),
      logUrl: logCapture.endpoint("/i/v1/logs"),
      getSnapshot: () => snapshot(),
      getDiagnosticId: record => record === log ? DIAGNOSTIC_ID : undefined,
      requestTimeoutMillis: 500,
    });

    try {
      const spanCanaries = span.attributes["private.canaries"];
      const logCanaries = log.attributes["private.canaries"];
      for (const canary of Object.values(TELEMETRY_CANARY)) {
        expect(spanCanaries).toContain(canary);
        expect(logCanaries).toContain(canary);
      }

      await expect(exportSpans(exporters.spanExporter, [span])).resolves.toEqual({ code: 0 });
      await expect(exportLogs(exporters.logExporter, [log])).resolves.toEqual({ code: 0 });

      expect(traceCapture.requests).toHaveLength(1);
      expect(logCapture.requests).toHaveLength(1);
      const traceRequest = traceCapture.requests[0]!;
      const logRequest = logCapture.requests[0]!;
      expect(traceRequest.method).toBe("POST");
      expect(traceRequest.url).toBe("/i/v1/traces");
      expect(traceRequest.headers["content-type"]).toBe("application/x-protobuf");
      expect(traceRequest.headers.authorization).toMatch(/^Bearer phc_[0-9A-Za-z]+$/);
      expect(logRequest.method).toBe("POST");
      expect(logRequest.url).toBe("/i/v1/logs");
      expect(logRequest.headers["content-type"]).toBe("application/json");
      expect(logRequest.headers.authorization).toMatch(/^Bearer phc_[0-9A-Za-z]+$/);

      const traceBytes = traceRequest.rawBody.toString("utf8");
      const logBytes = logRequest.rawBody.toString("utf8");
      expect(traceBytes).toContain("proxy.request");
      expect(traceBytes).toContain(INSTALL_ID);
      expect(logBytes).toContain("account.setup.diagnostic");
      expect(logBytes).toContain(INSTALL_ID);
      expect(logBytes).toContain(DIAGNOSTIC_ID);
      for (const forbidden of [
        PRIVATE_CANARY,
        ...Object.values(TELEMETRY_CANARY),
        CANDIDATE_ID,
      ]) {
        expect(traceBytes).not.toContain(forbidden);
        expect(logBytes).not.toContain(JSON.stringify(forbidden).slice(1, -1));
      }
    } finally {
      await exporters.spanExporter.shutdown();
      await exporters.logExporter.shutdown();
      await traceCapture.close();
      await logCapture.close();
    }
  });
});
