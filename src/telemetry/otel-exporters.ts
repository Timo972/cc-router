import { SpanKind, SpanStatusCode, TraceFlags, type HrTime } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  ExporterMetrics,
  OTLPExporterBase,
  createOtlpNetworkExportDelegate,
  type ExportResponse,
  type IExporterTransport,
} from "@opentelemetry/otlp-exporter-base";
import {
  JsonLogsSerializer,
  LogsExporterMetricsHelper,
  ProtobufTraceSerializer,
  TraceExporterMetricsHelper,
  type IExporterMetricsHelper,
  type ISerializer,
} from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { TelemetrySnapshot } from "../config/telemetry.js";
import {
  POSTHOG_HOST,
  POSTHOG_PROJECT_TOKEN,
  POSTHOG_REQUEST_TIMEOUT_MS,
  type SafeLog,
  type SafeResource,
  type SafeSpan,
  type Severity,
} from "./contracts.js";
import {
  fromOtelAttributes,
  LOG_ATTRIBUTE_KEYS,
  RESOURCE_ATTRIBUTE_KEYS,
  reconstructLog,
  reconstructResource,
  reconstructSpan,
  SPAN_ATTRIBUTE_KEYS,
  toOtelAttributes,
} from "./privacy.js";

export interface PostHogOtlpExporterOptions {
  /** Consent gate: undefined means "export nothing, contact nothing". */
  getSnapshot: () => TelemetrySnapshot | undefined;
  traceUrl?: string;
  logUrl?: string;
}

export interface PostHogOtlpExporters {
  spanExporter: SpanExporter;
  logExporter: LogRecordExporter;
}

const SUCCESS = { code: 0 } as const;
const FAILED = { code: 1 } as const;
const EXPORT_TIMEOUT_MS = POSTHOG_REQUEST_TIMEOUT_MS;
const LIFECYCLE_TIMEOUT_MS = 2_000;
const MAX_BATCH_SIZE = 100;
const POSTHOG_TRACE_URL = `${POSTHOG_HOST}/i/v1/traces`;
const POSTHOG_LOG_URL = `${POSTHOG_HOST}/i/v1/logs`;

type ExportCallback = (result: typeof SUCCESS | typeof FAILED) => void;

interface Delegate<T> {
  export(records: T[], callback: (result: { code: number }) => void): void;
  forceFlush?(): Promise<void>;
  shutdown(): Promise<void>;
}

function own(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

async function settleWithin(operation: () => Promise<void> | void, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation).catch(() => undefined),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Telemetry lifecycle failures are isolated from application behavior.
  } finally {
    clearTimeout(timer);
  }
}

function hrTimeToMilliseconds(time: HrTime): number {
  return time[0] * 1_000 + time[1] / 1_000_000;
}

function millisecondsToHrTime(milliseconds: number): HrTime {
  const seconds = Math.floor(milliseconds / 1_000);
  return [seconds, Math.round((milliseconds - seconds * 1_000) * 1_000_000)];
}

function spanKindName(kind: SpanKind): string | undefined {
  switch (kind) {
    case SpanKind.INTERNAL: return "internal";
    case SpanKind.SERVER: return "server";
    case SpanKind.CLIENT: return "client";
    default: return undefined;
  }
}

function otelSpanKind(kind: SafeSpan["kind"]): SpanKind {
  switch (kind) {
    case "internal": return SpanKind.INTERNAL;
    case "server": return SpanKind.SERVER;
    case "client": return SpanKind.CLIENT;
  }
}

function spanStatusName(code: SpanStatusCode): string | undefined {
  switch (code) {
    case SpanStatusCode.UNSET: return "unset";
    case SpanStatusCode.OK: return "ok";
    case SpanStatusCode.ERROR: return "error";
    default: return undefined;
  }
}

function otelSpanStatus(code: SafeSpan["statusCode"]): SpanStatusCode {
  switch (code) {
    case "unset": return SpanStatusCode.UNSET;
    case "ok": return SpanStatusCode.OK;
    case "error": return SpanStatusCode.ERROR;
  }
}

function severityName(value: SeverityNumber | undefined): Severity | undefined {
  switch (value) {
    case SeverityNumber.INFO: return "info";
    case SeverityNumber.WARN: return "warn";
    case SeverityNumber.ERROR: return "error";
    case SeverityNumber.FATAL: return "fatal";
    default: return undefined;
  }
}

function otelSeverity(value: Severity): { text: string; number: SeverityNumber } {
  switch (value) {
    case "info": return { text: "INFO", number: SeverityNumber.INFO };
    case "warn": return { text: "WARN", number: SeverityNumber.WARN };
    case "error": return { text: "ERROR", number: SeverityNumber.ERROR };
    case "fatal": return { text: "FATAL", number: SeverityNumber.FATAL };
  }
}

function safeResource(candidate: Resource, installationId: string): SafeResource | undefined {
  return reconstructResource(
    fromOtelAttributes(RESOURCE_ATTRIBUTE_KEYS, candidate.attributes),
    { installationId },
  );
}

function rebuildSpan(candidate: ReadableSpan, snapshot: TelemetrySnapshot): ReadableSpan | undefined {
  try {
    const context = candidate.spanContext();
    const resource = safeResource(candidate.resource, snapshot.state.installId);
    const safe = reconstructSpan({
      scope: candidate.instrumentationScope.name,
      operation: own(candidate.attributes, "cc_router.operation"),
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: candidate.parentSpanContext?.spanId,
      kind: spanKindName(candidate.kind),
      startTimeMs: hrTimeToMilliseconds(candidate.startTime),
      durationMs: hrTimeToMilliseconds(candidate.duration),
      statusCode: spanStatusName(candidate.status.code),
      attributes: fromOtelAttributes(SPAN_ATTRIBUTE_KEYS, candidate.attributes),
    });
    if (!resource || !safe) return undefined;
    return newReadableSpan(safe, resource);
  } catch {
    return undefined;
  }
}

function newReadableSpan(safe: SafeSpan, resource: SafeResource): ReadableSpan {
  const spanContext = { traceId: safe.traceId, spanId: safe.spanId, traceFlags: TraceFlags.SAMPLED };
  return {
    name: safe.name,
    kind: otelSpanKind(safe.kind),
    spanContext: () => ({ ...spanContext }),
    ...(safe.parentSpanId === undefined ? {} : {
      parentSpanContext: {
        traceId: safe.traceId,
        spanId: safe.parentSpanId,
        traceFlags: TraceFlags.SAMPLED,
      },
    }),
    startTime: millisecondsToHrTime(safe.startTimeMs),
    endTime: millisecondsToHrTime(safe.startTimeMs + safe.durationMs),
    duration: millisecondsToHrTime(safe.durationMs),
    status: { code: otelSpanStatus(safe.statusCode) },
    attributes: toOtelAttributes(SPAN_ATTRIBUTE_KEYS, safe.attributes),
    links: [],
    events: [],
    ended: true,
    resource: resourceFromAttributes({ ...resource }),
    instrumentationScope: { name: safe.scope },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

function rebuildLog(candidate: ReadableLogRecord, snapshot: TelemetrySnapshot): ReadableLogRecord | undefined {
  try {
    const resource = safeResource(candidate.resource, snapshot.state.installId);
    // The diagnostic id is a per-attempt random UUID; reconstructLog still
    // validates it and rejects anything equal to the install identity.
    const diagnosticId = own(candidate.attributes, LOG_ATTRIBUTE_KEYS.diagnosticId as string);
    const safe = reconstructLog({
      scope: candidate.instrumentationScope.name,
      body: candidate.body,
      severity: severityName(candidate.severityNumber),
      timestampMs: hrTimeToMilliseconds(candidate.hrTime),
      traceId: candidate.spanContext?.traceId,
      spanId: candidate.spanContext?.spanId,
      attributes: fromOtelAttributes(LOG_ATTRIBUTE_KEYS, candidate.attributes),
    }, {
      installationId: snapshot.state.installId,
      ...(typeof diagnosticId === "string" ? { diagnosticId } : {}),
    });
    if (!resource || !safe) return undefined;
    return newReadableLog(safe, resource);
  } catch {
    return undefined;
  }
}

function newReadableLog(safe: SafeLog, resource: SafeResource): ReadableLogRecord {
  const severity = otelSeverity(safe.severity);
  const hrTime = millisecondsToHrTime(safe.timestampMs);
  return {
    hrTime,
    hrTimeObserved: [...hrTime],
    ...(safe.traceId && safe.spanId
      ? { spanContext: { traceId: safe.traceId, spanId: safe.spanId, traceFlags: TraceFlags.SAMPLED } }
      : {}),
    severityText: severity.text,
    severityNumber: severity.number,
    body: safe.body,
    resource: resourceFromAttributes({ ...resource }),
    instrumentationScope: { name: safe.scope },
    attributes: toOtelAttributes(LOG_ATTRIBUTE_KEYS, safe.attributes),
    droppedAttributesCount: 0,
  };
}

/**
 * Wrap an OTLP delegate so nothing reaches the network unless consent still
 * holds, and only records rebuilt from the closed allowlist are handed over.
 */
function gatedExporter<T>(
  getSnapshot: () => TelemetrySnapshot | undefined,
  rebuild: (record: T, snapshot: TelemetrySnapshot) => T | undefined,
  delegate: Delegate<T>,
) {
  return {
    export(records: T[], callback: ExportCallback): void {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: typeof SUCCESS | typeof FAILED): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(result);
      };
      try {
        const snapshot = getSnapshot();
        if (!snapshot) {
          settle(SUCCESS);
          return;
        }
        const safe = records.slice(0, MAX_BATCH_SIZE).flatMap(record => {
          const rebuilt = rebuild(record, snapshot);
          return rebuilt ? [rebuilt] : [];
        });
        // Re-check: an opt-out during reconstruction must still drop the batch.
        if (safe.length === 0 || !getSnapshot()) {
          settle(SUCCESS);
          return;
        }
        timer = setTimeout(() => settle(FAILED), EXPORT_TIMEOUT_MS);
        timer.unref?.();
        delegate.export(safe, result => settle(result.code === 0 ? SUCCESS : FAILED));
      } catch {
        settle(FAILED);
      }
    },
    async forceFlush(): Promise<void> {
      if (!getSnapshot()) return;
      await settleWithin(() => delegate.forceFlush?.(), LIFECYCLE_TIMEOUT_MS);
    },
    async shutdown(): Promise<void> {
      await settleWithin(() => delegate.shutdown(), LIFECYCLE_TIMEOUT_MS);
    },
  };
}

/**
 * One HTTP POST per export, consent re-read immediately before it. The SDK's
 * stock exporters wrap their transport in a retrying layer that would resend a
 * batch after a 503 without consulting consent again; this transport never
 * reports a retryable result, so nothing is transmitted twice.
 */
function consentGatedTransport(
  url: string,
  contentType: string,
  getSnapshot: () => TelemetrySnapshot | undefined,
): IExporterTransport {
  return {
    async send(data: Uint8Array, timeoutMillis: number): Promise<ExportResponse> {
      if (!getSnapshot()?.enabled) return { status: "success" };
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": contentType,
            authorization: `Bearer ${POSTHOG_PROJECT_TOKEN}`,
          },
          body: new Uint8Array(data),
          signal: AbortSignal.timeout(Math.max(1, timeoutMillis)),
        });
        if (response.ok) return { status: "success" };
        return { status: "failure", error: new Error(`OTLP export rejected with HTTP ${response.status}`) };
      } catch {
        // The raw transport error may name hosts or addresses; it stays local.
        return { status: "failure", error: new Error("OTLP export failed") };
      }
    },
    shutdown(): void {},
  };
}

function otlpExporter<Internal, Response>(
  url: string,
  contentType: string,
  serializer: ISerializer<Internal, Response>,
  metricsHelper: IExporterMetricsHelper<Internal>,
  getSnapshot: () => TelemetrySnapshot | undefined,
): OTLPExporterBase<Internal> {
  const options = { timeoutMillis: POSTHOG_REQUEST_TIMEOUT_MS, concurrencyLimit: 1, compression: "none" as const };
  return new OTLPExporterBase(createOtlpNetworkExportDelegate(
    options,
    serializer,
    new ExporterMetrics({
      componentType: "cc_router_otlp_exporter",
      metricsHelper,
      url,
      meterProvider: undefined,
      responseAttributesFromError: () => ({}),
    }),
    consentGatedTransport(url, contentType, getSnapshot),
  ));
}

export function createPostHogOtlpExporters(options: PostHogOtlpExporterOptions): PostHogOtlpExporters {
  const traceUrl = options.traceUrl ?? POSTHOG_TRACE_URL;
  const logUrl = options.logUrl ?? POSTHOG_LOG_URL;
  return {
    spanExporter: gatedExporter(
      options.getSnapshot,
      rebuildSpan,
      otlpExporter(traceUrl, "application/x-protobuf", ProtobufTraceSerializer, TraceExporterMetricsHelper, options.getSnapshot),
    ),
    logExporter: gatedExporter(
      options.getSnapshot,
      rebuildLog,
      otlpExporter(logUrl, "application/json", JsonLogsSerializer, LogsExporterMetricsHelper, options.getSnapshot),
    ),
  };
}
