import type {
  ANALYTICS_EVENT_NAMES,
  CPU_ARCHITECTURES,
  DURATION_BUCKETS,
  ERROR_KINDS,
  HTTP_METHODS,
  INSTRUMENTATION_SCOPES,
  LOG_EVENT_CODES,
  MODEL_FAMILIES,
  OPERATIONS,
  OS_FAMILIES,
  OUTCOMES,
  PROVIDERS,
  REQUEST_SOURCES,
  ROUTES,
  RUNTIME_MODES,
  SETUP_METHODS,
  SETUP_REASONS,
  SETUP_STAGES,
  SEVERITIES,
  SPAN_KINDS,
  SPAN_STATUS_CODES,
  STREAM_OUTCOMES,
  SYSTEM_ERROR_CODES,
} from "./constants.js";

type ValueOf<T extends readonly string[]> = T[number];

export type RuntimeMode = ValueOf<typeof RUNTIME_MODES>;
export type Provider = ValueOf<typeof PROVIDERS>;
export type Route = ValueOf<typeof ROUTES>;
export type RequestSource = ValueOf<typeof REQUEST_SOURCES>;
export type ModelFamily = ValueOf<typeof MODEL_FAMILIES>;
export type Operation = ValueOf<typeof OPERATIONS>;
export type SetupMethod = ValueOf<typeof SETUP_METHODS>;
export type Method = SetupMethod;
export type SetupStage = ValueOf<typeof SETUP_STAGES>;
export type SetupReason = ValueOf<typeof SETUP_REASONS>;
export type Outcome = ValueOf<typeof OUTCOMES>;
export type StreamOutcome = ValueOf<typeof STREAM_OUTCOMES>;
export type ErrorKind = ValueOf<typeof ERROR_KINDS>;
export type Severity = ValueOf<typeof SEVERITIES>;
export type HttpMethod = ValueOf<typeof HTTP_METHODS>;
export type SpanKind = ValueOf<typeof SPAN_KINDS>;
export type SpanStatusCode = ValueOf<typeof SPAN_STATUS_CODES>;
export type OsFamily = ValueOf<typeof OS_FAMILIES>;
export type CpuArchitecture = ValueOf<typeof CPU_ARCHITECTURES>;
export type DurationBucket = ValueOf<typeof DURATION_BUCKETS>;
export type InstrumentationScope = ValueOf<typeof INSTRUMENTATION_SCOPES>;
export type LogEventCode = ValueOf<typeof LOG_EVENT_CODES>;
export type AnalyticsEventName = ValueOf<typeof ANALYTICS_EVENT_NAMES>;
export type SystemErrorCode = ValueOf<typeof SYSTEM_ERROR_CODES>;

declare const installationIdBrand: unique symbol;
declare const diagnosticIdBrand: unique symbol;

export type InstallationId = string & { readonly [installationIdBrand]: true };
export type DiagnosticId = string & { readonly [diagnosticIdBrand]: true };

/**
 * Identity values supplied outside the untrusted telemetry candidate. Callers
 * source installationId from getTelemetrySnapshot() and create diagnosticId
 * once per setup attempt or exception occurrence.
 */
export interface TrustedTelemetryIdentity {
  installationId: string;
  diagnosticId?: string;
}

export interface SafeResource {
  "service.name": "cc-router";
  "service.version": string;
  "service.instance.id": InstallationId;
  "process.runtime.version": string;
  "os.type": OsFamily;
  "host.arch": CpuArchitecture;
  "cc_router.runtime_mode": RuntimeMode;
}

export interface SafeSpanAttributes {
  httpMethod?: HttpMethod;
  httpStatusCode?: number;
  provider?: Provider;
  route?: Route;
  modelFamily?: ModelFamily;
  requestSource?: RequestSource;
  runtimeMode?: RuntimeMode;
  streaming?: boolean;
  streamOutcome?: StreamOutcome;
  outcome?: Outcome;
  attempt?: number;
  accountPoolSize?: number;
  concurrency?: number;
  inputTokens?: number;
  outputTokens?: number;
  operationDurationMs?: number;
}

export interface SafeSpan {
  scope: InstrumentationScope;
  name: Operation;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: SpanKind;
  startTimeMs: number;
  durationMs: number;
  statusCode: SpanStatusCode;
  attributes: SafeSpanAttributes;
}

export interface SafeSetupDiagnosticAttributes {
  provider: Exclude<Provider, "other">;
  method: SetupMethod;
  stage: SetupStage;
  reason?: SetupReason;
  outcome?: Outcome;
  httpStatusCode?: number;
  durationBucket?: DurationBucket;
  serviceVersion?: string;
  osFamily?: OsFamily;
  runtimeMode?: RuntimeMode;
  diagnosticId: DiagnosticId;
}

export interface SafeRuntimeFailureAttributes {
  operation: Operation;
  provider?: Provider;
  reason: SetupReason;
  outcome?: Outcome;
  httpStatusCode?: number;
  attempt?: number;
  accountPoolSize?: number;
  concurrency?: number;
  operationDurationMs?: number;
  serviceVersion?: string;
  osFamily?: OsFamily;
  runtimeMode?: RuntimeMode;
  diagnosticId?: DiagnosticId;
}

interface SafeLogBase {
  scope: InstrumentationScope;
  severity: Severity;
  timestampMs: number;
  traceId?: string;
  spanId?: string;
}

export interface SafeSetupDiagnosticLog extends SafeLogBase {
  body: "account.setup.diagnostic";
  attributes: SafeSetupDiagnosticAttributes;
}

export interface SafeRuntimeFailureLog extends SafeLogBase {
  body: "runtime.failure";
  attributes: SafeRuntimeFailureAttributes;
}

export type SafeLog = SafeSetupDiagnosticLog | SafeRuntimeFailureLog;

export interface SafeRuntimeEventProperties {
  serviceVersion?: string;
  osFamily?: OsFamily;
  runtimeMode?: RuntimeMode;
  accountPoolSize?: number;
}

export interface SafeSetupEventProperties extends SafeRuntimeEventProperties {
  provider: Exclude<Provider, "other">;
  method: SetupMethod;
  stage: SetupStage;
  reason?: SetupReason;
  durationBucket?: DurationBucket;
  diagnosticId: DiagnosticId;
}

interface SafeAnalyticsEventBase {
  distinctId: InstallationId;
  processPersonProfile: false;
  disableGeoip: true;
}

export interface SafeFirstStartEvent extends SafeAnalyticsEventBase {
  event: "app.first_start";
  properties: SafeRuntimeEventProperties;
}

export interface SafeAccountSetupStartedEvent extends SafeAnalyticsEventBase {
  event: "account_setup.started";
  properties: SafeSetupEventProperties;
}

export interface SafeAccountSetupStageCompletedEvent extends SafeAnalyticsEventBase {
  event: "account_setup.stage_completed";
  properties: SafeSetupEventProperties;
}

export interface SafeAccountSetupSucceededEvent extends SafeAnalyticsEventBase {
  event: "account_setup.succeeded";
  properties: SafeSetupEventProperties;
}

export interface SafeAccountSetupCancelledEvent extends SafeAnalyticsEventBase {
  event: "account_setup.cancelled";
  properties: SafeSetupEventProperties;
}

export interface SafeAccountSetupFailedEvent extends SafeAnalyticsEventBase {
  event: "account_setup.failed";
  properties: SafeSetupEventProperties;
}

export interface SafeProxyStartedEvent extends SafeAnalyticsEventBase {
  event: "proxy.started";
  properties: SafeRuntimeEventProperties;
}

export interface SafeProxyHeartbeatEvent extends SafeAnalyticsEventBase {
  event: "proxy.heartbeat";
  properties: SafeRuntimeEventProperties;
}

export type SafeAnalyticsEvent =
  | SafeFirstStartEvent
  | SafeAccountSetupStartedEvent
  | SafeAccountSetupStageCompletedEvent
  | SafeAccountSetupSucceededEvent
  | SafeAccountSetupCancelledEvent
  | SafeAccountSetupFailedEvent
  | SafeProxyStartedEvent
  | SafeProxyHeartbeatEvent;

declare const safeFingerprint: unique symbol;

export type SafeFingerprint = string & { readonly [safeFingerprint]: true };

export interface SafeStackFrame {
  path: `dist/${string}` | `node_modules/${string}`;
  line?: number;
  column?: number;
}

/** Closed caller-supplied classification for an exception occurrence. */
export interface SafeExceptionContext {
  category: "setup" | "runtime";
  reason: SetupReason;
  operation?: Operation;
  provider?: Provider;
  setupStage?: SetupStage;
  runtimeMode?: RuntimeMode;
}

/** Filesystem trust supplied independently from the untrusted exception. */
export interface TrustedExceptionSource {
  projectRoot: string;
}

export interface SafeExceptionContract {
  /** The only Error object that may be passed to a remote exception client. */
  error: Error;
  category: "setup" | "runtime";
  reason: SetupReason;
  errorKind: ErrorKind;
  systemErrorCode?: SystemErrorCode;
  httpStatusCode?: number;
  operation?: Operation;
  provider?: Provider;
  setupStage?: SetupStage;
  runtimeMode?: RuntimeMode;
  frames: readonly SafeStackFrame[];
  fingerprint: SafeFingerprint;
  diagnosticId: DiagnosticId;
}
