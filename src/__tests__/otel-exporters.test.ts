import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import type { TelemetrySnapshot } from "../config/telemetry.js";
import { createPostHogOtlpExporters } from "../telemetry/otel-exporters.js";
import { startTransportCaptureServer, TELEMETRY_CANARY, type TransportCaptureServer } from "./telemetry-test-helpers.js";

const INSTALL_ID = "70d8062e-1fa0-4ae4-a115-bf782ecca462";
const CANDIDATE_ID = "916ce1d6-2e8d-48b2-a70e-0337bdf82df7";
const DIAGNOSTIC_ID = "ad94f035-1e08-4e29-8517-fd56bdc83d99";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "0123456789abcdef";
const PARENT_SPAN_ID = "fedcba9876543210";
const PRIVATE_CANARY = "PRIVATE prompt token@example.test /Users/alice ?secret=true";
const CONSENT_GENERATION = "123e4567-e89b-42d3-a456-426614174010";

function snapshot(enabled = true): TelemetrySnapshot {
  return {
    state: {
      enabled,
      installId: INSTALL_ID,
      firstRunAt: "2026-08-03T00:00:00.000Z",
      consentGeneration: CONSENT_GENERATION,
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
    links: [{
      context: { traceId: TRACE_ID, spanId: PARENT_SPAN_ID, traceFlags: 1 },
      attributes: { prompt: PRIVATE_CANARY },
    }],
    events: [{
      name: PRIVATE_CANARY,
      time: [1_800_000_000, 0],
      attributes: { prompt: PRIVATE_CANARY },
      droppedAttributesCount: 0,
    }],
    ended: true,
    resource: unsafeResource(),
    instrumentationScope: { name: "cc-router", version: PRIVATE_CANARY },
    droppedAttributesCount: 9,
    droppedEventsCount: 8,
    droppedLinksCount: 7,
  };
  return { ...candidate, ...overrides };
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
      "cc_router.diagnostic_id": DIAGNOSTIC_ID,
      prompt: PRIVATE_CANARY,
      error: PRIVATE_CANARY,
      "private.canaries": Object.values(TELEMETRY_CANARY),
    },
    droppedAttributesCount: 8,
  };
  return { ...candidate, ...overrides };
}

function exportSpans(exporter: SpanExporter, spans: ReadableSpan[]): Promise<{ code: number }> {
  return new Promise(resolve => exporter.export(spans, resolve));
}

function exportLogs(exporter: LogRecordExporter, logs: ReadableLogRecord[]): Promise<{ code: number }> {
  return new Promise(resolve => exporter.export(logs, resolve));
}

const openServers: TransportCaptureServer[] = [];

async function capture(options?: Parameters<typeof startTransportCaptureServer>[0]) {
  const server = await startTransportCaptureServer(options);
  openServers.push(server);
  return server;
}

async function exporters(getSnapshot: () => TelemetrySnapshot | undefined, options?: {
  responseMode?: "success" | "reset" | "unavailable";
}) {
  const traces = await capture(options);
  const logs = await capture(options);
  return {
    traces,
    logs,
    ...createPostHogOtlpExporters({
      getSnapshot,
      traceUrl: traces.endpoint("/i/v1/traces"),
      logUrl: logs.endpoint("/i/v1/logs"),
    }),
  };
}

/** OTLP http/json log payloads stay readable, so assert on their records. */
function exportedLogRecords(body: unknown): Record<string, unknown>[] {
  const resourceLogs = (body as { resourceLogs?: { scopeLogs?: { logRecords?: unknown[] }[] }[] }).resourceLogs ?? [];
  return resourceLogs.flatMap(resource => (resource.scopeLogs ?? [])
    .flatMap(scope => (scope.logRecords ?? []) as Record<string, unknown>[]));
}

afterEach(async () => {
  const servers = openServers.splice(0, openServers.length);
  await Promise.all(servers.map(server => server.close()));
});

describe("consent-gated PostHog OTLP exporters", () => {
  it("sends spans rebuilt from the closed schema to the EU trace endpoint", async () => {
    const { traces, spanExporter } = await exporters(() => snapshot());

    await expect(exportSpans(spanExporter, [unsafeSpan()])).resolves.toEqual({ code: 0 });

    expect(traces.requests).toHaveLength(1);
    const request = traces.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/i/v1/traces");
    expect(request.headers["content-type"]).toBe("application/x-protobuf");
    expect(request.headers.authorization).toMatch(/^Bearer phc_[0-9A-Za-z]+$/);

    const wire = request.rawBody.toString("utf8");
    expect(wire).toContain("proxy.request");
    expect(wire).toContain(INSTALL_ID);
    expect(wire).toContain("cc_router.model_family");
    for (const forbidden of [PRIVATE_CANARY, CANDIDATE_ID, "url.full", "prompt", ...Object.values(TELEMETRY_CANARY)]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it("sends logs rebuilt from the fixed body and allowlisted attributes only", async () => {
    const { logs, logExporter } = await exporters(() => snapshot());

    await expect(exportLogs(logExporter, [unsafeLog()])).resolves.toEqual({ code: 0 });

    expect(logs.requests).toHaveLength(1);
    const request = logs.requests[0]!;
    expect(request.url).toBe("/i/v1/logs");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers.authorization).toMatch(/^Bearer phc_[0-9A-Za-z]+$/);

    const records = exportedLogRecords(request.json);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.body).toEqual({ stringValue: "account.setup.diagnostic" });
    expect(record.severityText).toBe("WARN");
    expect(record.traceId).toBe(TRACE_ID);
    expect(record.spanId).toBe(SPAN_ID);
    const attributeKeys = (record.attributes as { key: string }[]).map(attribute => attribute.key).sort();
    expect(attributeKeys).toEqual([
      "cc_router.diagnostic_id",
      "cc_router.duration_bucket",
      "cc_router.method",
      "cc_router.outcome",
      "cc_router.provider",
      "cc_router.reason",
      "cc_router.runtime_mode",
      "cc_router.stage",
      "http.response.status_code",
      "os.type",
      "service.version",
    ]);

    const wire = request.rawBody.toString("utf8");
    expect(wire).toContain(INSTALL_ID);
    expect(wire).toContain(DIAGNOSTIC_ID);
    for (const forbidden of [PRIVATE_CANARY, CANDIDATE_ID, ...Object.values(TELEMETRY_CANARY)]) {
      expect(wire).not.toContain(JSON.stringify(forbidden).slice(1, -1));
    }
  });

  it("drops every record without contacting the network while consent is withdrawn", async () => {
    const { traces, logs, spanExporter, logExporter } = await exporters(() => undefined);

    await expect(exportSpans(spanExporter, [unsafeSpan()])).resolves.toEqual({ code: 0 });
    await expect(exportLogs(logExporter, [unsafeLog()])).resolves.toEqual({ code: 0 });
    await spanExporter.forceFlush?.();
    await logExporter.forceFlush();

    expect(traces.requests).toHaveLength(0);
    expect(logs.requests).toHaveLength(0);
  });

  it("drops a rebuilt batch when consent disappears during reconstruction", async () => {
    let reads = 0;
    const { traces, spanExporter } = await exporters(() => {
      reads += 1;
      return reads === 1 ? snapshot() : undefined;
    });

    await expect(exportSpans(spanExporter, [unsafeSpan()])).resolves.toEqual({ code: 0 });

    expect(reads).toBe(2);
    expect(traces.requests).toHaveLength(0);
  });

  it("drops unknown scopes and malformed records without contacting the network", async () => {
    const { traces, logs, spanExporter, logExporter } = await exporters(() => snapshot());

    await expect(exportSpans(spanExporter, [
      unsafeSpan({ instrumentationScope: { name: "unknown-library" } }),
      unsafeSpan({ resource: resourceFromAttributes({ "service.name": "wrong-service" }) }),
      unsafeSpan({ attributes: { "cc_router.operation": "/v1/messages/private" } }),
    ])).resolves.toEqual({ code: 0 });
    await expect(exportLogs(logExporter, [
      unsafeLog({ instrumentationScope: { name: "unknown-library" } }),
      unsafeLog({ body: "raw user message" }),
      unsafeLog({ attributes: { ...unsafeLog().attributes, "cc_router.diagnostic_id": INSTALL_ID } }),
    ])).resolves.toEqual({ code: 0 });

    expect(traces.requests).toHaveLength(0);
    expect(logs.requests).toHaveLength(0);
  });

  it("caps every delegated batch at the fixed safe maximum", async () => {
    const { logs, logExporter } = await exporters(() => snapshot());

    await exportLogs(logExporter, Array.from({ length: 150 }, () => unsafeLog()));

    expect(logs.requests).toHaveLength(1);
    expect(exportedLogRecords(logs.requests[0]!.json)).toHaveLength(100);
  });

  it("fails closed without forwarding raw delegate errors", async () => {
    const { spanExporter, logExporter } = await exporters(() => snapshot(), { responseMode: "reset" });

    await expect(exportSpans(spanExporter, [unsafeSpan()])).resolves.toEqual({ code: 1 });
    await expect(exportLogs(logExporter, [unsafeLog()])).resolves.toEqual({ code: 1 });
  });

  it("sends one request per export and never retries a rejected batch", async () => {
    const { traces, logs, spanExporter, logExporter } = await exporters(() => snapshot(), { responseMode: "unavailable" });

    // A 503 is what the stock OTLP exporters retry after a backoff (a second
    // transmission that would skip the consent check); the consent-gated
    // transport reports a plain failure and sends nothing twice.
    await expect(exportSpans(spanExporter, [unsafeSpan()])).resolves.toEqual({ code: 1 });
    await expect(exportLogs(logExporter, [unsafeLog()])).resolves.toEqual({ code: 1 });

    expect(traces.requests).toHaveLength(1);
    expect(logs.requests).toHaveLength(1);
  });

  it("settles shutdown even after the endpoint is gone", async () => {
    const { traces, logs, spanExporter, logExporter } = await exporters(() => snapshot());
    await traces.close();
    await logs.close();
    openServers.splice(0, openServers.length);

    await expect(spanExporter.shutdown()).resolves.toBeUndefined();
    await expect(logExporter.shutdown()).resolves.toBeUndefined();
  });
});
