import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { context, propagation, trace, type Context, type TextMapPropagator } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type Sampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  createTelemetryConsentGate,
  getTelemetrySnapshot,
  type TelemetryConsentGate,
  type TelemetrySnapshot,
} from "../config/telemetry.js";
import { TELEMETRY_PATH } from "../config/paths.js";
import { getCurrentVersion } from "../utils/self-update.js";
import type {
  CpuArchitecture,
  OsFamily,
  RuntimeMode,
  SafeExceptionContext,
  SafeExceptionContract,
  TrustedTelemetryIdentity,
} from "./contracts.js";
import { createPostHogOtlpExporters } from "./otel-exporters.js";
import { createPostHogTelemetryClient, type PostHogTelemetryClient } from "./posthog-client.js";
import { rebuildSanitizedException, sanitizeException } from "./privacy.js";

const TRACE_SAMPLE_RATIO = 0.1;
const QUEUE_SIZE = 100;
const BATCH_SIZE = 20;
const EXPORT_DELAY_MS = 500;
const EXPORT_TIMEOUT_MS = 2_000;
/**
 * Fatal exceptions cannot be sent from a crashing process (Node exits as soon
 * as the monitor returns), so the sanitized record is written here
 * synchronously and delivered by the next start that still holds consent.
 */
const MAX_PENDING_EXCEPTIONS = 20;

// Resolved lazily (like the state path itself) so the module loads even when
// the paths module is partially mocked; every caller runs inside a try/catch.
function pendingExceptionsPath(): string {
  return `${TELEMETRY_PATH}.pending.json`;
}

interface PendingException {
  installationId: string;
  consentGeneration: string;
  exception: Omit<SafeExceptionContract, "error">;
}

function readPendingExceptions(): unknown[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pendingExceptionsPath(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistFatalException(exception: SafeExceptionContract, snapshot: TelemetrySnapshot): void {
  const { error: _error, ...record } = exception;
  const pending: PendingException[] = [
    ...readPendingExceptions().slice(-(MAX_PENDING_EXCEPTIONS - 1)) as PendingException[],
    { installationId: snapshot.state.installId, consentGeneration: snapshot.state.consentGeneration, exception: record },
  ];
  const target = pendingExceptionsPath();
  const candidate = `${target}.${process.pid}.tmp`;
  writeFileSync(candidate, JSON.stringify(pending), { mode: 0o600 });
  renameSync(candidate, target);
}

/** Deliver records left by a crash, only under the consent they were written with. */
function deliverPendingExceptions(consent: TelemetryConsentGate, posthog: PostHogTelemetryClient): void {
  try {
    const records = readPendingExceptions();
    // Remove first: a crash during delivery must never resend the same records.
    unlinkSync(pendingExceptionsPath());
    const current = consent.getSnapshot();
    if (!current) return;
    for (const raw of records) {
      if (typeof raw !== "object" || raw === null) continue;
      const record = raw as Partial<PendingException>;
      if (record.installationId !== current.state.installId) continue;
      // A different generation means an explicit choice happened in between.
      if (record.consentGeneration !== current.state.consentGeneration) continue;
      const exception = rebuildSanitizedException(record.exception);
      if (exception) posthog.captureException(exception, current.state.consentGeneration);
    }
  } catch {
    // Nothing pending, or an unreadable file: never affects startup.
  }
}

/** Telemetry must never join or emit a distributed trace outside this process. */
export const noopPropagator: TextMapPropagator = {
  inject(): void {},
  extract(carrierContext: Context): Context {
    return carrierContext;
  },
  fields(): string[] {
    return [];
  },
};

export interface StartTelemetryRuntimeOptions {
  tracing: boolean;
  runtimeMode: RuntimeMode;
  traceUrl?: string;
  logUrl?: string;
}

interface ActiveRuntime {
  loggerProvider: LoggerProvider;
  tracerProvider?: NodeTracerProvider;
  posthog: PostHogTelemetryClient;
  consent: TelemetryConsentGate;
  snapshot: TelemetrySnapshot;
  fatalMonitor: (error: unknown) => void;
  exitCleanup: () => void;
  shuttingDown: boolean;
}

let activeRuntime: ActiveRuntime | undefined;

function osFamily(): OsFamily {
  switch (process.platform) {
    case "darwin": return "macos";
    case "linux": return "linux";
    case "win32": return "windows";
    default: return "other";
  }
}

function cpuArchitecture(): CpuArchitecture {
  return process.arch === "arm64" || process.arch === "x64" ? process.arch : "other";
}

/** Loopback OTLP endpoints for the telemetry test suite; never read in production. */
function testOtlpUrls(): { traceUrl?: string; logUrl?: string } {
  if (process.env["NODE_ENV"] !== "test") return {};
  return {
    traceUrl: process.env["CC_ROUTER_TEST_OTLP_TRACE_URL"],
    logUrl: process.env["CC_ROUTER_TEST_OTLP_LOG_URL"],
  };
}

function exporterOptions(
  consent: TelemetryConsentGate,
  options: StartTelemetryRuntimeOptions,
): { getSnapshot: () => TelemetrySnapshot | undefined; traceUrl?: string; logUrl?: string } {
  const test = testOtlpUrls();
  return {
    getSnapshot: () => consent.getSnapshot(),
    traceUrl: options.traceUrl ?? test.traceUrl,
    logUrl: options.logUrl ?? test.logUrl,
  };
}

function telemetryResource(snapshot: TelemetrySnapshot, runtimeMode: RuntimeMode) {
  return resourceFromAttributes({
    "service.name": "cc-router",
    "service.version": getCurrentVersion(),
    "service.instance.id": snapshot.state.installId,
    "process.runtime.version": process.versions.node,
    "os.type": osFamily(),
    "host.arch": cpuArchitecture(),
    "cc_router.runtime_mode": runtimeMode,
  });
}

function consentGatedSampler(consent: TelemetryConsentGate): Sampler {
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

function startTracing(
  consent: TelemetryConsentGate,
  snapshot: TelemetrySnapshot,
  options: StartTelemetryRuntimeOptions,
): NodeTracerProvider {
  const { spanExporter } = createPostHogOtlpExporters(exporterOptions(consent, options));
  const provider = new NodeTracerProvider({
    resource: telemetryResource(snapshot, options.runtimeMode),
    sampler: consentGatedSampler(consent),
    spanProcessors: [new BatchSpanProcessor(spanExporter, {
      maxQueueSize: QUEUE_SIZE,
      maxExportBatchSize: BATCH_SIZE,
      scheduledDelayMillis: EXPORT_DELAY_MS,
      exportTimeoutMillis: EXPORT_TIMEOUT_MS,
    })],
  });
  // register() installs the AsyncLocalStorage context manager together with the
  // global tracer provider; the inert propagator keeps trace ids off the wire.
  provider.register({ propagator: noopPropagator });
  trace.setGlobalTracerProvider(provider);
  return provider;
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

/**
 * Start (or upgrade to tracing) the one telemetry runtime of this process.
 * Spans are created manually through the facade; no instrumentation is loaded.
 */
export function startTelemetryRuntime(options: StartTelemetryRuntimeOptions): boolean {
  try {
    const existing = activeRuntime;
    if (existing) {
      if (options.tracing && !existing.tracerProvider && !existing.shuttingDown) {
        existing.tracerProvider = startTracing(existing.consent, existing.snapshot, options);
      }
      return !existing.shuttingDown;
    }
    const snapshot = getTelemetrySnapshot();
    if (!snapshot.enabled) return false;

    let discardQueuedTelemetry = (): void => undefined;
    const consent = createTelemetryConsentGate(getTelemetrySnapshot, () => discardQueuedTelemetry());
    const { logExporter } = createPostHogOtlpExporters(exporterOptions(consent, options));
    const logProcessor = new BatchLogRecordProcessor({
      exporter: logExporter,
      maxQueueSize: QUEUE_SIZE,
      maxExportBatchSize: BATCH_SIZE,
      scheduledDelayMillis: EXPORT_DELAY_MS,
      exportTimeoutMillis: EXPORT_TIMEOUT_MS,
    });
    const posthog = createPostHogTelemetryClient({ getSnapshot: () => consent.getSnapshot() });
    const fatalMonitor = (error: unknown): void => {
      try {
        const current = consent.getSnapshot();
        if (!current) return;
        const exception = sanitizeException(error, {
          category: "runtime",
          reason: "other",
          runtimeMode: options.runtimeMode,
        }, {
          installationId: current.state.installId,
          diagnosticId: randomUUID(),
        });
        if (!exception) return;
        // Node's default handler prints the Error itself; add correlation only.
        // The process exits as soon as this monitor returns, so the record is
        // persisted synchronously and sent by the next consenting start.
        persistFatalException(exception, current);
        console.error(`[cc-router] Unexpected runtime failure (diagnostic ID: ${exception.diagnosticId})`);
      } catch {
        // The monitor observes only; it never changes Node's crash behavior.
      }
    };
    const runtime: ActiveRuntime = {
      loggerProvider: new LoggerProvider({
        resource: telemetryResource(snapshot, options.runtimeMode),
        processors: [logProcessor],
      }),
      posthog,
      consent,
      snapshot,
      fatalMonitor,
      exitCleanup: () => process.removeListener("uncaughtExceptionMonitor", fatalMonitor),
      shuttingDown: false,
    };
    discardQueuedTelemetry = () => {
      posthog.discardPending();
      void logProcessor.shutdown().catch(() => undefined);
      void runtime.tracerProvider?.shutdown().catch(() => undefined);
    };

    logs.setGlobalLoggerProvider(runtime.loggerProvider);
    if (options.tracing) runtime.tracerProvider = startTracing(consent, snapshot, options);
    process.on("uncaughtExceptionMonitor", fatalMonitor);
    process.once("exit", runtime.exitCleanup);
    activeRuntime = runtime;
    deliverPendingExceptions(consent, posthog);
    return true;
  } catch {
    return false;
  }
}

export function isTelemetryRuntimeActive(): boolean {
  return activeRuntime !== undefined && !activeRuntime.shuttingDown;
}

/** True while this process runs the proxy's tracing runtime, which owns its own shutdown. */
export function isTelemetryTracingActive(): boolean {
  return isTelemetryRuntimeActive() && activeRuntime?.tracerProvider !== undefined;
}

export async function flushTelemetryRuntimeWithin(deadlineMs: number): Promise<void> {
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
      runtime.loggerProvider.forceFlush(),
      runtime.tracerProvider?.forceFlush(),
      runtime.posthog.flushWithin(deadlineMs),
    ]);
  }, deadlineMs);
}

export async function shutdownTelemetryRuntimeWithin(deadlineMs: number): Promise<void> {
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
      runtime.loggerProvider.shutdown(),
      runtime.tracerProvider?.shutdown(),
      runtime.posthog.shutdownWithin(deadlineMs),
    ]);
  }, deadlineMs);
  logs.disable();
  if (runtime.tracerProvider) {
    trace.disable();
    propagation.disable();
    context.disable();
  }
  activeRuntime = undefined;
}
