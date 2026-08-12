import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  context,
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import { logs, SeverityNumber, type LogAttributes } from "@opentelemetry/api-logs";
import {
  claimTelemetryFirstStart,
  getTelemetrySnapshot,
  type TelemetrySnapshot,
} from "../config/telemetry.js";
import { getCurrentVersion } from "../utils/self-update.js";
import { MAX_ACCOUNT_POOL_SIZE } from "./constants.js";
import type {
  DiagnosticId,
  DurationBucket,
  Operation,
  OsFamily,
  Outcome,
  Provider,
  RuntimeMode,
  SafeAnalyticsEvent,
  SafeExceptionContext,
  SafeExceptionContract,
  SafeLog,
  SafeRuntimeFailureAttributes,
  SafeSetupDiagnosticAttributes,
  SafeSpanAttributes,
  SetupMethod,
  SetupReason,
  SetupStage,
  Severity,
  TrustedExceptionSource,
  TrustedTelemetryIdentity,
} from "./contracts.js";
import { createPostHogTelemetryClient, type PostHogTelemetryClient } from "./posthog-client.js";
import {
  reconstructAnalyticsEvent,
  reconstructLog,
  reconstructSpan,
  sanitizeException,
} from "./privacy.js";
import { flushProxyTelemetryWithin, shutdownProxyTelemetryWithin } from "./runtime.js";

const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1_000;
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface RuntimeTelemetryMetadata {
  serviceVersion: string;
  osFamily: OsFamily;
  runtimeMode: RuntimeMode;
}

export interface SafeRuntimeLogInput {
  operation: Operation;
  reason: SetupReason;
  severity: Severity;
  provider?: Provider;
  outcome?: Outcome;
  httpStatusCode?: number;
  attempt?: number;
  accountPoolSize?: number;
  concurrency?: number;
  operationDurationMs?: number;
  diagnosticId?: string;
}

function runtimeErrorProperty(error: unknown, key: "cause" | "code"): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    return Object.getOwnPropertyDescriptor(error, key)?.value;
  } catch {
    return undefined;
  }
}

/** Classify only explicit, allowlisted transport failures without parsing text. */
export function classifyExpectedRuntimeFailure(
  error: unknown,
): "timeout" | "network_failure" | undefined {
  const directCode = runtimeErrorProperty(error, "code");
  const causeCode = runtimeErrorProperty(runtimeErrorProperty(error, "cause"), "code");
  const code = typeof directCode === "string" ? directCode : causeCode;
  if (code === "ETIMEDOUT") return "timeout";
  if (["EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "EPIPE"]
    .includes(String(code))) {
    return "network_failure";
  }
  try {
    if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return "timeout";
    }
  } catch {
    // Exotic thrown values remain unexpected.
  }
  return undefined;
}

interface SetupOperationBase {
  provider: Exclude<Provider, "other">;
  method: SetupMethod;
  diagnosticId: string;
  durationBucket?: DurationBucket;
}

export interface SetupStageInput extends SetupOperationBase {
  stage: SetupStage;
}

export interface SetupResultInput extends SetupOperationBase {
  result: "succeeded" | "cancelled";
}

export interface ExpectedSetupFailureInput extends SetupOperationBase {
  stage: SetupStage;
  reason: SetupReason;
  httpStatusCode?: number;
}

export interface FacadeTimer {
  unref?(): void;
}

export interface TelemetryFacadeDependencies {
  getSnapshot: () => TelemetrySnapshot;
  claimFirstStart: () => TelemetrySnapshot | undefined;
  getAnalytics: () => PostHogTelemetryClient;
  emitLog: (log: SafeLog) => void;
  annotateSpan: (operation: Operation, attributes: SafeSpanAttributes) => void;
  sanitizeException: (
    error: unknown,
    context: SafeExceptionContext,
    identity: TrustedTelemetryIdentity,
    source: TrustedExceptionSource,
  ) => SafeExceptionContract | undefined;
  flushRuntime: (deadlineMs: number) => Promise<void>;
  shutdownRuntime: (deadlineMs: number) => Promise<void>;
  runtimeMetadata: () => RuntimeTelemetryMetadata;
  now: () => number;
  randomUUID: () => string;
  projectRoot: string;
  setInterval: (callback: () => void, delayMs: number) => FacadeTimer;
}

export interface TelemetryFacade {
  recordApplicationStart(): void;
  recordProxyStarted(accountCount: number): void;
  startProxyHeartbeat(accountCount: number): void;
  recordSafeLog(input: SafeRuntimeLogInput): void;
  recordSetupStage(input: SetupStageInput): void;
  recordSetupStageFailure(input: ExpectedSetupFailureInput): void;
  recordSetupResult(input: SetupResultInput): void;
  recordExpectedSetupFailure(input: ExpectedSetupFailureInput): void;
  recordUnexpectedException(
    error: unknown,
    context: SafeExceptionContext,
    diagnosticId?: string,
  ): DiagnosticId | undefined;
  annotateActiveSpan(operation: Operation, attributes: SafeSpanAttributes): void;
  flushTelemetryWithin(deadlineMs: number): Promise<void>;
  shutdownTelemetryWithin(deadlineMs: number): Promise<void>;
}

function osFamily(): OsFamily {
  switch (process.platform) {
    case "darwin": return "macos";
    case "linux": return "linux";
    case "win32": return "windows";
    default: return "other";
  }
}

function runtimeMode(): RuntimeMode {
  if (process.env["CC_ROUTER_SERVICE"] === "1") return "service";
  if (process.env["CC_ROUTER_DAEMON"] === "1") return "daemon";
  return "foreground";
}

function runtimeMetadata(): RuntimeTelemetryMetadata {
  return {
    serviceVersion: getCurrentVersion(),
    osFamily: osFamily(),
    runtimeMode: runtimeMode(),
  };
}

function severityNumber(severity: Severity): SeverityNumber {
  switch (severity) {
    case "info": return SeverityNumber.INFO;
    case "warn": return SeverityNumber.WARN;
    case "error": return SeverityNumber.ERROR;
    case "fatal": return SeverityNumber.FATAL;
  }
}

function logAttributes(
  attributes: SafeRuntimeFailureAttributes | SafeSetupDiagnosticAttributes,
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

function defaultEmitLog(log: SafeLog): void {
  const emit = (): void => {
    logs.getLogger("cc-router").emit({
      body: log.body,
      severityNumber: severityNumber(log.severity),
      severityText: log.severity.toUpperCase(),
      timestamp: log.timestampMs,
      attributes: logAttributes(log.attributes),
    });
  };
  const active = trace.getActiveSpan()?.spanContext();
  if (active && (active.traceFlags & TraceFlags.SAMPLED) !== 0) emit();
  else context.with(ROOT_CONTEXT, emit);
}

const SPAN_ATTRIBUTE_NAMES: Readonly<Record<keyof SafeSpanAttributes, string>> = {
  httpMethod: "http.request.method",
  httpStatusCode: "http.response.status_code",
  provider: "cc_router.provider",
  route: "cc_router.route",
  modelFamily: "cc_router.model_family",
  requestSource: "cc_router.request_source",
  runtimeMode: "cc_router.runtime_mode",
  streaming: "cc_router.streaming",
  streamOutcome: "cc_router.stream_outcome",
  outcome: "cc_router.outcome",
  attempt: "cc_router.attempt",
  accountPoolSize: "cc_router.account_pool_size",
  concurrency: "cc_router.concurrency",
  inputTokens: "cc_router.input_tokens",
  outputTokens: "cc_router.output_tokens",
  operationDurationMs: "cc_router.operation_duration_ms",
};

function defaultAnnotateSpan(operation: Operation, attributes: SafeSpanAttributes): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute("cc_router.operation", operation);
  span.setAttributes(otelSpanAttributes(attributes));
}

function otelSpanAttributes(attributes: SafeSpanAttributes): Attributes {
  const safeAttributes: Attributes = {};
  for (const [key, value] of Object.entries(attributes) as Array<[keyof SafeSpanAttributes, unknown]>) {
    if (value !== undefined) safeAttributes[SPAN_ATTRIBUTE_NAMES[key]] = value as string | number | boolean;
  }
  return safeAttributes;
}

function reconstructedSpan(
  operation: Operation,
  attributes: SafeSpanAttributes,
): { operation: Operation; attributes: SafeSpanAttributes } | undefined {
  const safe = reconstructSpan({
    scope: "cc-router",
    operation,
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    kind: "internal",
    startTimeMs: 0,
    durationMs: 0,
    statusCode: "unset",
    attributes,
  });
  return safe ? { operation: safe.name, attributes: safe.attributes } : undefined;
}

/**
 * Run one closed runtime operation in the active OTel context. The callback is
 * invoked exactly once even if telemetry is disabled or the OTel API fails.
 */
export function withTelemetrySpan<T>(
  operation: Operation,
  attributes: SafeSpanAttributes,
  callback: () => T,
): T {
  let callbackStarted = false;
  try {
    if (!getTelemetrySnapshot().enabled) return callback();
    const safe = reconstructedSpan(operation, attributes);
    if (!safe) return callback();

    return trace.getTracer("cc-router").startActiveSpan(
      safe.operation,
      { attributes: otelSpanAttributes(safe.attributes) },
      span => {
        callbackStarted = true;
        try {
          const result = callback();
          if (result !== null
            && (typeof result === "object" || typeof result === "function")
            && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
            return Promise.resolve(result).then(value => {
              finalizeSpanBestEffort(span, SpanStatusCode.OK);
              return value;
            }, error => {
              finalizeSpanBestEffort(span, SpanStatusCode.ERROR);
              throw error;
            }) as T;
          }
          finalizeSpanBestEffort(span, SpanStatusCode.OK);
          return result;
        } catch (error) {
          finalizeSpanBestEffort(span, SpanStatusCode.ERROR);
          throw error;
        }
      },
    );
  } catch (error) {
    if (callbackStarted) throw error;
    return callback();
  }
}

function finalizeSpanBestEffort(span: Span, status: SpanStatusCode): void {
  try {
    span.setStatus({ code: status });
  } catch {
    // Telemetry finalization never changes application behavior.
  }
  try {
    span.end();
  } catch {
    // A broken tracer must not replace the callback value or error identity.
  }
}

function defaultDependencies(): TelemetryFacadeDependencies {
  let analytics: PostHogTelemetryClient | undefined;
  return {
    getSnapshot: getTelemetrySnapshot,
    claimFirstStart: claimTelemetryFirstStart,
    getAnalytics: () => analytics ??= createPostHogTelemetryClient(),
    emitLog: defaultEmitLog,
    annotateSpan: defaultAnnotateSpan,
    sanitizeException,
    flushRuntime: flushProxyTelemetryWithin,
    shutdownRuntime: shutdownProxyTelemetryWithin,
    runtimeMetadata,
    now: Date.now,
    randomUUID,
    projectRoot: PROJECT_ROOT,
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  };
}

function clampedAccountCount(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(MAX_ACCOUNT_POOL_SIZE, Math.floor(value)));
}

function isRandomUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function expectedSetupFailureOutcome(reason: SetupReason): Outcome | undefined {
  switch (reason) {
    case "unauthorized":
    case "forbidden":
    case "upstream_4xx":
    case "upstream_5xx":
    case "unexpected_response_shape":
      return "upstream_error";
    case "rate_limited":
      return "rate_limited";
    case "timeout":
      return "timeout";
    case "user_cancelled":
      return "cancelled";
    case "other":
      return "other";
    case "not_found":
    case "permission_denied":
    case "malformed_credentials":
    case "invalid_token":
    case "network_failure":
    case "persistence_failure":
      return undefined;
  }
}

function ignoreRejection(operation: Promise<void>): void {
  void operation.catch(() => undefined);
}

export function createTelemetryFacade(
  overrides: Partial<TelemetryFacadeDependencies> = {},
): TelemetryFacade {
  const dependencies = { ...defaultDependencies(), ...overrides };
  let activeAnalytics: PostHogTelemetryClient | undefined;

  const enabledSnapshot = (): TelemetrySnapshot | undefined => {
    try {
      const snapshot = dependencies.getSnapshot();
      return snapshot.enabled ? snapshot : undefined;
    } catch {
      return undefined;
    }
  };

  const analytics = (): PostHogTelemetryClient | undefined => {
    try {
      return activeAnalytics ??= dependencies.getAnalytics();
    } catch {
      return undefined;
    }
  };

  const metadata = (): RuntimeTelemetryMetadata | undefined => {
    try {
      return dependencies.runtimeMetadata();
    } catch {
      return undefined;
    }
  };

  const captureAnalytics = (
    snapshot: TelemetrySnapshot,
    event: SafeAnalyticsEvent["event"],
    properties: object,
    diagnosticId?: string,
    immediate = false,
  ): void => {
    try {
      if (!snapshot.enabled) return;
      const safe = reconstructAnalyticsEvent({ event, properties }, {
        installationId: snapshot.state.installId,
        ...(diagnosticId === undefined ? {} : { diagnosticId }),
      });
      const client = safe && analytics();
      if (!safe || !client) return;
      if (immediate) ignoreRejection(client.captureAnalyticsImmediate(safe));
      else client.captureAnalytics(safe);
    } catch {
      // Application behavior never depends on telemetry capture.
    }
  };

  const emitLog = (
    snapshot: TelemetrySnapshot,
    body: SafeLog["body"],
    severity: Severity,
    attributes: object,
    diagnosticId?: string,
  ): void => {
    try {
      if (!snapshot.enabled) return;
      const safe = reconstructLog({
        scope: "cc-router",
        body,
        severity,
        timestampMs: dependencies.now(),
        attributes,
      }, {
        installationId: snapshot.state.installId,
        ...(diagnosticId === undefined ? {} : { diagnosticId }),
      });
      if (safe) dependencies.emitLog(safe);
    } catch {
      // Remote logging is best effort only.
    }
  };

  const setupProperties = (
    input: SetupOperationBase & { stage: SetupStage; reason?: SetupReason },
    extra: object = {},
  ): object | undefined => {
    const common = metadata();
    if (!common) return undefined;
    return { ...input, ...extra, ...common };
  };

  return {
    recordApplicationStart(): void {
      try {
        const current = dependencies.getSnapshot();
        const snapshot = dependencies.claimFirstStart();
        const properties = current.enabled
          && snapshot?.enabled
          && current.state.installId === snapshot.state.installId
          ? metadata()
          : undefined;
        if (snapshot && properties) {
          captureAnalytics(snapshot, "app.first_start", properties, undefined, true);
        }
      } catch {
        // First-start attribution is optional and never affects CLI startup.
      }
    },

    recordProxyStarted(accountCount): void {
      const snapshot = enabledSnapshot();
      const common = snapshot && metadata();
      if (!snapshot || !common) return;
      captureAnalytics(snapshot, "proxy.started", {
        ...common,
        accountPoolSize: clampedAccountCount(accountCount),
      });
    },

    startProxyHeartbeat(accountCount): void {
      if (!enabledSnapshot()) return;
      try {
        const timer = dependencies.setInterval(() => {
          try {
            const snapshot = enabledSnapshot();
            const common = snapshot && metadata();
            if (!snapshot || !common) return;
            captureAnalytics(snapshot, "proxy.heartbeat", {
              ...common,
              accountPoolSize: clampedAccountCount(accountCount),
            });
          } catch {
            // Timer callbacks remain failure-isolated.
          }
        }, HEARTBEAT_INTERVAL_MS);
        timer.unref?.();
      } catch {
        // Failure to schedule telemetry must not affect proxy startup.
      }
    },

    recordSafeLog(input): void {
      const snapshot = enabledSnapshot();
      const common = snapshot && metadata();
      if (!snapshot || !common) return;
      emitLog(snapshot, "runtime.failure", input.severity, { ...input, ...common }, input.diagnosticId);
    },

    recordSetupStage(input): void {
      const snapshot = enabledSnapshot();
      const properties = snapshot && setupProperties(input);
      if (!snapshot || !properties) return;
      emitLog(snapshot, "account.setup.diagnostic", "info", properties, input.diagnosticId);
      captureAnalytics(
        snapshot,
        input.stage === "attempt_start" ? "account_setup.started" : "account_setup.stage_completed",
        properties,
        input.diagnosticId,
        true,
      );
    },

    recordSetupStageFailure(input): void {
      const snapshot = enabledSnapshot();
      const outcome = expectedSetupFailureOutcome(input.reason);
      const properties = snapshot && setupProperties(
        input,
        outcome === undefined ? {} : { outcome },
      );
      if (!snapshot || !properties) return;
      emitLog(snapshot, "account.setup.diagnostic", "warn", properties, input.diagnosticId);
    },

    recordSetupResult(input): void {
      if (input.result !== "succeeded" && input.result !== "cancelled") return;
      const snapshot = enabledSnapshot();
      if (!snapshot) return;
      const cancelled = input.result === "cancelled";
      const stage: SetupStage = cancelled ? "cancellation" : "success";
      const reason: SetupReason | undefined = cancelled ? "user_cancelled" : undefined;
      const outcome: Outcome = cancelled ? "cancelled" : "complete";
      const properties = setupProperties({ ...input, stage, reason }, { outcome });
      if (!properties) return;
      emitLog(snapshot, "account.setup.diagnostic", "info", properties, input.diagnosticId);
      captureAnalytics(
        snapshot,
        cancelled ? "account_setup.cancelled" : "account_setup.succeeded",
        properties,
        input.diagnosticId,
        true,
      );
    },

    recordExpectedSetupFailure(input): void {
      const snapshot = enabledSnapshot();
      const outcome = expectedSetupFailureOutcome(input.reason);
      const properties = snapshot && setupProperties(
        input,
        outcome === undefined ? {} : { outcome },
      );
      if (!snapshot || !properties) return;
      emitLog(snapshot, "account.setup.diagnostic", "warn", properties, input.diagnosticId);
      captureAnalytics(snapshot, "account_setup.failed", properties, input.diagnosticId, true);
    },

    recordUnexpectedException(error, context, diagnosticId): DiagnosticId | undefined {
      const snapshot = enabledSnapshot();
      if (!snapshot) return undefined;
      try {
        let candidate = diagnosticId ?? dependencies.randomUUID();
        if (!isRandomUuid(candidate)) return undefined;
        if (candidate === snapshot.state.installId && diagnosticId === undefined) {
          candidate = dependencies.randomUUID();
        }
        if (!isRandomUuid(candidate) || candidate === snapshot.state.installId) return undefined;
        const exception = dependencies.sanitizeException(error, context, {
          installationId: snapshot.state.installId,
          diagnosticId: candidate,
        }, {
          projectRoot: dependencies.projectRoot,
        });
        if (exception) {
          const client = analytics();
          if (client) {
            if (context.category === "setup") {
              ignoreRejection(client.captureExceptionImmediate(exception));
            } else {
              client.captureException(exception);
            }
          }
        }
        return exception?.diagnosticId;
      } catch {
        return undefined;
      }
    },

    annotateActiveSpan(operation, attributes): void {
      if (!enabledSnapshot()) return;
      try {
        const safe = reconstructedSpan(operation, attributes);
        if (safe) dependencies.annotateSpan(safe.operation, safe.attributes);
      } catch {
        // Span enrichment is optional.
      }
    },

    async flushTelemetryWithin(deadlineMs): Promise<void> {
      try {
        const snapshot = enabledSnapshot();
        if (!snapshot) {
          try { activeAnalytics?.discardPending(); } catch { /* isolated */ }
          await dependencies.flushRuntime(deadlineMs).catch(() => undefined);
          return;
        }
        await Promise.all([
          activeAnalytics?.flushWithin(deadlineMs).catch(() => undefined),
          dependencies.flushRuntime(deadlineMs).catch(() => undefined),
        ]);
      } catch {
        // A flush failure never changes the command result.
      }
    },

    async shutdownTelemetryWithin(deadlineMs): Promise<void> {
      try {
        const snapshot = enabledSnapshot();
        if (!snapshot) {
          try { activeAnalytics?.discardPending(); } catch { /* isolated */ }
        }
        await Promise.all([
          activeAnalytics?.shutdownWithin(deadlineMs).catch(() => undefined),
          dependencies.shutdownRuntime(deadlineMs).catch(() => undefined),
        ]);
      } catch {
        // A shutdown failure never changes proxy lifecycle behavior.
      }
    },
  };
}

const telemetry = createTelemetryFacade();

export const recordApplicationStart = telemetry.recordApplicationStart;
export const recordProxyStarted = telemetry.recordProxyStarted;
export const startProxyHeartbeat = telemetry.startProxyHeartbeat;
export const recordSafeLog = telemetry.recordSafeLog;
export const recordSetupStage = telemetry.recordSetupStage;
export const recordSetupStageFailure = telemetry.recordSetupStageFailure;
export const recordSetupResult = telemetry.recordSetupResult;
export const recordExpectedSetupFailure = telemetry.recordExpectedSetupFailure;
export const recordUnexpectedException = telemetry.recordUnexpectedException;
export const annotateActiveSpan = telemetry.annotateActiveSpan;
export const flushTelemetryWithin = telemetry.flushTelemetryWithin;
export const shutdownTelemetryWithin = telemetry.shutdownTelemetryWithin;
