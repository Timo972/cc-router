import {
  ANALYTICS_EVENT_NAMES,
  CPU_ARCHITECTURES,
  DURATION_BUCKETS,
  HTTP_METHODS,
  INSTRUMENTATION_SCOPES,
  LOG_EVENT_CODES,
  MAX_ACCOUNT_POOL_SIZE,
  MAX_ATTEMPT,
  MAX_CONCURRENCY,
  MAX_DURATION_MS,
  MAX_TIMESTAMP_MS,
  MAX_TOKEN_COUNT,
  MAX_VERSION_LENGTH,
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
} from "./constants.js";
import type {
  AnalyticsEventName,
  CpuArchitecture,
  DurationBucket,
  HttpMethod,
  InstrumentationScope,
  ModelFamily,
  Operation,
  OsFamily,
  Outcome,
  Provider,
  RequestSource,
  Route,
  RuntimeMode,
  SafeAnalyticsEvent,
  SafeLog,
  SafeResource,
  SafeRuntimeEventProperties,
  SafeRuntimeFailureAttributes,
  SafeSetupDiagnosticAttributes,
  SafeSetupEventProperties,
  SafeSpan,
  SafeSpanAttributes,
  SetupMethod,
  SetupReason,
  SetupStage,
  Severity,
  SpanKind,
  SpanStatusCode,
  StreamOutcome,
} from "./contracts.js";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function member<const T extends readonly string[]>(values: T, value: unknown): T[number] | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? value as T[number]
    : undefined;
}

function otherEnum<const T extends readonly string[]>(values: T, value: unknown): T[number] | undefined {
  if (value === undefined) return undefined;
  return member(values, value) ?? member(values, "other");
}

function boundedInteger(value: unknown, maximum: number, minimum = 0): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum
    ? value
    : undefined;
}

function boundedNumber(value: unknown, maximum: number, minimum = 0): number | undefined {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
    ? value
    : undefined;
}

function version(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_VERSION_LENGTH) return undefined;
  return /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/.test(value) ? value : undefined;
}

function uuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : undefined;
}

function hexId(value: unknown, length: 16 | 32): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return new RegExp(`^[0-9a-f]{${length}}$`).test(normalized) && !/^0+$/.test(normalized)
    ? normalized
    : undefined;
}

function httpStatusCode(value: unknown): number | undefined {
  return boundedInteger(value, 599, 100);
}

function setupMethodForProvider(provider: "anthropic" | "openai", value: unknown): SetupMethod | undefined {
  const method = member(SETUP_METHODS, value);
  if (provider === "anthropic") {
    return method === "macos_keychain" || method === "claude_credentials_file" || method === "manual_token"
      ? method
      : undefined;
  }
  return method === "manual_token" || method === "device_oauth" ? method : undefined;
}

function assignIfDefined<T extends object, K extends string, V>(target: T, key: K, value: V | undefined): void {
  if (value !== undefined) Object.assign(target, { [key]: value });
}

export function reconstructResource(input: unknown): SafeResource | undefined {
  if (!isRecord(input) || input.serviceName !== "cc-router") return undefined;

  const serviceVersion = version(input.serviceVersion);
  const nodeVersion = version(input.nodeVersion);
  const serviceInstanceId = uuid(input.serviceInstanceId);
  const runtimeMode = member(RUNTIME_MODES, input.runtimeMode);
  const osFamily = otherEnum(OS_FAMILIES, input.osFamily);
  const cpuArchitecture = otherEnum(CPU_ARCHITECTURES, input.cpuArchitecture);
  if (!serviceVersion || !nodeVersion || !serviceInstanceId || !runtimeMode || !osFamily || !cpuArchitecture) {
    return undefined;
  }

  return {
    "service.name": "cc-router",
    "service.version": serviceVersion,
    "service.instance.id": serviceInstanceId,
    "process.runtime.version": nodeVersion,
    "os.type": osFamily,
    "host.arch": cpuArchitecture,
    "cc_router.runtime_mode": runtimeMode,
  };
}

function reconstructSpanAttributes(input: unknown): SafeSpanAttributes {
  if (!isRecord(input)) return {};
  const output: SafeSpanAttributes = {};

  assignIfDefined(output, "httpMethod", member(HTTP_METHODS, input.httpMethod) as HttpMethod | undefined);
  assignIfDefined(output, "httpStatusCode", httpStatusCode(input.httpStatusCode));
  assignIfDefined(output, "provider", otherEnum(PROVIDERS, input.provider) as Provider | undefined);
  assignIfDefined(output, "route", otherEnum(ROUTES, input.route) as Route | undefined);
  assignIfDefined(output, "modelFamily", otherEnum(MODEL_FAMILIES, input.modelFamily) as ModelFamily | undefined);
  assignIfDefined(output, "requestSource", otherEnum(REQUEST_SOURCES, input.requestSource) as RequestSource | undefined);
  assignIfDefined(output, "runtimeMode", member(RUNTIME_MODES, input.runtimeMode) as RuntimeMode | undefined);
  assignIfDefined(output, "streaming", typeof input.streaming === "boolean" ? input.streaming : undefined);
  assignIfDefined(output, "streamOutcome", otherEnum(STREAM_OUTCOMES, input.streamOutcome) as StreamOutcome | undefined);
  assignIfDefined(output, "outcome", otherEnum(OUTCOMES, input.outcome) as Outcome | undefined);
  assignIfDefined(output, "attempt", boundedInteger(input.attempt, MAX_ATTEMPT));
  assignIfDefined(output, "accountPoolSize", boundedInteger(input.accountPoolSize, MAX_ACCOUNT_POOL_SIZE));
  assignIfDefined(output, "concurrency", boundedInteger(input.concurrency, MAX_CONCURRENCY));
  assignIfDefined(output, "inputTokens", boundedInteger(input.inputTokens, MAX_TOKEN_COUNT));
  assignIfDefined(output, "outputTokens", boundedInteger(input.outputTokens, MAX_TOKEN_COUNT));
  assignIfDefined(output, "operationDurationMs", boundedNumber(input.operationDurationMs, MAX_DURATION_MS));
  return output;
}

export function reconstructSpan(input: unknown): SafeSpan | undefined {
  if (!isRecord(input)) return undefined;
  const scope = member(INSTRUMENTATION_SCOPES, input.scope) as InstrumentationScope | undefined;
  const operation = member(OPERATIONS, input.operation) as Operation | undefined;
  const traceId = hexId(input.traceId, 32);
  const spanId = hexId(input.spanId, 16);
  const kind = member(SPAN_KINDS, input.kind) as SpanKind | undefined;
  const startTimeMs = boundedNumber(input.startTimeMs, MAX_TIMESTAMP_MS);
  const durationMs = boundedNumber(input.durationMs, MAX_DURATION_MS);
  const statusCode = member(SPAN_STATUS_CODES, input.statusCode) as SpanStatusCode | undefined;
  if (!scope || !operation || !traceId || !spanId || !kind || startTimeMs === undefined
    || durationMs === undefined || !statusCode) {
    return undefined;
  }

  const output: SafeSpan = {
    scope,
    name: operation,
    traceId,
    spanId,
    kind,
    startTimeMs,
    durationMs,
    statusCode,
    attributes: reconstructSpanAttributes(input.attributes),
  };
  assignIfDefined(output, "parentSpanId", hexId(input.parentSpanId, 16));
  return output;
}

function setupAttributes(input: unknown): SafeSetupDiagnosticAttributes | undefined {
  if (!isRecord(input)) return undefined;
  const provider = member(PROVIDERS, input.provider);
  if (provider !== "anthropic" && provider !== "openai") return undefined;
  const method = setupMethodForProvider(provider, input.method);
  const stage = member(SETUP_STAGES, input.stage) as SetupStage | undefined;
  if (!method || !stage) return undefined;

  const output: SafeSetupDiagnosticAttributes = { provider, method, stage };
  assignIfDefined(output, "reason", otherEnum(SETUP_REASONS, input.reason) as SetupReason | undefined);
  assignIfDefined(output, "outcome", otherEnum(OUTCOMES, input.outcome) as Outcome | undefined);
  assignIfDefined(output, "httpStatusCode", httpStatusCode(input.httpStatusCode));
  assignIfDefined(output, "durationBucket", member(DURATION_BUCKETS, input.durationBucket) as DurationBucket | undefined);
  assignIfDefined(output, "serviceVersion", version(input.serviceVersion));
  assignIfDefined(output, "osFamily", otherEnum(OS_FAMILIES, input.osFamily) as OsFamily | undefined);
  assignIfDefined(output, "runtimeMode", member(RUNTIME_MODES, input.runtimeMode) as RuntimeMode | undefined);
  assignIfDefined(output, "diagnosticId", uuid(input.diagnosticId));
  return output;
}

function runtimeFailureAttributes(input: unknown): SafeRuntimeFailureAttributes | undefined {
  if (!isRecord(input)) return undefined;
  const operation = member(OPERATIONS, input.operation) as Operation | undefined;
  const reason = otherEnum(SETUP_REASONS, input.reason) as SetupReason | undefined;
  if (!operation || !reason) return undefined;
  const output: SafeRuntimeFailureAttributes = { operation, reason };
  assignIfDefined(output, "provider", otherEnum(PROVIDERS, input.provider) as Provider | undefined);
  assignIfDefined(output, "outcome", otherEnum(OUTCOMES, input.outcome) as Outcome | undefined);
  assignIfDefined(output, "httpStatusCode", httpStatusCode(input.httpStatusCode));
  assignIfDefined(output, "attempt", boundedInteger(input.attempt, MAX_ATTEMPT));
  assignIfDefined(output, "accountPoolSize", boundedInteger(input.accountPoolSize, MAX_ACCOUNT_POOL_SIZE));
  assignIfDefined(output, "concurrency", boundedInteger(input.concurrency, MAX_CONCURRENCY));
  assignIfDefined(output, "operationDurationMs", boundedNumber(input.operationDurationMs, MAX_DURATION_MS));
  assignIfDefined(output, "serviceVersion", version(input.serviceVersion));
  assignIfDefined(output, "osFamily", otherEnum(OS_FAMILIES, input.osFamily) as OsFamily | undefined);
  assignIfDefined(output, "runtimeMode", member(RUNTIME_MODES, input.runtimeMode) as RuntimeMode | undefined);
  assignIfDefined(output, "diagnosticId", uuid(input.diagnosticId));
  return output;
}

export function reconstructLog(input: unknown): SafeLog | undefined {
  if (!isRecord(input)) return undefined;
  const body = member(LOG_EVENT_CODES, input.body);
  const severity = member(SEVERITIES, input.severity) as Severity | undefined;
  const timestampMs = boundedNumber(input.timestampMs, MAX_TIMESTAMP_MS);
  if (!body || !severity || timestampMs === undefined) return undefined;

  const attributes = body === "account.setup.diagnostic"
    ? setupAttributes(input.attributes)
    : runtimeFailureAttributes(input.attributes);
  if (!attributes) return undefined;

  const context: { traceId?: string; spanId?: string } = {};
  assignIfDefined(context, "traceId", hexId(input.traceId, 32));
  assignIfDefined(context, "spanId", hexId(input.spanId, 16));
  if (body === "account.setup.diagnostic") {
    return { body, severity, timestampMs, ...context, attributes: attributes as SafeSetupDiagnosticAttributes };
  }
  return { body, severity, timestampMs, ...context, attributes: attributes as SafeRuntimeFailureAttributes };
}

function runtimeEventProperties(input: unknown): SafeRuntimeEventProperties | undefined {
  if (!isRecord(input)) return undefined;
  const output: SafeRuntimeEventProperties = {};
  assignIfDefined(output, "serviceVersion", version(input.serviceVersion));
  assignIfDefined(output, "osFamily", otherEnum(OS_FAMILIES, input.osFamily) as OsFamily | undefined);
  assignIfDefined(output, "runtimeMode", member(RUNTIME_MODES, input.runtimeMode) as RuntimeMode | undefined);
  return output;
}

function setupEventProperties(input: unknown): SafeSetupEventProperties | undefined {
  const attributes = setupAttributes(input);
  if (!attributes) return undefined;
  const output: SafeSetupEventProperties = {
    provider: attributes.provider,
    method: attributes.method,
    stage: attributes.stage,
  };
  assignIfDefined(output, "reason", attributes.reason);
  assignIfDefined(output, "durationBucket", attributes.durationBucket);
  assignIfDefined(output, "serviceVersion", attributes.serviceVersion);
  assignIfDefined(output, "osFamily", attributes.osFamily);
  assignIfDefined(output, "runtimeMode", attributes.runtimeMode);
  assignIfDefined(output, "diagnosticId", attributes.diagnosticId);
  return output;
}

export function reconstructAnalyticsEvent(input: unknown): SafeAnalyticsEvent | undefined {
  if (!isRecord(input)) return undefined;
  const event = member(ANALYTICS_EVENT_NAMES, input.event) as AnalyticsEventName | undefined;
  const distinctId = uuid(input.distinctId);
  if (!event || !distinctId) return undefined;

  const properties = event.startsWith("account_setup.")
    ? setupEventProperties(input.properties)
    : runtimeEventProperties(input.properties);
  if (!properties) return undefined;

  const privacy = { distinctId, processPersonProfile: false as const, disableGeoip: true as const };
  switch (event) {
    case "app.first_start":
      return { event, ...privacy, properties: properties as SafeRuntimeEventProperties };
    case "account_setup.started":
    case "account_setup.stage_completed":
    case "account_setup.succeeded":
    case "account_setup.cancelled":
    case "account_setup.failed":
      return { event, ...privacy, properties: properties as SafeSetupEventProperties };
    case "proxy.started":
    case "proxy.heartbeat":
      return { event, ...privacy, properties: properties as SafeRuntimeEventProperties };
  }
}
