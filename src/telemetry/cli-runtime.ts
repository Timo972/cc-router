import { isIP } from "node:net";
import { logs } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider, type ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { getTelemetrySnapshot } from "../config/telemetry.js";
import { getCurrentVersion } from "../utils/self-update.js";
import type { RuntimeMode } from "./contracts.js";
import { createPostHogOtlpLogExporter } from "./otel-exporters.js";

const QUEUE_SIZE = 100;
const BATCH_SIZE = 20;
const EXPORT_DELAY_MS = 500;
const EXPORT_TIMEOUT_MS = 2_000;

interface ActiveCliRuntime {
  provider: LoggerProvider;
  shuttingDown: boolean;
}

let activeRuntime: ActiveCliRuntime | undefined;
let handedOffToProxy = false;

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

function literalLoopbackLogUrl(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    const address = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = isIP(address) === 4 ? address.startsWith("127.") : address === "::1";
    return url.protocol === "http:" && loopback && url.pathname === "/i/v1/logs"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function testLogUrl(): { configured: boolean; valid: boolean; url?: string } {
  if (process.env["NODE_ENV"] !== "test") return { configured: false, valid: true };
  const candidate = process.env["CC_ROUTER_TEST_OTLP_LOG_URL"];
  if (!candidate) return { configured: false, valid: true };
  const url = literalLoopbackLogUrl(candidate);
  return url ? { configured: true, valid: true, url } : { configured: true, valid: false };
}

function diagnosticId(record: ReadableLogRecord): string | undefined {
  try {
    const value = Object.getOwnPropertyDescriptor(record.attributes, "cc_router.diagnostic_id")?.value;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
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

export function shouldStartCliTelemetry(argv: readonly string[]): boolean {
  const command = argv[2];
  if (command === "setup" || command === "status" || command === "start") return true;
  return command === "accounts"
    && ["add", "add-openai", "login-openai"].includes(argv[3] ?? "");
}

export function startCliTelemetry(runtimeMode: RuntimeMode): boolean {
  if (activeRuntime) return true;
  try {
    handedOffToProxy = false;
    const snapshot = getTelemetrySnapshot();
    if (!snapshot.enabled) return false;
    const loopback = testLogUrl();
    if (!loopback.valid) return false;
    const exporter = createPostHogOtlpLogExporter({
      ...(loopback.configured ? { logUrl: loopback.url } : {}),
      getDiagnosticId: diagnosticId,
    });
    const processor = new BatchLogRecordProcessor({
      exporter,
      maxQueueSize: QUEUE_SIZE,
      maxExportBatchSize: BATCH_SIZE,
      scheduledDelayMillis: EXPORT_DELAY_MS,
      exportTimeoutMillis: EXPORT_TIMEOUT_MS,
    });
    const provider = new LoggerProvider({
      resource: resourceFromAttributes({
        "service.name": "cc-router",
        "service.version": getCurrentVersion(),
        "service.instance.id": snapshot.state.installId,
        "process.runtime.version": process.versions.node,
        "os.type": osFamily(),
        "host.arch": cpuArchitecture(),
        "cc_router.runtime_mode": runtimeMode,
      }),
      processors: [processor],
    });
    logs.setGlobalLoggerProvider(provider);
    activeRuntime = { provider, shuttingDown: false };
    return true;
  } catch {
    return false;
  }
}

export function isCliTelemetryActive(): boolean {
  return activeRuntime !== undefined && !activeRuntime.shuttingDown;
}

export function markCliTelemetryHandedOffToProxy(): void {
  handedOffToProxy = true;
}

export function wasCliTelemetryHandedOffToProxy(): boolean {
  return handedOffToProxy;
}

export async function flushCliTelemetryWithin(deadlineMs: number): Promise<void> {
  const runtime = activeRuntime;
  if (!runtime || runtime.shuttingDown) return;
  try {
    if (!getTelemetrySnapshot().enabled) return;
  } catch {
    return;
  }
  await settleWithin(() => runtime.provider.forceFlush({ timeoutMillis: deadlineMs }), deadlineMs);
}

export async function shutdownCliTelemetryWithin(deadlineMs: number): Promise<void> {
  const runtime = activeRuntime;
  if (!runtime || runtime.shuttingDown) return;
  runtime.shuttingDown = true;
  await settleWithin(() => runtime.provider.shutdown(), deadlineMs);
  logs.disable();
  activeRuntime = undefined;
}
