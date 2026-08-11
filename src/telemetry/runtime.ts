import { randomUUID } from "node:crypto";
import type { RequestOptions } from "node:http";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import type { Context, TextMapPropagator } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation, type UndiciRequest } from "@opentelemetry/instrumentation-undici";
import { getTelemetrySnapshot } from "../config/telemetry.js";
import { getCurrentVersion } from "../utils/self-update.js";
import type { RuntimeMode } from "./contracts.js";
import { createPostHogOtlpExporters } from "./otel-exporters.js";
import { createPostHogTelemetryClient, type PostHogTelemetryClient } from "./posthog-client.js";
import { sanitizeException } from "./privacy.js";

const TRACE_SAMPLE_RATIO = 0.1;
const QUEUE_SIZE = 100;
const BATCH_SIZE = 20;
const EXPORT_DELAY_MS = 500;
const EXPORT_TIMEOUT_MS = 2_000;
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const NOOP_NETWORK_PROPAGATOR: TextMapPropagator = {
  inject(): void {},
  extract(context: Context): Context {
    return context;
  },
  fields(): string[] {
    return [];
  },
};

interface ActiveRuntime {
  sdk: NodeSDK;
  spanProcessor: BatchSpanProcessor;
  logProcessor: BatchLogRecordProcessor;
  posthog: PostHogTelemetryClient;
  fatalMonitor: (error: unknown) => void;
  exitCleanup: () => void;
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

function createInstrumentations(runtimeMode: RuntimeMode): [
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
        return isTelemetryEndpoint(httpHostname(request), requestPath(request.path ?? undefined));
      },
      requireParentforOutgoingSpans: true,
      requestHook(span, request) {
        const incoming = "url" in request && typeof request.url === "string";
        span.setAttribute("cc_router.operation", incoming ? "proxy.request" : "provider.inference");
        span.setAttribute("cc_router.runtime_mode", runtimeMode);
      },
    }),
    new ExpressInstrumentation({
      requestHook(span) {
        span.setAttribute("cc_router.operation", "proxy.request");
        span.setAttribute("cc_router.runtime_mode", runtimeMode);
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
        return isTelemetryEndpoint(hostname, requestPath(request.path));
      },
      requestHook(span) {
        span.setAttribute("cc_router.operation", "provider.inference");
        span.setAttribute("cc_router.runtime_mode", runtimeMode);
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

export function startProxyTelemetry(runtimeMode: RuntimeMode): boolean {
  if (activeRuntime) return true;
  try {
    const snapshot = getTelemetrySnapshot();
    if (!snapshot.enabled) return false;
    const testOtlpUrls = loopbackTestOtlpUrls();
    if (!testOtlpUrls.valid) return false;
    const exporters = createPostHogOtlpExporters(testOtlpUrls.configured ? {
      traceUrl: testOtlpUrls.traceUrl,
      logUrl: testOtlpUrls.logUrl,
    } : {});
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
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(TRACE_SAMPLE_RATIO) }),
      textMapPropagator: NOOP_NETWORK_PROPAGATOR,
      instrumentations: createInstrumentations(runtimeMode),
      spanProcessors: [spanProcessor],
      logRecordProcessors: [logProcessor],
      metricReaders: [],
      views: [],
    });
    const posthog = createPostHogTelemetryClient();
    const fatalMonitor = (error: unknown): void => {
      try {
        const current = getTelemetrySnapshot();
        if (!current.enabled) return;
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
        if (exception) void posthog.captureExceptionImmediate(exception);
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
    if (!getTelemetrySnapshot().enabled) {
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
    if (!getTelemetrySnapshot().enabled) runtime.posthog.discardPending();
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
