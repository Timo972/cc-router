import { randomUUID as nodeRandomUUID } from "node:crypto";
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { RequestHandler } from "express";
import {
  claimTelemetryFirstStart,
  createTelemetryConsentGate,
  getTelemetrySnapshot,
  type TelemetryConsentGate,
  type TelemetrySnapshot,
} from "../config/telemetry.js";
import { getCurrentVersion } from "../utils/self-update.js";
import { MAX_ACCOUNT_POOL_SIZE } from "./contracts.js";
import type {
  DurationBucket,
  ModelFamily,
  Operation,
  OsFamily,
  Outcome,
  Provider,
  RuntimeMode,
  SafeExceptionContext,
  SafeExceptionContract,
  SafeLog,
  SafeSpanAttributes,
  SetupMethod,
  SetupReason,
  SetupStage,
  Severity,
  TrustedTelemetryIdentity,
} from "./contracts.js";
import { createPostHogTelemetryClient, type PostHogTelemetryClient } from "./posthog-client.js";
import {
  LOG_ATTRIBUTE_KEYS,
  SPAN_ATTRIBUTE_KEYS,
  reconstructAnalyticsEvent,
  sanitizeException,
  toOtelAttributes,
} from "./privacy.js";
import {
  flushTelemetryRuntimeWithin,
  isTelemetryRuntimeActive,
  shutdownTelemetryRuntimeWithin,
  startTelemetryRuntime,
} from "./runtime.js";

export type {
  DurationBucket,
  ModelFamily,
  Operation,
  Outcome,
  Provider,
  RequestSource,
  Route,
  RuntimeMode,
  SafeExceptionContext,
  SafeSpanAttributes,
  SetupMethod,
  SetupReason,
  SetupStage,
  Severity,
  StreamOutcome,
} from "./contracts.js";

const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1_000;
const SCOPE = "cc-router";
const PROXY_REQUEST_PATHS = new Set(["/v1/messages", "/v1/responses"]);

export interface TelemetrySpanHandle {
  annotate(attributes: SafeSpanAttributes): void;
  end(status: "ok" | "error"): void;
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

export interface RuntimeErrorContext {
  operation: Operation;
  provider?: Provider;
}

export interface RuntimeFailureExtras {
  attempt?: number;
  durationMs?: number;
}

export interface TelemetryFacadeDependencies {
  getSnapshot?: () => TelemetrySnapshot;
  now?: () => number;
  randomUUID?: () => string;
  analytics?: PostHogTelemetryClient;
}

export type TelemetryFacade = ReturnType<typeof createTelemetryFacade>;

export function runtimeMode(): RuntimeMode {
  if (process.env["CC_ROUTER_SERVICE"] === "1") return "service";
  if (process.env["CC_ROUTER_DAEMON"] === "1") return "daemon";
  return "foreground";
}

function osFamily(): OsFamily {
  switch (process.platform) {
    case "darwin": return "macos";
    case "linux": return "linux";
    case "win32": return "windows";
    default: return "other";
  }
}

export function modelFamilyOf(model: string): ModelFamily {
  const value = model.toLowerCase();
  if (value.includes("fable")) return "fable";
  if (value.includes("sonnet")) return "sonnet";
  if (value.includes("opus")) return "opus";
  if (value.includes("haiku")) return "haiku";
  if (value.includes("codex") || value.startsWith("gpt-")) return "codex";
  return "other";
}

export function httpFailureReason(status: number): SetupReason {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_5xx";
  return "upstream_4xx";
}

export function httpOutcome(status: number): Outcome {
  if (status === 429) return "rate_limited";
  if (status >= 400) return "upstream_error";
  return "complete";
}

function errorProperty(error: unknown, key: "cause" | "code"): unknown {
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
  const directCode = errorProperty(error, "code");
  const causeCode = errorProperty(errorProperty(error, "cause"), "code");
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

function severityNumber(severity: Severity): SeverityNumber {
  switch (severity) {
    case "info": return SeverityNumber.INFO;
    case "warn": return SeverityNumber.WARN;
    case "error": return SeverityNumber.ERROR;
    case "fatal": return SeverityNumber.FATAL;
  }
}

function isRandomUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function clampedAccountCount(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(MAX_ACCOUNT_POOL_SIZE, Math.floor(value)));
}

function expectedSetupFailureOutcome(reason: SetupReason): Outcome | undefined {
  switch (reason) {
    case "unauthorized":
    case "forbidden":
    case "upstream_4xx":
    case "upstream_5xx":
    case "unexpected_response_shape":
      return "upstream_error";
    case "rate_limited": return "rate_limited";
    case "timeout": return "timeout";
    case "user_cancelled": return "cancelled";
    case "other": return "other";
    default: return undefined;
  }
}

let sharedGate: TelemetryConsentGate | undefined;
let sharedAnalytics: PostHogTelemetryClient | undefined;

function sharedConsentGate(): TelemetryConsentGate {
  return sharedGate ??= createTelemetryConsentGate(getTelemetrySnapshot, () => {
    try { sharedAnalytics?.discardPending(); } catch { /* isolated */ }
  });
}

/** Logs and analytics work without the proxy's tracing runtime. */
function ensureRuntime(): void {
  try {
    if (isTelemetryRuntimeActive()) return;
    startTelemetryRuntime({ tracing: false, runtimeMode: runtimeMode() });
  } catch {
    // Telemetry transport failures never reach application code.
  }
}

function spanAttributes(operation: Operation, attributes: SafeSpanAttributes): Attributes {
  return {
    "cc_router.operation": operation,
    ...toOtelAttributes(SPAN_ATTRIBUTE_KEYS, attributes),
  };
}

function finalizeSpan(span: Span, status: "ok" | "error"): void {
  try {
    span.setStatus({ code: status === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  } catch {
    // Telemetry finalization never changes application behavior.
  }
  try {
    span.end();
  } catch {
    // A broken tracer must not replace the callback value or error identity.
  }
}

const NOOP_SPAN_HANDLE: TelemetrySpanHandle = {
  annotate: () => undefined,
  end: () => undefined,
};

/**
 * Start a closed-schema span whose lifetime is owned by an event-driven body.
 * The handle never exposes the OTel span or accepts arbitrary attributes.
 */
export function startTelemetrySpan(
  operation: Operation,
  attributes: SafeSpanAttributes,
): TelemetrySpanHandle {
  try {
    if (!sharedConsentGate().getSnapshot()) return NOOP_SPAN_HANDLE;
    const span = trace.getTracer(SCOPE).startSpan(operation, {
      attributes: spanAttributes(operation, attributes),
    });
    let ended = false;
    return {
      annotate(next): void {
        if (ended) return;
        try {
          span.setAttributes(toOtelAttributes(SPAN_ATTRIBUTE_KEYS, next));
        } catch {
          // Body telemetry never changes response handling.
        }
      },
      end(status): void {
        if (ended) return;
        ended = true;
        finalizeSpan(span, status);
      },
    };
  } catch {
    return NOOP_SPAN_HANDLE;
  }
}

/** Run one closed runtime operation as the active span. The callback runs exactly once. */
export function withTelemetrySpan<T>(
  operation: Operation,
  attributes: SafeSpanAttributes,
  callback: () => Promise<T>,
): Promise<T> {
  let started = false;
  try {
    if (!sharedConsentGate().getSnapshot()) return callback();
    return trace.getTracer(SCOPE).startActiveSpan(
      operation,
      { attributes: spanAttributes(operation, attributes) },
      async span => {
        started = true;
        try {
          const value = await callback();
          finalizeSpan(span, "ok");
          return value;
        } catch (error) {
          finalizeSpan(span, "error");
          throw error;
        }
      },
    );
  } catch (error) {
    if (started) return Promise.reject(error);
    return callback();
  }
}

export function annotateActiveSpan(operation: Operation, attributes: SafeSpanAttributes): void {
  try {
    if (!sharedConsentGate().getSnapshot()) return;
    trace.getActiveSpan()?.setAttributes(spanAttributes(operation, attributes));
  } catch {
    // Span enrichment is optional.
  }
}

/** Wrap the two inference routes in a server span; every other route passes through. */
export function telemetryRequestMiddleware(): RequestHandler {
  return (request, response, next) => {
    let continued = false;
    const proceed = (): void => {
      if (continued) return;
      continued = true;
      next();
    };
    try {
      if (!PROXY_REQUEST_PATHS.has(request.path) || !sharedConsentGate().getSnapshot()) {
        proceed();
        return;
      }
      const attributes: SafeSpanAttributes = {
        ...(request.method === "GET" || request.method === "POST"
          ? { httpMethod: request.method }
          : {}),
        route: request.path === "/v1/messages" ? "messages" : "responses",
      };
      trace.getTracer(SCOPE).startActiveSpan(
        "proxy.request",
        { kind: SpanKind.SERVER, attributes: spanAttributes("proxy.request", attributes) },
        span => {
          let ended = false;
          const end = (): void => {
            if (ended) return;
            ended = true;
            try {
              span.setAttributes(toOtelAttributes(SPAN_ATTRIBUTE_KEYS, {
                httpStatusCode: response.statusCode,
              }));
            } catch {
              // Response telemetry never changes the response itself.
            }
            finalizeSpan(span, response.statusCode >= 500 ? "error" : "ok");
          };
          response.once("finish", end);
          response.once("close", end);
          proceed();
        },
      );
    } catch {
      proceed();
    }
  };
}

export function createTelemetryFacade(dependencies: TelemetryFacadeDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const uuid = dependencies.randomUUID ?? nodeRandomUUID;
  const getSnapshot = dependencies.getSnapshot;
  let gate: TelemetryConsentGate | undefined;
  // Lazy: binding the consent generation must not read the state file at import.
  const consent = (): TelemetryConsentGate => gate ??= getSnapshot
    ? createTelemetryConsentGate(getSnapshot, () => {
      try { dependencies.analytics?.discardPending(); } catch { /* isolated */ }
    })
    : sharedConsentGate();
  const immediate = new Set<Promise<void>>();

  const analytics = (): PostHogTelemetryClient | undefined => {
    if (dependencies.analytics) return dependencies.analytics;
    try {
      // The gate (not the raw state reader) feeds the transport so queued
      // batches are dropped after an opt-out, not just new captures.
      return sharedAnalytics ??= createPostHogTelemetryClient({
        getSnapshot: () => consent().getSnapshot(),
      });
    } catch {
      return undefined;
    }
  };

  const activeAnalytics = (): PostHogTelemetryClient | undefined =>
    dependencies.analytics ?? sharedAnalytics;

  const metadata = (): { serviceVersion: string; osFamily: OsFamily; runtimeMode: RuntimeMode } => ({
    serviceVersion: getCurrentVersion(),
    osFamily: osFamily(),
    runtimeMode: runtimeMode(),
  });

  const trackImmediate = (operation: Promise<void>): void => {
    const contained = Promise.resolve(operation).catch(() => undefined);
    immediate.add(contained);
    void contained.then(() => { immediate.delete(contained); });
  };

  const boundedDeadline = (deadlineMs: number): number => Number.isFinite(deadlineMs)
    ? Math.max(0, Math.min(10_000, Math.floor(deadlineMs)))
    : 0;

  const settleWithin = async (operations: readonly Promise<unknown>[], deadlineMs: number): Promise<void> => {
    if (operations.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(operations).then(() => undefined),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, boundedDeadline(deadlineMs));
        timer.unref?.();
      }),
    ]).catch(() => undefined).finally(() => clearTimeout(timer));
  };

  const emitLog = (
    body: SafeLog["body"],
    severity: Severity,
    attributes: object,
  ): void => {
    try {
      ensureRuntime();
      const emit = (): void => {
        logs.getLogger(SCOPE).emit({
          body,
          severityNumber: severityNumber(severity),
          severityText: severity.toUpperCase(),
          timestamp: now(),
          attributes: toOtelAttributes(LOG_ATTRIBUTE_KEYS, attributes),
        });
      };
      const active = trace.getActiveSpan()?.spanContext();
      // Trace correlation would drop this record when the active span is
      // unsampled, so an unsampled parent is detached instead.
      if (active && (active.traceFlags & TraceFlags.SAMPLED) !== 0) emit();
      else context.with(ROOT_CONTEXT, emit);
    } catch {
      // Remote logging is best effort only.
    }
  };

  const captureAnalytics = (
    snapshot: TelemetrySnapshot,
    event: string,
    properties: object,
    diagnosticId?: string,
  ): void => {
    try {
      ensureRuntime();
      const safe = reconstructAnalyticsEvent({ event, properties }, {
        installationId: snapshot.state.installId,
        ...(diagnosticId === undefined ? {} : { diagnosticId }),
      });
      const client = safe && analytics();
      if (safe && client) client.captureAnalytics(safe, snapshot.state.consentGeneration);
    } catch {
      // Application behavior never depends on telemetry capture.
    }
  };

  const recordSafeLog = (input: SafeRuntimeLogInput): void => {
    const snapshot = consent().getSnapshot();
    if (!snapshot) return;
    const { severity, diagnosticId, ...attributes } = input;
    emitLog("runtime.failure", severity, {
      ...attributes,
      ...metadata(),
      diagnosticId: diagnosticId !== undefined && isRandomUuid(diagnosticId) ? diagnosticId : undefined,
    });
  };

  const recordUnexpectedException = (
    error: unknown,
    exceptionContext: SafeExceptionContext,
    diagnosticId?: string,
  ): string | undefined => {
    const snapshot = consent().getSnapshot();
    if (!snapshot) return undefined;
    try {
      const candidate = diagnosticId ?? uuid();
      if (!isRandomUuid(candidate) || candidate === snapshot.state.installId) return undefined;
      const exception = sanitizeException(error, exceptionContext, {
        installationId: snapshot.state.installId,
        diagnosticId: candidate,
      });
      if (!exception) return undefined;
      if (exceptionContext.category === "runtime") {
        // Raw detail stays local; only the correlation key is exported.
        console.error(
          `[cc-router] Unexpected runtime failure (diagnostic ID: ${exception.diagnosticId})`,
          error,
        );
      }
      const client = analytics();
      if (client) {
        if (exceptionContext.category === "setup") {
          trackImmediate(client.captureExceptionImmediate(exception, snapshot.state.consentGeneration));
        } else {
          client.captureException(exception, snapshot.state.consentGeneration);
        }
      }
      return exception.diagnosticId;
    } catch {
      return undefined;
    }
  };

  /** Neither flush nor shutdown may outlive its deadline or reject. */
  const settleTelemetry = async (kind: "flush" | "shutdown", deadlineMs: number): Promise<void> => {
    try {
      if (!consent().getSnapshot()) {
        try { activeAnalytics()?.discardPending(); } catch { /* isolated */ }
      } else {
        await settleWithin([...immediate], deadlineMs);
      }
      const client = activeAnalytics();
      await Promise.all([
        (kind === "flush" ? client?.flushWithin(deadlineMs) : client?.shutdownWithin(deadlineMs))
          ?.catch(() => undefined),
        (kind === "flush"
          ? flushTelemetryRuntimeWithin(deadlineMs)
          : shutdownTelemetryRuntimeWithin(deadlineMs)).catch(() => undefined),
      ]);
    } catch {
      // Telemetry lifecycle failures never change application behavior.
    }
  };

  const setupProperties = (
    input: SetupOperationBase & { stage: SetupStage; reason?: SetupReason },
    extra: object = {},
  ): object => ({ ...input, ...extra, ...metadata() });

  return {
    recordApplicationStart(): void {
      try {
        const current = consent().getSnapshot();
        const claimed = claimTelemetryFirstStart();
        if (!current || !claimed?.enabled) return;
        if (current.state.installId !== claimed.state.installId) return;
        if (current.state.consentGeneration !== claimed.state.consentGeneration) return;
        captureAnalytics(claimed, "app.first_start", metadata());
      } catch {
        // First-start attribution never affects CLI startup.
      }
    },

    recordProxyStarted(accountCount: number): void {
      const snapshot = consent().getSnapshot();
      if (!snapshot) return;
      captureAnalytics(snapshot, "proxy.started", {
        ...metadata(),
        accountPoolSize: clampedAccountCount(accountCount),
      });
    },

    startProxyHeartbeat(getAccountCount: () => number): void {
      if (!consent().getSnapshot()) return;
      try {
        const timer = setInterval(() => {
          try {
            const snapshot = consent().getSnapshot();
            if (!snapshot) return;
            captureAnalytics(snapshot, "proxy.heartbeat", {
              ...metadata(),
              accountPoolSize: clampedAccountCount(getAccountCount()),
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

    recordSafeLog,

    recordUpstreamStatus(
      operation: Operation,
      provider: Provider,
      httpStatusCode: number,
      extra?: RuntimeFailureExtras,
    ): void {
      recordSafeLog({
        operation,
        provider,
        severity: "warn",
        reason: httpFailureReason(httpStatusCode),
        outcome: httpOutcome(httpStatusCode),
        httpStatusCode,
        attempt: extra?.attempt,
        operationDurationMs: extra?.durationMs,
      });
    },

    recordRuntimeError(
      error: unknown,
      errorContext: RuntimeErrorContext,
      extra?: RuntimeFailureExtras,
    ): void {
      const expected = classifyExpectedRuntimeFailure(error);
      if (!expected) {
        recordUnexpectedException(error, {
          category: "runtime",
          reason: "other",
          operation: errorContext.operation,
          provider: errorContext.provider,
          runtimeMode: runtimeMode(),
        });
        return;
      }
      recordSafeLog({
        operation: errorContext.operation,
        provider: errorContext.provider,
        severity: "error",
        reason: expected,
        outcome: expected === "timeout" ? "timeout" : "upstream_error",
        attempt: extra?.attempt,
        operationDurationMs: extra?.durationMs,
      });
    },

    recordUnexpectedException,

    recordSetupStage(input: SetupStageInput): void {
      const snapshot = consent().getSnapshot();
      if (!snapshot) return;
      const properties = setupProperties(input);
      emitLog("account.setup.diagnostic", "info", properties);
      captureAnalytics(
        snapshot,
        input.stage === "attempt_start" ? "account_setup.started" : "account_setup.stage_completed",
        properties,
        input.diagnosticId,
      );
    },

    recordSetupStageFailure(input: ExpectedSetupFailureInput): void {
      if (!consent().getSnapshot()) return;
      const outcome = expectedSetupFailureOutcome(input.reason);
      emitLog("account.setup.diagnostic", "warn", setupProperties(
        input,
        outcome === undefined ? {} : { outcome },
      ));
    },

    recordSetupResult(input: SetupResultInput): void {
      const snapshot = consent().getSnapshot();
      if (!snapshot) return;
      const cancelled = input.result === "cancelled";
      const properties = setupProperties({
        ...input,
        stage: cancelled ? "cancellation" : "success",
        reason: cancelled ? "user_cancelled" : undefined,
      }, { outcome: cancelled ? "cancelled" : "complete" });
      emitLog("account.setup.diagnostic", "info", properties);
      captureAnalytics(
        snapshot,
        cancelled ? "account_setup.cancelled" : "account_setup.succeeded",
        properties,
        input.diagnosticId,
      );
    },

    recordExpectedSetupFailure(input: ExpectedSetupFailureInput): void {
      const snapshot = consent().getSnapshot();
      if (!snapshot) return;
      const outcome = expectedSetupFailureOutcome(input.reason);
      const properties = setupProperties(input, outcome === undefined ? {} : { outcome });
      emitLog("account.setup.diagnostic", "warn", properties);
      captureAnalytics(snapshot, "account_setup.failed", properties, input.diagnosticId);
    },

    flushTelemetryWithin: (deadlineMs: number) => settleTelemetry("flush", deadlineMs),
    shutdownTelemetryWithin: (deadlineMs: number) => settleTelemetry("shutdown", deadlineMs),
  };
}

const telemetry = createTelemetryFacade();

export const recordApplicationStart = telemetry.recordApplicationStart;
export const recordProxyStarted = telemetry.recordProxyStarted;
export const startProxyHeartbeat = telemetry.startProxyHeartbeat;
export const recordSafeLog = telemetry.recordSafeLog;
export const recordUpstreamStatus = telemetry.recordUpstreamStatus;
export const recordRuntimeError = telemetry.recordRuntimeError;
export const recordUnexpectedException = telemetry.recordUnexpectedException;
export const recordSetupStage = telemetry.recordSetupStage;
export const recordSetupStageFailure = telemetry.recordSetupStageFailure;
export const recordSetupResult = telemetry.recordSetupResult;
export const recordExpectedSetupFailure = telemetry.recordExpectedSetupFailure;
export const flushTelemetryWithin = telemetry.flushTelemetryWithin;
export const shutdownTelemetryWithin = telemetry.shutdownTelemetryWithin;
