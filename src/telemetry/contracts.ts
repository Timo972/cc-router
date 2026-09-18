// Every value telemetry may export comes from one of the closed enums below.
// Anything outside them is dropped by privacy.ts rather than sanitized.

export const RUNTIME_MODES = ["foreground", "daemon", "service"] as const;
export const PROVIDERS = ["anthropic", "openai", "other"] as const;
export const ROUTES = ["messages", "responses", "other"] as const;
export const REQUEST_SOURCES = ["cli", "desktop", "api", "other"] as const;
export const MODEL_FAMILIES = ["fable", "sonnet", "opus", "haiku", "codex", "other"] as const;

export const OPERATIONS = [
  "proxy.request",
  "provider.inference",
  "oauth.refresh",
  "provider.usage_refresh",
  "model.discovery",
] as const;

export const SETUP_METHODS = [
  "macos_keychain",
  "claude_credentials_file",
  "manual_token",
  "device_oauth",
  "claude_cli_login",
  "claude_setup_token",
] as const;

export const SETUP_STAGES = [
  "attempt_start",
  "credential_source_selection",
  "credential_read",
  "credential_parse",
  "token_validation",
  "device_code_request",
  "authorization_polling",
  "token_exchange",
  "access_token_parse",
  "persistence",
  "success",
  "cancellation",
  "failure",
] as const;

export const SETUP_REASONS = [
  "not_found",
  "permission_denied",
  "malformed_credentials",
  "invalid_token",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "upstream_4xx",
  "upstream_5xx",
  "timeout",
  "network_failure",
  "unexpected_response_shape",
  "persistence_failure",
  "user_cancelled",
  "other",
] as const;

export const OUTCOMES = [
  "complete",
  "rate_limited",
  "timeout",
  "upstream_error",
  "cancelled",
  "other",
] as const;

export const STREAM_OUTCOMES = [
  "complete",
  "timeout",
  "upstream_error",
  "cancelled",
  "other",
] as const;

export const ERROR_KINDS = [
  "error",
  "type_error",
  "range_error",
  "reference_error",
  "syntax_error",
  "uri_error",
  "eval_error",
  "aggregate_error",
  "unexpected_error",
] as const;

export const SYSTEM_ERROR_CODES = [
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
] as const;

export const SEVERITIES = ["info", "warn", "error", "fatal"] as const;
export const HTTP_METHODS = ["GET", "POST"] as const;
export const SPAN_KINDS = ["internal", "server", "client"] as const;
export const SPAN_STATUS_CODES = ["unset", "ok", "error"] as const;
export const OS_FAMILIES = ["macos", "linux", "windows", "other"] as const;
export const CPU_ARCHITECTURES = ["arm64", "x64", "other"] as const;
export const DURATION_BUCKETS = [
  "under_1s",
  "1s_to_5s",
  "5s_to_30s",
  "30s_to_2m",
  "over_2m",
] as const;

// Manual spans only: cc-router is the sole instrumentation scope.
export const INSTRUMENTATION_SCOPES = ["cc-router"] as const;

export const LOG_EVENT_CODES = ["account.setup.diagnostic", "runtime.failure"] as const;
export const ANALYTICS_EVENT_NAMES = [
  "app.first_start",
  "account_setup.started",
  "account_setup.stage_completed",
  "account_setup.succeeded",
  "account_setup.cancelled",
  "account_setup.failed",
  "proxy.started",
  "proxy.heartbeat",
] as const;

export const MAX_VERSION_LENGTH = 64;
export const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
export const MAX_DURATION_MS = 86_400_000;
export const MAX_ATTEMPT = 100;
export const MAX_ACCOUNT_POOL_SIZE = 10_000;
export const MAX_CONCURRENCY = 10_000;
export const MAX_TOKEN_COUNT = 1_000_000_000;
export const MAX_STACK_FRAMES = 20;
export const MAX_STACK_FRAME_PATH_LENGTH = 256;

export const POSTHOG_HOST = "https://eu.i.posthog.com";
export const POSTHOG_INGESTION_HOSTNAME = "eu.i.posthog.com";
export const POSTHOG_PROJECT_TOKEN = "phc_n7wcYbbfMSkNxRoB8JVd57PYQZf7DNaEGL2kUeUkxwV2";
export const POSTHOG_REQUEST_TIMEOUT_MS = 2_000;
export const POSTHOG_FLUSH_INTERVAL_MS = 5_000;
export const POSTHOG_FLUSH_AT = 20;
export const POSTHOG_MAX_QUEUE_SIZE = 100;

type ValueOf<T extends readonly string[]> = T[number];

export type RuntimeMode = ValueOf<typeof RUNTIME_MODES>;
export type Provider = ValueOf<typeof PROVIDERS>;
export type Route = ValueOf<typeof ROUTES>;
export type RequestSource = ValueOf<typeof REQUEST_SOURCES>;
export type ModelFamily = ValueOf<typeof MODEL_FAMILIES>;
export type Operation = ValueOf<typeof OPERATIONS>;
export type SetupMethod = ValueOf<typeof SETUP_METHODS>;
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
export type AnalyticsEventName = ValueOf<typeof ANALYTICS_EVENT_NAMES>;
export type SystemErrorCode = ValueOf<typeof SYSTEM_ERROR_CODES>;

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
  "service.instance.id": string;
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
  diagnosticId: string;
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
  diagnosticId?: string;
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
  diagnosticId: string;
}

export interface SafeAnalyticsEvent {
  event: AnalyticsEventName;
  properties: SafeSetupEventProperties | SafeRuntimeEventProperties;
  /** Trusted install identity; never taken from the candidate event. */
  installationId: string;
  diagnosticId?: string;
}

export interface SafeStackFrame {
  function?: string;
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

export interface SafeExceptionContract {
  /** The only Error object that may be passed to a remote exception client. */
  error: Error;
  errorName: string;
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
  fingerprint: string;
  diagnosticId: string;
}
