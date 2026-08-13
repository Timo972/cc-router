import { randomUUID } from "node:crypto";
import { IncomingMessage, type ClientRequest, type RequestOptions } from "node:http";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import type { Context, TextMapPropagator } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  RandomIdGenerator,
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type IdGenerator,
  type Sampler,
} from "@opentelemetry/sdk-trace-base";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation, type UndiciRequest } from "@opentelemetry/instrumentation-undici";
import {
  createTelemetryConsentGate,
  getTelemetrySnapshot,
  type TelemetryConsentGate,
  type TelemetrySnapshot,
} from "../config/telemetry.js";
import { getCurrentVersion } from "../utils/self-update.js";
import type { RuntimeMode } from "./contracts.js";
import { createPostHogOtlpExporters } from "./otel-exporters.js";
import { createPostHogTelemetryClient, type PostHogTelemetryClient } from "./posthog-client.js";
import { sanitizeException } from "./privacy.js";
import { reportFatalExceptionCorrelationLocally } from "./local-diagnostics.js";

const TRACE_SAMPLE_RATIO = 0.1;
const QUEUE_SIZE = 100;
const BATCH_SIZE = 20;
const EXPORT_DELAY_MS = 500;
const EXPORT_TIMEOUT_MS = 2_000;
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const proxyNetworkPropagator: TextMapPropagator = {
  inject(): void {},
  extract(context: Context): Context {
    return context;
  },
  fields(): string[] {
    return [];
  },
};

export interface ProxyTraceSamplerOptions {
  getSnapshot?: () => TelemetrySnapshot;
  initialSnapshot?: TelemetrySnapshot;
}

export function createProxyTraceSampler(options: ProxyTraceSamplerOptions = {}): Sampler {
  const consent = createTelemetryConsentGate(
    options.getSnapshot ?? getTelemetrySnapshot,
    options.initialSnapshot,
  );
  const delegate = new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(TRACE_SAMPLE_RATIO) });
  return {
    shouldSample(...args) {
      return consent.getSnapshot()
        ? delegate.shouldSample(...args)
        : { decision: SamplingDecision.NOT_RECORD };
    },
    toString: () => `ConsentGated{${delegate.toString()}}`,
  };
}

interface ActiveRuntime {
  sdk: NodeSDK;
  spanProcessor: BatchSpanProcessor;
  logProcessor: BatchLogRecordProcessor;
  posthog: PostHogTelemetryClient;
  fatalMonitor: (error: unknown) => void;
  exitCleanup: () => void;
  consent: TelemetryConsentGate;
  shuttingDown: boolean;
}

let activeRuntime: ActiveRuntime | undefined;

function osFamily(): "macos" | "linux" | "windows" | "other" {
  switch (process.platform) {
    case "darwin": return "macos";
    case "linux": return "linux";
    case "win32": return "windows";
    default: return "other";
  }
}

function cpuArchitecture(): "arm64" | "x64" | "other" {
  return process.arch === "arm64" || process.arch === "x64" ? process.arch : "other";
}

function requestPath(value: string | undefined): string {
  if (!value) return "";
  const query = value.indexOf("?");
  return query === -1 ? value : value.slice(0, query);
}

function isProxyInferencePath(path: string): boolean {
  return path === "/v1/messages" || path === "/v1/responses";
}

function isTelemetryEndpoint(hostname: string | undefined, path: string): boolean {
  return hostname === "eu.i.posthog.com"
    || path === "/i/v1/traces"
    || path === "/i/v1/logs"
    || path === "/batch/";
}

interface TestOtlpUrls {
  configured: boolean;
  valid: boolean;
  traceUrl?: string;
  logUrl?: string;
}

function literalLoopbackOtlpUrl(candidate: string | undefined, path: string): string | undefined {
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    const address = url.hostname.replace(/^\[|\]$/g, "");
    const literalLoopback = isIP(address) === 4 ? address.startsWith("127.") : address === "::1";
    return url.protocol === "http:" && literalLoopback && url.pathname === path
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function loopbackTestOtlpUrls(): TestOtlpUrls {
  if (process.env["NODE_ENV"] !== "test") return { configured: false, valid: true };
  const traceCandidate = process.env["CC_ROUTER_TEST_OTLP_TRACE_URL"];
  const logCandidate = process.env["CC_ROUTER_TEST_OTLP_LOG_URL"];
  if (!traceCandidate && !logCandidate) return { configured: false, valid: true };
  const traceUrl = literalLoopbackOtlpUrl(traceCandidate, "/i/v1/traces");
  const logUrl = literalLoopbackOtlpUrl(logCandidate, "/i/v1/logs");
  return traceUrl && logUrl
    ? { configured: true, valid: true, traceUrl, logUrl }
    : { configured: true, valid: false };
}

function httpHostname(request: RequestOptions): string | undefined {
  const hostname = request.hostname ?? request.host;
  if (typeof hostname === "string") return hostname;
  return undefined;
}

function normalizedHostname(hostname: string | undefined): string | undefined {
  if (!hostname) return undefined;
  const candidate = hostname.trim().toLowerCase();
  if (candidate.startsWith("[")) {
    const closingBracket = candidate.indexOf("]");
    if (closingBracket === -1) return undefined;
    const address = candidate.slice(1, closingBracket);
    return isIP(address) !== 0 ? address : undefined;
  }
  if (isIP(candidate) !== 0) return candidate;
  if (!candidate.includes(":")) return candidate;
  try {
    return new URL(`http://${candidate}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

function trustedTargetHostname(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return normalizedHostname(url.hostname);
  } catch {
    return undefined;
  }
}

function isTestLoopbackHostname(hostname: string | undefined): boolean {
  if (process.env["NODE_ENV"] !== "test") return false;
  const address = normalizedHostname(hostname);
  if (!address) return false;
  return isIP(address) === 4 ? address.startsWith("127.") : address === "::1";
}

interface AutomaticSpanClassification {
  operation: "proxy.request" | "provider.inference" | "oauth.refresh" | "provider.usage_refresh" | "model.discovery";
  provider?: "anthropic" | "openai";
  route?: "messages" | "responses";
}

function incomingClassification(path: string): AutomaticSpanClassification | undefined {
  if (path === "/v1/messages") return { operation: "proxy.request", route: "messages" };
  if (path === "/v1/responses") return { operation: "proxy.request", route: "responses" };
  return undefined;
}

export function classifyOutgoingTelemetryOperation(
  hostname: string | undefined,
  path: string,
  method: string | undefined,
  trustedProviderHostname?: string,
): AutomaticSpanClassification | undefined {
  const host = normalizedHostname(hostname);
  const trusted = normalizedHostname(trustedProviderHostname);
  const testLoopback = isTestLoopbackHostname(host);
  const normalizedMethod = method?.toUpperCase();
  if (normalizedMethod === "POST" && path === "/v1/messages"
    && (host === "api.anthropic.com" || (trusted !== undefined && host === trusted) || testLoopback)) {
    return { operation: "provider.inference", provider: "anthropic", route: "messages" };
  }
  if (normalizedMethod === "POST" && path === "/v1/responses"
    && (host === "api.openai.com" || (trusted !== undefined && host === trusted) || testLoopback)) {
    return { operation: "provider.inference", provider: "openai", route: "responses" };
  }
  if (normalizedMethod === "POST" && path === "/backend-api/codex/responses"
    && (host === "chatgpt.com" || testLoopback)) {
    return { operation: "provider.inference", provider: "openai", route: "responses" };
  }
  if (normalizedMethod === "POST" && (
    (host === "claude.ai" && path === "/v1/oauth/token")
    || (host === "auth.openai.com" && path === "/oauth/token")
    || (testLoopback && (path === "/v1/oauth/token" || path === "/oauth/token"))
  )) {
    return {
      operation: "oauth.refresh",
      provider: path === "/v1/oauth/token" ? "anthropic" : "openai",
    };
  }
  if (normalizedMethod === "GET" && (host === "api.anthropic.com" || testLoopback)
    && path === "/api/oauth/usage") {
    return { operation: "provider.usage_refresh", provider: "anthropic" };
  }
  if (normalizedMethod === "GET" && (host === "api.anthropic.com" || testLoopback)
    && path === "/v1/models") {
    return {
      operation: "model.discovery",
      provider: "anthropic",
    };
  }
  if (normalizedMethod === "GET" && path === "/backend-api/codex/models"
    && (host === "chatgpt.com" || testLoopback)) {
    return {
      operation: "model.discovery",
      provider: "openai",
    };
  }
  return undefined;
}

function classificationAttributes(
  classification: AutomaticSpanClassification,
  runtimeMode: RuntimeMode,
): Record<string, string> {
  return {
    "cc_router.operation": classification.operation,
    "cc_router.runtime_mode": runtimeMode,
    ...(classification.provider === undefined ? {} : { "cc_router.provider": classification.provider }),
    ...(classification.route === undefined ? {} : { "cc_router.route": classification.route }),
  };
}

function testIdGenerator(): IdGenerator | undefined {
  if (process.env["NODE_ENV"] !== "test") return undefined;
  const traceId = process.env["CC_ROUTER_TEST_TRACE_ID"]?.toLowerCase();
  if (!traceId || !/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId)) return undefined;
  const random = new RandomIdGenerator();
  return {
    generateTraceId: () => traceId,
    generateSpanId: () => random.generateSpanId(),
  };
}

function createInstrumentations(runtimeMode: RuntimeMode, trustedProviderHostname?: string): [
  HttpInstrumentation,
  ExpressInstrumentation,
  UndiciInstrumentation,
] {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook(request) {
        return !isProxyInferencePath(requestPath(request.url));
      },
      ignoreOutgoingRequestHook(request) {
        const hostname = httpHostname(request);
        const path = requestPath(request.path ?? undefined);
        return isTelemetryEndpoint(hostname, path)
          || classifyOutgoingTelemetryOperation(hostname, path, request.method, trustedProviderHostname) === undefined;
      },
      requireParentforOutgoingSpans: true,
      startIncomingSpanHook(request) {
        const classification = incomingClassification(requestPath(request.url));
        return classification ? classificationAttributes(classification, runtimeMode) : {};
      },
      startOutgoingSpanHook(request) {
        const classification = classifyOutgoingTelemetryOperation(
          httpHostname(request),
          requestPath(request.path ?? undefined),
          request.method,
          trustedProviderHostname,
        );
        return classification ? classificationAttributes(classification, runtimeMode) : {};
      },
      requestHook(span, request) {
        const classification = request instanceof IncomingMessage
          ? incomingClassification(requestPath(request.url))
          : classifyOutgoingTelemetryOperation(
            (request as ClientRequest).host,
            requestPath((request as ClientRequest).path),
            (request as ClientRequest).method,
            trustedProviderHostname,
          );
        if (classification) span.setAttributes(classificationAttributes(classification, runtimeMode));
      },
    }),
    new ExpressInstrumentation({
      requestHook(span, info) {
        const classification = incomingClassification(requestPath(info.request.path));
        if (classification) span.setAttributes(classificationAttributes(classification, runtimeMode));
      },
    }),
    new UndiciInstrumentation({
      requireParentforSpans: true,
      ignoreRequestHook(request: UndiciRequest) {
        let hostname: string | undefined;
        try {
          hostname = new URL(request.origin).hostname;
        } catch {
          return true;
        }
        const path = requestPath(request.path);
        return isTelemetryEndpoint(hostname, path)
          || classifyOutgoingTelemetryOperation(hostname, path, request.method, trustedProviderHostname) === undefined;
      },
      startSpanHook(request) {
        let hostname: string | undefined;
        try {
          hostname = new URL(request.origin).hostname;
        } catch {
          return {};
        }
        const classification = classifyOutgoingTelemetryOperation(
          hostname,
          requestPath(request.path),
          request.method,
          trustedProviderHostname,
        );
        return classification ? classificationAttributes(classification, runtimeMode) : {};
      },
    }),
  ];
}

function settleWithin(operation: () => Promise<void>, deadlineMs: number): Promise<void> {
  const bounded = Number.isFinite(deadlineMs) ? Math.max(0, Math.min(10_000, Math.floor(deadlineMs))) : 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve().then(operation).catch(() => undefined),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, bounded);
      timer.unref?.();
    }),
  ]).then(() => undefined).catch(() => undefined).finally(() => clearTimeout(timer));
}

export interface StartProxyTelemetryOptions {
  trustedProviderTarget?: string;
}

export function startProxyTelemetry(
  runtimeMode: RuntimeMode,
  options: StartProxyTelemetryOptions = {},
): boolean {
  if (activeRuntime) return true;
  try {
    const snapshot = getTelemetrySnapshot();
    if (!snapshot.enabled) return false;
    let discardQueuedTelemetry = (): void => undefined;
    const consent = createTelemetryConsentGate(
      getTelemetrySnapshot,
      snapshot,
      () => discardQueuedTelemetry(),
    );
    const testOtlpUrls = loopbackTestOtlpUrls();
    if (!testOtlpUrls.valid) return false;
    const exporterOptions = {
      getSnapshot: () => consent.getSnapshot() ?? {
        ...snapshot,
        enabled: false,
      },
      ...(testOtlpUrls.configured ? {
      traceUrl: testOtlpUrls.traceUrl,
      logUrl: testOtlpUrls.logUrl,
      } : {}),
    };
    const exporters = createPostHogOtlpExporters(exporterOptions);
    const spanProcessor = new BatchSpanProcessor(exporters.spanExporter, {
      maxQueueSize: QUEUE_SIZE,
      maxExportBatchSize: BATCH_SIZE,
      scheduledDelayMillis: EXPORT_DELAY_MS,
      exportTimeoutMillis: EXPORT_TIMEOUT_MS,
    });
    const logProcessor = new BatchLogRecordProcessor({
      exporter: exporters.logExporter,
      maxQueueSize: QUEUE_SIZE,
      maxExportBatchSize: BATCH_SIZE,
      scheduledDelayMillis: EXPORT_DELAY_MS,
      exportTimeoutMillis: EXPORT_TIMEOUT_MS,
    });
    const idGenerator = testIdGenerator();
    const sdk = new NodeSDK({
      autoDetectResources: false,
      resourceDetectors: [],
      resource: resourceFromAttributes({
        "service.name": "cc-router",
        "service.version": getCurrentVersion(),
        "service.instance.id": snapshot.state.installId,
        "process.runtime.version": process.versions.node,
        "os.type": osFamily(),
        "host.arch": cpuArchitecture(),
        "cc_router.runtime_mode": runtimeMode,
      }),
      sampler: createProxyTraceSampler({
        getSnapshot: getTelemetrySnapshot,
        initialSnapshot: snapshot,
      }),
      textMapPropagator: proxyNetworkPropagator,
      ...(idGenerator === undefined ? {} : { idGenerator }),
      instrumentations: createInstrumentations(
        runtimeMode,
        trustedTargetHostname(options.trustedProviderTarget),
      ),
      spanProcessors: [spanProcessor],
      logRecordProcessors: [logProcessor],
      metricReaders: [],
      views: [],
    });
    const posthog = createPostHogTelemetryClient({ getSnapshot: getTelemetrySnapshot });
    discardQueuedTelemetry = () => {
      posthog.discardPending();
      void spanProcessor.shutdown().catch(() => undefined);
      void logProcessor.shutdown().catch(() => undefined);
    };
    const fatalMonitor = (error: unknown): void => {
      try {
        const current = consent.getSnapshot();
        if (!current) return;
        const exception = sanitizeException(error, {
          category: "runtime",
          reason: "other",
          operation: "proxy.request",
          runtimeMode,
        }, {
          installationId: current.state.installId,
          diagnosticId: randomUUID(),
        }, {
          projectRoot: PROJECT_ROOT,
        });
        if (exception) {
          reportFatalExceptionCorrelationLocally(exception.diagnosticId);
          void posthog.captureExceptionImmediate(exception);
        }
      } catch {
        // The monitor observes only; it never changes Node's crash behavior.
      }
    };
    const exitCleanup = (): void => {
      process.removeListener("uncaughtExceptionMonitor", fatalMonitor);
    };

    sdk.start();
    activeRuntime = {
      sdk,
      spanProcessor,
      logProcessor,
      posthog,
      fatalMonitor,
      exitCleanup,
      consent,
      shuttingDown: false,
    };
    process.on("uncaughtExceptionMonitor", fatalMonitor);
    process.once("exit", exitCleanup);
    return true;
  } catch {
    return false;
  }
}

export async function flushProxyTelemetryWithin(deadlineMs: number): Promise<void> {
  const runtime = activeRuntime;
  if (!runtime || runtime.shuttingDown) return;
  try {
    if (!runtime.consent.getSnapshot()) {
      runtime.posthog.discardPending();
      return;
    }
  } catch {
    return;
  }
  await settleWithin(async () => {
    await Promise.all([
      runtime.spanProcessor.forceFlush(),
      runtime.logProcessor.forceFlush(),
      runtime.posthog.flushWithin(deadlineMs),
    ]);
  }, deadlineMs);
}

export async function shutdownProxyTelemetryWithin(deadlineMs: number): Promise<void> {
  const runtime = activeRuntime;
  if (!runtime || runtime.shuttingDown) return;
  runtime.shuttingDown = true;
  process.removeListener("uncaughtExceptionMonitor", runtime.fatalMonitor);
  process.removeListener("exit", runtime.exitCleanup);
  try {
    if (!runtime.consent.getSnapshot()) runtime.posthog.discardPending();
  } catch {
    runtime.posthog.discardPending();
  }
  await settleWithin(async () => {
    await Promise.all([
      runtime.sdk.shutdown(),
      runtime.posthog.shutdownWithin(deadlineMs),
    ]);
  }, deadlineMs);
  activeRuntime = undefined;
}
