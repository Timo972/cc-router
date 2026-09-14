import { createHash } from "node:crypto";
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
  MAX_STACK_FRAMES,
  MAX_STACK_FRAME_PATH_LENGTH,
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
  SYSTEM_ERROR_CODES,
} from "./constants.js";
import type {
  AnalyticsEventName,
  CpuArchitecture,
  DurationBucket,
  ErrorKind,
  HttpMethod,
  InstallationId,
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
  SafeExceptionContract,
  SafeExceptionContext,
  SafeFingerprint,
  SafeLog,
  SafeResource,
  SafeRuntimeEventProperties,
  SafeRuntimeFailureAttributes,
  SafeSetupDiagnosticAttributes,
  SafeSetupEventProperties,
  SafeSpan,
  SafeSpanAttributes,
  SafeStackFrame,
  SetupMethod,
  SetupReason,
  SetupStage,
  Severity,
  SpanKind,
  SpanStatusCode,
  StreamOutcome,
  SystemErrorCode,
  TrustedExceptionSource,
  TrustedTelemetryIdentity,
  DiagnosticId,
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

function installationId(identity: TrustedTelemetryIdentity): InstallationId | undefined {
  return uuid(identity?.installationId) as InstallationId | undefined;
}

function diagnosticId(
  identity: TrustedTelemetryIdentity,
  trustedInstallationId: InstallationId,
): DiagnosticId | undefined {
  if (identity?.diagnosticId === undefined) return undefined;
  const value = uuid(identity.diagnosticId);
  return value && value !== trustedInstallationId ? value as DiagnosticId : undefined;
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

function ownDataProperty(input: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isErrorObject(input: unknown): input is Error {
  try {
    return input instanceof Error;
  } catch {
    return false;
  }
}

function errorKind(input: Error): ErrorKind {
  try {
    if (typeof AggregateError !== "undefined" && input instanceof AggregateError) return "aggregate_error";
    if (input instanceof TypeError) return "type_error";
    if (input instanceof RangeError) return "range_error";
    if (input instanceof ReferenceError) return "reference_error";
    if (input instanceof SyntaxError) return "syntax_error";
    if (input instanceof URIError) return "uri_error";
    if (input instanceof EvalError) return "eval_error";
  } catch {
    return "error";
  }
  return "error";
}

function safePathSegments(path: string): boolean {
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
    && /^[0-9A-Za-z@._+~-]+$/.test(segment));
}

interface TrustedProjectRoot {
  comparisonPath: string;
  caseInsensitive: boolean;
}

function trustedProjectRoot(input: unknown): TrustedProjectRoot | undefined {
  if (!isRecord(input)) return undefined;
  let candidate: unknown;
  try {
    candidate = input.projectRoot;
  } catch {
    return undefined;
  }
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;

  let path = candidate.replace(/\\/g, "/");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path) || /[?#\u0000-\u001f\u007f]/.test(path)) {
    return undefined;
  }
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  const windowsAbsolute = /^[A-Za-z]:\//.test(path);
  const posixAbsolute = path.startsWith("/") && !path.startsWith("//");
  if (!windowsAbsolute && !posixAbsolute) return undefined;
  const segments = path.replace(/^[A-Za-z]:\//, "").replace(/^\//, "").split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }

  return {
    comparisonPath: windowsAbsolute ? path.toLowerCase() : path,
    caseInsensitive: windowsAbsolute,
  };
}

function normalizedFramePath(
  rawPath: string,
  projectRoot: TrustedProjectRoot,
): SafeStackFrame["path"] | undefined {
  let path = rawPath.trim().replace(/\\/g, "/");
  const openingParenthesis = path.lastIndexOf("(");
  if (openingParenthesis >= 0) path = path.slice(openingParenthesis + 1);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path) && !path.startsWith("file://")) return undefined;
  if (path.startsWith("file://")) path = path.slice("file://".length);
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  if (/[?#\u0000-\u001f\u007f]/.test(path)) return undefined;

  const comparisonPath = projectRoot.caseInsensitive ? path.toLowerCase() : path;
  const projectDistPrefix = `${projectRoot.comparisonPath}/dist/`;
  if (comparisonPath.startsWith(projectDistPrefix)) {
    const relative = `dist/${path.slice(projectDistPrefix.length)}`;
    if (relative.length > MAX_STACK_FRAME_PATH_LENGTH || !safePathSegments(relative)) return undefined;
    return relative as SafeStackFrame["path"];
  }

  const dependencyMarker = "/node_modules/";
  const dependencyIndex = path.lastIndexOf(dependencyMarker);
  if (dependencyIndex >= 0) {
    const relative = path.slice(dependencyIndex + 1);
    const segments = relative.split("/");
    const packageSegmentCount = segments[1]?.startsWith("@") ? 2 : 1;
    if (segments.length < packageSegmentCount + 2 || !safePathSegments(relative)) return undefined;
    return relative.length <= MAX_STACK_FRAME_PATH_LENGTH
      ? relative as SafeStackFrame["path"]
      : undefined;
  }

  return undefined;
}

function stackHeaderName(kind: ErrorKind): string {
  switch (kind) {
    case "type_error": return "TypeError";
    case "range_error": return "RangeError";
    case "reference_error": return "ReferenceError";
    case "syntax_error": return "SyntaxError";
    case "uri_error": return "URIError";
    case "eval_error": return "EvalError";
    case "aggregate_error": return "AggregateError";
    case "error": return "Error";
    case "unexpected_error": return "Error";
  }
}

function normalizedFrames(
  input: Error,
  kind: ErrorKind,
  projectRoot: TrustedProjectRoot,
): readonly SafeStackFrame[] {
  let stack: unknown;
  try {
    stack = input.stack;
  } catch {
    return [];
  }
  if (typeof stack !== "string") return [];

  const rawMessage = ownDataProperty(input, "message");
  if (rawMessage !== undefined && typeof rawMessage !== "string") return [];
  const message = rawMessage ?? "";
  const header = `${stackHeaderName(kind)}${message.length === 0 ? "" : `: ${message}`}`;
  if (stack === header) return [];
  if (!stack.startsWith(`${header}\n`)) return [];

  const frames: SafeStackFrame[] = [];
  for (const line of stack.slice(header.length + 1).split("\n")) {
    if (frames.length >= MAX_STACK_FRAMES) break;
    const match = line.match(/(?:\(|\bat\s+)(.+):(\d+):(\d+)\)?\s*$/);
    if (!match) continue;
    const path = normalizedFramePath(match[1], projectRoot);
    const frameLine = boundedInteger(Number(match[2]), Number.MAX_SAFE_INTEGER, 1);
    const column = boundedInteger(Number(match[3]), Number.MAX_SAFE_INTEGER, 1);
    if (!path || frameLine === undefined || column === undefined) continue;
    frames.push({ path, line: frameLine, column });
  }
  return frames;
}

function sanitizedError(reason: SetupReason, frames: readonly SafeStackFrame[]): Error {
  const error = new Error(reason);
  error.stack = [
    `Error: ${reason}`,
    ...frames.map((frame) => `    at ${frame.path}${frame.line === undefined ? "" : `:${frame.line}`}${frame.column === undefined ? "" : `:${frame.column}`}`),
  ].join("\n");
  return error;
}

function fingerprint(
  kind: ErrorKind,
  context: SafeExceptionContext,
  systemErrorCode: SystemErrorCode | undefined,
  status: number | undefined,
  frames: readonly SafeStackFrame[],
): SafeFingerprint {
  const safeInput = {
    errorKind: kind,
    category: context.category,
    reason: context.reason,
    operation: context.operation,
    provider: context.provider,
    setupStage: context.setupStage,
    runtimeMode: context.runtimeMode,
    systemErrorCode,
    httpStatusCode: status,
    frames,
  };
  return createHash("sha256").update(JSON.stringify(safeInput)).digest("hex") as SafeFingerprint;
}

function exceptionContext(input: unknown): SafeExceptionContext | undefined {
  if (!isRecord(input)) return undefined;
  const category = input.category === "setup" || input.category === "runtime" ? input.category : undefined;
  const reason = otherEnum(SETUP_REASONS, input.reason) as SetupReason | undefined;
  if (!category || !reason) return undefined;

  const output: SafeExceptionContext = { category, reason };
  assignIfDefined(output, "operation", member(OPERATIONS, input.operation) as Operation | undefined);
  assignIfDefined(output, "provider", otherEnum(PROVIDERS, input.provider) as Provider | undefined);
  assignIfDefined(output, "setupStage", member(SETUP_STAGES, input.setupStage) as SetupStage | undefined);
  assignIfDefined(output, "runtimeMode", member(RUNTIME_MODES, input.runtimeMode) as RuntimeMode | undefined);
  return output;
}

/**
 * Reconstruct an exception from closed safe values. No original Error object or
 * arbitrary thrown-value property escapes this boundary.
 */
export function sanitizeException(
  input: unknown,
  candidateContext: unknown,
  identity: TrustedTelemetryIdentity,
  trustedSource: TrustedExceptionSource,
): SafeExceptionContract | undefined {
  const trustedInstallationId = installationId(identity);
  if (!trustedInstallationId) return undefined;
  const trustedDiagnosticId = diagnosticId(identity, trustedInstallationId);
  const context = exceptionContext(candidateContext);
  const projectRoot = trustedProjectRoot(trustedSource);
  if (!trustedDiagnosticId || !context || !projectRoot) return undefined;

  const isError = isErrorObject(input);
  const kind: ErrorKind = isError ? errorKind(input) : "unexpected_error";
  const frames = isError ? normalizedFrames(input, kind, projectRoot) : [];
  const code = isError
    ? member(SYSTEM_ERROR_CODES, ownDataProperty(input, "code")) as SystemErrorCode | undefined
    : undefined;
  const status = isError
    ? httpStatusCode(ownDataProperty(input, "statusCode"))
      ?? httpStatusCode(ownDataProperty(input, "status"))
    : undefined;
  const output: SafeExceptionContract = {
    error: sanitizedError(context.reason, frames),
    ...context,
    errorKind: kind,
    frames,
    fingerprint: fingerprint(kind, context, code, status, frames),
    diagnosticId: trustedDiagnosticId,
  };
  assignIfDefined(output, "systemErrorCode", code);
  assignIfDefined(output, "httpStatusCode", status);
  return output;
}

export function reconstructResource(
  input: unknown,
  identity: TrustedTelemetryIdentity,
): SafeResource | undefined {
  if (!isRecord(input) || input.serviceName !== "cc-router") return undefined;

  const serviceVersion = version(input.serviceVersion);
  const nodeVersion = version(input.nodeVersion);
  const serviceInstanceId = installationId(identity);
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

function setupAttributes(input: unknown, trustedDiagnosticId: DiagnosticId): SafeSetupDiagnosticAttributes | undefined {
  if (!isRecord(input)) return undefined;
  const provider = member(PROVIDERS, input.provider);
  if (provider !== "anthropic" && provider !== "openai") return undefined;
  const method = setupMethodForProvider(provider, input.method);
  const stage = member(SETUP_STAGES, input.stage) as SetupStage | undefined;
  if (!method || !stage) return undefined;

  const output: SafeSetupDiagnosticAttributes = {
    provider,
    method,
    stage,
    diagnosticId: trustedDiagnosticId,
  };
  assignIfDefined(output, "reason", otherEnum(SETUP_REASONS, input.reason) as SetupReason | undefined);
  assignIfDefined(output, "outcome", otherEnum(OUTCOMES, input.outcome) as Outcome | undefined);
  assignIfDefined(output, "httpStatusCode", httpStatusCode(input.httpStatusCode));
  assignIfDefined(output, "durationBucket", member(DURATION_BUCKETS, input.durationBucket) as DurationBucket | undefined);
  assignIfDefined(output, "serviceVersion", version(input.serviceVersion));
  assignIfDefined(output, "osFamily", otherEnum(OS_FAMILIES, input.osFamily) as OsFamily | undefined);
  assignIfDefined(output, "runtimeMode", member(RUNTIME_MODES, input.runtimeMode) as RuntimeMode | undefined);
  return output;
}

function runtimeFailureAttributes(
  input: unknown,
  trustedDiagnosticId: DiagnosticId | undefined,
): SafeRuntimeFailureAttributes | undefined {
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
  assignIfDefined(output, "diagnosticId", trustedDiagnosticId);
  return output;
}

export function reconstructLog(input: unknown, identity: TrustedTelemetryIdentity): SafeLog | undefined {
  if (!isRecord(input)) return undefined;
  const scope = member(INSTRUMENTATION_SCOPES, input.scope) as InstrumentationScope | undefined;
  const body = member(LOG_EVENT_CODES, input.body);
  const severity = member(SEVERITIES, input.severity) as Severity | undefined;
  const timestampMs = boundedNumber(input.timestampMs, MAX_TIMESTAMP_MS);
  const trustedInstallationId = installationId(identity);
  if (!scope || !body || !severity || timestampMs === undefined || !trustedInstallationId) return undefined;

  const trustedDiagnosticId = diagnosticId(
    identity,
    trustedInstallationId,
  );
  if (body === "account.setup.diagnostic" && !trustedDiagnosticId) return undefined;
  if (identity.diagnosticId !== undefined && !trustedDiagnosticId) return undefined;

  const attributes = body === "account.setup.diagnostic"
    ? setupAttributes(input.attributes, trustedDiagnosticId as DiagnosticId)
    : runtimeFailureAttributes(input.attributes, trustedDiagnosticId);
  if (!attributes) return undefined;

  const context: { traceId?: string; spanId?: string } = {};
  assignIfDefined(context, "traceId", hexId(input.traceId, 32));
  assignIfDefined(context, "spanId", hexId(input.spanId, 16));
  if (body === "account.setup.diagnostic") {
    return { scope, body, severity, timestampMs, ...context, attributes: attributes as SafeSetupDiagnosticAttributes };
  }
  return { scope, body, severity, timestampMs, ...context, attributes: attributes as SafeRuntimeFailureAttributes };
}

function runtimeEventProperties(input: unknown): SafeRuntimeEventProperties | undefined {
  if (!isRecord(input)) return undefined;
  const output: SafeRuntimeEventProperties = {};
  assignIfDefined(output, "serviceVersion", version(input.serviceVersion));
  assignIfDefined(output, "osFamily", otherEnum(OS_FAMILIES, input.osFamily) as OsFamily | undefined);
  assignIfDefined(output, "runtimeMode", member(RUNTIME_MODES, input.runtimeMode) as RuntimeMode | undefined);
  assignIfDefined(output, "accountPoolSize", boundedInteger(input.accountPoolSize, MAX_ACCOUNT_POOL_SIZE));
  return output;
}

function setupEventProperties(
  input: unknown,
  trustedDiagnosticId: DiagnosticId,
): SafeSetupEventProperties | undefined {
  const attributes = setupAttributes(input, trustedDiagnosticId);
  if (!attributes) return undefined;
  const output: SafeSetupEventProperties = {
    provider: attributes.provider,
    method: attributes.method,
    stage: attributes.stage,
    diagnosticId: trustedDiagnosticId,
  };
  assignIfDefined(output, "reason", attributes.reason);
  assignIfDefined(output, "durationBucket", attributes.durationBucket);
  assignIfDefined(output, "serviceVersion", attributes.serviceVersion);
  assignIfDefined(output, "osFamily", attributes.osFamily);
  assignIfDefined(output, "runtimeMode", attributes.runtimeMode);
  return output;
}

export function reconstructAnalyticsEvent(
  input: unknown,
  identity: TrustedTelemetryIdentity,
): SafeAnalyticsEvent | undefined {
  if (!isRecord(input)) return undefined;
  const event = member(ANALYTICS_EVENT_NAMES, input.event) as AnalyticsEventName | undefined;
  const distinctId = installationId(identity);
  if (!event || !distinctId) return undefined;

  const isSetupEvent = event.startsWith("account_setup.");
  const trustedDiagnosticId = diagnosticId(identity, distinctId);
  if (isSetupEvent && !trustedDiagnosticId) return undefined;
  if (identity.diagnosticId !== undefined && !trustedDiagnosticId) return undefined;

  const properties = isSetupEvent
    ? setupEventProperties(input.properties, trustedDiagnosticId as DiagnosticId)
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
