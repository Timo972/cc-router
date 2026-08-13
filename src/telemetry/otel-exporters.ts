import { SpanKind, SpanStatusCode, TraceFlags, type Attributes, type HrTime } from "@opentelemetry/api";
import { SeverityNumber, type LogAttributes } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { getTelemetrySnapshot, type TelemetrySnapshot } from "../config/telemetry.js";
import type {
  SafeLog,
  SafeResource,
  SafeRuntimeFailureAttributes,
  SafeSetupDiagnosticAttributes,
  SafeSpan,
  SafeSpanAttributes,
  Severity,
} from "./contracts.js";
import {
  POSTHOG_HOST,
  POSTHOG_PROJECT_TOKEN,
  POSTHOG_REQUEST_TIMEOUT_MS,
} from "./constants.js";
import { reconstructLog, reconstructResource, reconstructSpan } from "./privacy.js";

interface PrivacySafeExporterOptions<T> {
  delegate: T;
  getSnapshot?: () => TelemetrySnapshot;
  exportTimeoutMillis?: number;
  lifecycleTimeoutMillis?: number;
  maxBatchSize?: number;
}

interface PrivacySafeLogExporterOptions extends PrivacySafeExporterOptions<LogRecordExporter> {
  getDiagnosticId?: (record: ReadableLogRecord) => string | undefined;
}

export interface PostHogOtlpExporterOptions {
  getSnapshot?: () => TelemetrySnapshot;
  getDiagnosticId?: (record: ReadableLogRecord) => string | undefined;
  traceUrl?: string;
  logUrl?: string;
  requestTimeoutMillis?: number;
  exportTimeoutMillis?: number;
  lifecycleTimeoutMillis?: number;
  maxBatchSize?: number;
}

export interface PostHogOtlpExporters {
  spanExporter: SpanExporter;
  logExporter: LogRecordExporter;
}

export type PostHogOtlpLogExporterOptions = Pick<
  PostHogOtlpExporterOptions,
  | "getSnapshot"
  | "getDiagnosticId"
  | "logUrl"
  | "requestTimeoutMillis"
  | "exportTimeoutMillis"
  | "lifecycleTimeoutMillis"
  | "maxBatchSize"
>;

const SUCCESS = { code: 0 } as const;
const FAILED = { code: 1 } as const;
const DEFAULT_LIFECYCLE_TIMEOUT_MILLIS = 2_000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const POSTHOG_TRACE_URL = `${POSTHOG_HOST}/i/v1/traces`;
const POSTHOG_LOG_URL = `${POSTHOG_HOST}/i/v1/logs`;

function own(input: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeSnapshot(getSnapshot: () => TelemetrySnapshot): TelemetrySnapshot | undefined {
  try {
    const snapshot = getSnapshot();
    return snapshot.enabled ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

function deadline(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(10_000, Math.floor(value)))
    : DEFAULT_LIFECYCLE_TIMEOUT_MILLIS;
}

function requestTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(10_000, Math.floor(value)))
    : POSTHOG_REQUEST_TIMEOUT_MS;
}

function maxBatchSize(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(1, Math.min(DEFAULT_MAX_BATCH_SIZE, value))
    : DEFAULT_MAX_BATCH_SIZE;
}

async function settleWithin(operation: () => Promise<void> | void, timeoutMillis: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation).catch(() => undefined),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMillis);
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

function spanKind(kind: SpanKind): string | undefined {
  switch (kind) {
    case SpanKind.INTERNAL: return "internal";
    case SpanKind.SERVER: return "server";
    case SpanKind.CLIENT: return "client";
    default: return undefined;
  }
}

function safeSpanKind(kind: SafeSpan["kind"]): SpanKind {
  switch (kind) {
    case "internal": return SpanKind.INTERNAL;
    case "server": return SpanKind.SERVER;
    case "client": return SpanKind.CLIENT;
  }
}

function spanStatus(code: SpanStatusCode): string | undefined {
  switch (code) {
    case SpanStatusCode.UNSET: return "unset";
    case SpanStatusCode.OK: return "ok";
    case SpanStatusCode.ERROR: return "error";
    default: return undefined;
  }
}

function safeSpanStatus(code: SafeSpan["statusCode"]): SpanStatusCode {
  switch (code) {
    case "unset": return SpanStatusCode.UNSET;
    case "ok": return SpanStatusCode.OK;
    case "error": return SpanStatusCode.ERROR;
  }
}

function resourceCandidate(resource: Resource): Record<string, unknown> {
  const attributes = resource.attributes;
  return {
    serviceName: own(attributes, "service.name"),
    serviceVersion: own(attributes, "service.version"),
    serviceInstanceId: own(attributes, "service.instance.id"),
    nodeVersion: own(attributes, "process.runtime.version"),
    osFamily: own(attributes, "os.type"),
    cpuArchitecture: own(attributes, "host.arch"),
    runtimeMode: own(attributes, "cc_router.runtime_mode"),
  };
}

function spanAttributeCandidate(attributes: Attributes): Record<string, unknown> {
  return {
    httpMethod: own(attributes, "http.request.method") ?? own(attributes, "http.method"),
    httpStatusCode: own(attributes, "http.response.status_code") ?? own(attributes, "http.status_code"),
    provider: own(attributes, "cc_router.provider"),
    route: own(attributes, "cc_router.route"),
    modelFamily: own(attributes, "cc_router.model_family"),
    requestSource: own(attributes, "cc_router.request_source"),
    runtimeMode: own(attributes, "cc_router.runtime_mode"),
    streaming: own(attributes, "cc_router.streaming"),
    streamOutcome: own(attributes, "cc_router.stream_outcome"),
    outcome: own(attributes, "cc_router.outcome"),
    attempt: own(attributes, "cc_router.attempt"),
    accountPoolSize: own(attributes, "cc_router.account_pool_size"),
    concurrency: own(attributes, "cc_router.concurrency"),
    inputTokens: own(attributes, "cc_router.input_tokens"),
    outputTokens: own(attributes, "cc_router.output_tokens"),
    operationDurationMs: own(attributes, "cc_router.operation_duration_ms"),
  };
}

function safeSpanAttributes(attributes: SafeSpanAttributes): Attributes {
  const output: Attributes = {};
  const assign = (key: string, value: string | number | boolean | undefined): void => {
    if (value !== undefined) output[key] = value;
  };
  assign("http.request.method", attributes.httpMethod);
  assign("http.response.status_code", attributes.httpStatusCode);
  assign("cc_router.provider", attributes.provider);
  assign("cc_router.route", attributes.route);
  assign("cc_router.model_family", attributes.modelFamily);
  assign("cc_router.request_source", attributes.requestSource);
  assign("cc_router.runtime_mode", attributes.runtimeMode);
  assign("cc_router.streaming", attributes.streaming);
  assign("cc_router.stream_outcome", attributes.streamOutcome);
  assign("cc_router.outcome", attributes.outcome);
  assign("cc_router.attempt", attributes.attempt);
  assign("cc_router.account_pool_size", attributes.accountPoolSize);
  assign("cc_router.concurrency", attributes.concurrency);
  assign("cc_router.input_tokens", attributes.inputTokens);
  assign("cc_router.output_tokens", attributes.outputTokens);
  assign("cc_router.operation_duration_ms", attributes.operationDurationMs);
  return output;
}

function reconstructReadableSpan(
  candidate: ReadableSpan,
  snapshot: TelemetrySnapshot,
): ReadableSpan | undefined {
  try {
    const context = candidate.spanContext();
    const resource = reconstructResource(resourceCandidate(candidate.resource), {
      installationId: snapshot.state.installId,
    });
    const safe = reconstructSpan({
      scope: candidate.instrumentationScope.name,
      operation: own(candidate.attributes, "cc_router.operation"),
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: candidate.parentSpanContext?.spanId,
      kind: spanKind(candidate.kind),
      startTimeMs: hrTimeToMilliseconds(candidate.startTime),
      durationMs: hrTimeToMilliseconds(candidate.duration),
      statusCode: spanStatus(candidate.status.code),
      attributes: spanAttributeCandidate(candidate.attributes),
    });
    if (!resource || !safe) return undefined;
    return newReadableSpan(safe, resource);
  } catch {
    return undefined;
  }
}

function newReadableSpan(safe: SafeSpan, resource: SafeResource): ReadableSpan {
  const startTime = millisecondsToHrTime(safe.startTimeMs);
  const duration = millisecondsToHrTime(safe.durationMs);
  const endTime = millisecondsToHrTime(safe.startTimeMs + safe.durationMs);
  const spanContext = {
    traceId: safe.traceId,
    spanId: safe.spanId,
    traceFlags: TraceFlags.SAMPLED,
  };
  return {
    name: safe.name,
    kind: safeSpanKind(safe.kind),
    spanContext: () => ({ ...spanContext }),
    ...(safe.parentSpanId === undefined ? {} : {
      parentSpanContext: {
        traceId: safe.traceId,
        spanId: safe.parentSpanId,
        traceFlags: TraceFlags.SAMPLED,
      },
    }),
    startTime,
    endTime,
    duration,
    status: { code: safeSpanStatus(safe.statusCode) },
    attributes: safeSpanAttributes(safe.attributes),
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

function logSeverity(value: SeverityNumber | undefined): Severity | undefined {
  switch (value) {
    case SeverityNumber.INFO: return "info";
    case SeverityNumber.WARN: return "warn";
    case SeverityNumber.ERROR: return "error";
    case SeverityNumber.FATAL: return "fatal";
    default: return undefined;
  }
}

function safeLogSeverity(value: Severity): { text: string; number: SeverityNumber } {
  switch (value) {
    case "info": return { text: "INFO", number: SeverityNumber.INFO };
    case "warn": return { text: "WARN", number: SeverityNumber.WARN };
    case "error": return { text: "ERROR", number: SeverityNumber.ERROR };
    case "fatal": return { text: "FATAL", number: SeverityNumber.FATAL };
  }
}

function logAttributeCandidate(attributes: LogAttributes): Record<string, unknown> {
  return {
    provider: own(attributes, "cc_router.provider"),
    method: own(attributes, "cc_router.method"),
    stage: own(attributes, "cc_router.stage"),
    reason: own(attributes, "cc_router.reason"),
    outcome: own(attributes, "cc_router.outcome"),
    httpStatusCode: own(attributes, "http.response.status_code") ?? own(attributes, "http.status_code"),
    durationBucket: own(attributes, "cc_router.duration_bucket"),
    operation: own(attributes, "cc_router.operation"),
    attempt: own(attributes, "cc_router.attempt"),
    accountPoolSize: own(attributes, "cc_router.account_pool_size"),
    concurrency: own(attributes, "cc_router.concurrency"),
    operationDurationMs: own(attributes, "cc_router.operation_duration_ms"),
    serviceVersion: own(attributes, "service.version"),
    osFamily: own(attributes, "os.type"),
    runtimeMode: own(attributes, "cc_router.runtime_mode"),
  };
}

function safeLogAttributes(
  attributes: SafeSetupDiagnosticAttributes | SafeRuntimeFailureAttributes,
): LogAttributes {
  const output: LogAttributes = {};
  const assign = (key: string, value: string | number | undefined): void => {
    if (value !== undefined) output[key] = value;
  };
  if ("operation" in attributes) assign("cc_router.operation", attributes.operation);
  assign("cc_router.provider", attributes.provider);
  if ("method" in attributes) assign("cc_router.method", attributes.method);
  if ("stage" in attributes) assign("cc_router.stage", attributes.stage);
  assign("cc_router.reason", attributes.reason);
  assign("cc_router.outcome", attributes.outcome);
  assign("http.response.status_code", attributes.httpStatusCode);
  if ("durationBucket" in attributes) assign("cc_router.duration_bucket", attributes.durationBucket);
  if ("attempt" in attributes) assign("cc_router.attempt", attributes.attempt);
  if ("accountPoolSize" in attributes) assign("cc_router.account_pool_size", attributes.accountPoolSize);
  if ("concurrency" in attributes) assign("cc_router.concurrency", attributes.concurrency);
  if ("operationDurationMs" in attributes) {
    assign("cc_router.operation_duration_ms", attributes.operationDurationMs);
  }
  assign("service.version", attributes.serviceVersion);
  assign("os.type", attributes.osFamily);
  assign("cc_router.runtime_mode", attributes.runtimeMode);
  assign("cc_router.diagnostic_id", attributes.diagnosticId);
  return output;
}

function reconstructReadableLog(
  candidate: ReadableLogRecord,
  snapshot: TelemetrySnapshot,
  getDiagnosticId: ((record: ReadableLogRecord) => string | undefined) | undefined,
): ReadableLogRecord | undefined {
  try {
    const diagnosticId = getDiagnosticId?.(candidate);
    const resource = reconstructResource(resourceCandidate(candidate.resource), {
      installationId: snapshot.state.installId,
    });
    const safe = reconstructLog({
      scope: candidate.instrumentationScope.name,
      body: candidate.body,
      severity: logSeverity(candidate.severityNumber),
      timestampMs: hrTimeToMilliseconds(candidate.hrTime),
      traceId: candidate.spanContext?.traceId,
      spanId: candidate.spanContext?.spanId,
      attributes: logAttributeCandidate(candidate.attributes),
    }, {
      installationId: snapshot.state.installId,
      ...(diagnosticId === undefined ? {} : { diagnosticId }),
    });
    if (!resource || !safe) return undefined;
    return newReadableLog(safe, resource);
  } catch {
    return undefined;
  }
}

function newReadableLog(safe: SafeLog, resource: SafeResource): ReadableLogRecord {
  const severity = safeLogSeverity(safe.severity);
  const context = safe.traceId && safe.spanId
    ? { traceId: safe.traceId, spanId: safe.spanId, traceFlags: TraceFlags.SAMPLED }
    : undefined;
  const hrTime = millisecondsToHrTime(safe.timestampMs);
  return {
    hrTime,
    hrTimeObserved: [...hrTime],
    ...(context === undefined ? {} : { spanContext: context }),
    severityText: severity.text,
    severityNumber: severity.number,
    body: safe.body,
    resource: resourceFromAttributes({ ...resource }),
    instrumentationScope: { name: safe.scope },
    attributes: safeLogAttributes(safe.attributes),
    droppedAttributesCount: 0,
  };
}

export function createPrivacySafeSpanExporter(
  options: PrivacySafeExporterOptions<SpanExporter>,
): SpanExporter {
  const getSnapshot = options.getSnapshot ?? getTelemetrySnapshot;
  const exportTimeoutMillis = deadline(options.exportTimeoutMillis);
  const lifecycleTimeoutMillis = deadline(options.lifecycleTimeoutMillis);
  const batchLimit = maxBatchSize(options.maxBatchSize);
  return {
    export(spans, callback) {
      let settled = false;
      let exportTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: typeof SUCCESS | typeof FAILED): void => {
        if (settled) return;
        settled = true;
        clearTimeout(exportTimer);
        callback(result);
      };
      try {
        const snapshot = safeSnapshot(getSnapshot);
        if (!snapshot) {
          settle(SUCCESS);
          return;
        }
        const safeSpans = spans.slice(0, batchLimit).flatMap(span => {
          const safe = reconstructReadableSpan(span, snapshot);
          return safe ? [safe] : [];
        });
        if (safeSpans.length === 0 || !safeSnapshot(getSnapshot)) {
          settle(SUCCESS);
          return;
        }
        exportTimer = setTimeout(() => settle(FAILED), exportTimeoutMillis);
        exportTimer.unref?.();
        options.delegate.export(safeSpans, result => settle(result.code === 0 ? SUCCESS : FAILED));
      } catch {
        settle(FAILED);
      }
    },
    forceFlush: async () => {
      if (!safeSnapshot(getSnapshot)) return;
      await settleWithin(
        () => options.delegate.forceFlush?.(),
        lifecycleTimeoutMillis,
      );
    },
    shutdown: async () => settleWithin(
      () => options.delegate.shutdown(),
      lifecycleTimeoutMillis,
    ),
  };
}

export function createPrivacySafeLogExporter(
  options: PrivacySafeLogExporterOptions,
): LogRecordExporter {
  const getSnapshot = options.getSnapshot ?? getTelemetrySnapshot;
  const exportTimeoutMillis = deadline(options.exportTimeoutMillis);
  const lifecycleTimeoutMillis = deadline(options.lifecycleTimeoutMillis);
  const batchLimit = maxBatchSize(options.maxBatchSize);
  return {
    export(logs, callback) {
      let settled = false;
      let exportTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: typeof SUCCESS | typeof FAILED): void => {
        if (settled) return;
        settled = true;
        clearTimeout(exportTimer);
        callback(result);
      };
      try {
        const snapshot = safeSnapshot(getSnapshot);
        if (!snapshot) {
          settle(SUCCESS);
          return;
        }
        const safeLogs = logs.slice(0, batchLimit).flatMap(log => {
          const safe = reconstructReadableLog(log, snapshot, options.getDiagnosticId);
          return safe ? [safe] : [];
        });
        if (safeLogs.length === 0 || !safeSnapshot(getSnapshot)) {
          settle(SUCCESS);
          return;
        }
        exportTimer = setTimeout(() => settle(FAILED), exportTimeoutMillis);
        exportTimer.unref?.();
        options.delegate.export(safeLogs, result => settle(result.code === 0 ? SUCCESS : FAILED));
      } catch {
        settle(FAILED);
      }
    },
    forceFlush: async () => {
      if (!safeSnapshot(getSnapshot)) return;
      await settleWithin(
        () => options.delegate.forceFlush(),
        lifecycleTimeoutMillis,
      );
    },
    shutdown: async () => settleWithin(
      () => options.delegate.shutdown(),
      lifecycleTimeoutMillis,
    ),
  };
}

export function createPostHogOtlpExporters(
  options: PostHogOtlpExporterOptions = {},
): PostHogOtlpExporters {
  const timeoutMillis = requestTimeout(options.requestTimeoutMillis);
  const headers = { Authorization: `Bearer ${POSTHOG_PROJECT_TOKEN}` };
  const traceDelegate = new OTLPTraceExporter({
    url: options.traceUrl ?? POSTHOG_TRACE_URL,
    headers,
    timeoutMillis,
    concurrencyLimit: 1,
    keepAlive: false,
  });
  const shared = {
    getSnapshot: options.getSnapshot,
    exportTimeoutMillis: options.exportTimeoutMillis ?? timeoutMillis,
    lifecycleTimeoutMillis: options.lifecycleTimeoutMillis ?? timeoutMillis,
    maxBatchSize: options.maxBatchSize,
  };
  return {
    spanExporter: createPrivacySafeSpanExporter({
      ...shared,
      delegate: traceDelegate,
    }),
    logExporter: createPostHogOtlpLogExporter(options),
  };
}

export function createPostHogOtlpLogExporter(
  options: PostHogOtlpLogExporterOptions = {},
): LogRecordExporter {
  const timeoutMillis = requestTimeout(options.requestTimeoutMillis);
  const delegate = new OTLPLogExporter({
    url: options.logUrl ?? POSTHOG_LOG_URL,
    headers: { Authorization: `Bearer ${POSTHOG_PROJECT_TOKEN}` },
    timeoutMillis,
    concurrencyLimit: 1,
    keepAlive: false,
  });
  return createPrivacySafeLogExporter({
    delegate,
    getSnapshot: options.getSnapshot,
    getDiagnosticId: options.getDiagnosticId,
    exportTimeoutMillis: options.exportTimeoutMillis ?? timeoutMillis,
    lifecycleTimeoutMillis: options.lifecycleTimeoutMillis ?? timeoutMillis,
    maxBatchSize: options.maxBatchSize,
  });
}
