import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_CONTEXT, TraceFlags, context, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SafeSpanAttributes } from "../telemetry/contracts.js";
import {
  TELEMETRY_CANARY,
  assertNoCanaries,
  decodeOtlpSpans,
  startTransportCaptureServer,
  type CapturedTransportRequest,
  type TransportCaptureServer,
} from "./telemetry-test-helpers.js";

const INSTALL_ID = "123e4567-e89b-42d3-a456-426614174000";
const CONSENT_GENERATION = "123e4567-e89b-42d3-a456-426614174010";
const NEXT_CONSENT_GENERATION = "123e4567-e89b-42d3-a456-426614174011";
const PARENT_TRACE_ID = "0123456789abcdef0123456789abcdef";
const TRACE_PATH = "/i/v1/traces";
const LOG_PATH = "/i/v1/logs";
const ENV_KEYS = [
  "NODE_ENV",
  "TELEMETRY_PATH",
  "CC_ROUTER_TELEMETRY",
  "DO_NOT_TRACK",
  "CC_ROUTER_TEST_OTLP_TRACE_URL",
  "CC_ROUTER_TEST_OTLP_LOG_URL",
] as const;

interface DecodedLogRecord {
  severityText?: string;
  body: string | undefined;
  traceId: string | undefined;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  scope: string | undefined;
}

let capture: TransportCaptureServer;
let home: string;
let telemetryPath: string;
let runtime: typeof import("../telemetry/runtime.js");
let facade: typeof import("../telemetry/facade.js");
const originalEnv: Record<string, string | undefined> = {};

function writeState(overrides: { enabled?: boolean; consentGeneration?: string } = {}): void {
  writeFileSync(telemetryPath, JSON.stringify({
    enabled: overrides.enabled ?? true,
    installId: INSTALL_ID,
    firstRunAt: "2026-08-01T00:00:00.000Z",
    consentGeneration: overrides.consentGeneration ?? CONSENT_GENERATION,
    revision: 0,
  }));
}

function parentContext(sampled: boolean) {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: PARENT_TRACE_ID,
    spanId: "1111111111111111",
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: false,
  });
}

function requestsTo(path: string): CapturedTransportRequest[] {
  return capture.requests.filter(request => request.url === path);
}

function exportedSpans() {
  return decodeOtlpSpans(Buffer.concat(requestsTo(TRACE_PATH).map(request => request.rawBody)));
}

function anyValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const wrapper = value as Record<string, unknown>;
  if ("stringValue" in wrapper) return wrapper["stringValue"];
  if ("boolValue" in wrapper) return wrapper["boolValue"];
  if ("intValue" in wrapper) return Number(wrapper["intValue"]);
  if ("doubleValue" in wrapper) return wrapper["doubleValue"];
  return value;
}

function keyValues(input: unknown): Record<string, unknown> {
  if (!Array.isArray(input)) return {};
  return Object.fromEntries(input.map(entry => {
    const pair = entry as { key: string; value: unknown };
    return [pair.key, anyValue(pair.value)];
  }));
}

function exportedLogs(): DecodedLogRecord[] {
  return requestsTo(LOG_PATH).flatMap(request => {
    const payload = request.json as { resourceLogs?: unknown[] } | undefined;
    return (payload?.resourceLogs ?? []).flatMap(resourceLog => {
      const resourceEntry = resourceLog as {
        resource?: { attributes?: unknown };
        scopeLogs?: unknown[];
      };
      const resource = keyValues(resourceEntry.resource?.attributes);
      return (resourceEntry.scopeLogs ?? []).flatMap(scopeLog => {
        const scopeEntry = scopeLog as { scope?: { name?: string }; logRecords?: unknown[] };
        return (scopeEntry.logRecords ?? []).map(record => {
          const logRecord = record as {
            severityText?: string;
            body?: unknown;
            traceId?: string;
            attributes?: unknown;
          };
          return {
            ...(logRecord.severityText === undefined ? {} : { severityText: logRecord.severityText }),
            body: anyValue(logRecord.body) as string | undefined,
            traceId: logRecord.traceId,
            attributes: keyValues(logRecord.attributes),
            resource,
            scope: scopeEntry.scope?.name,
          };
        });
      });
    });
  });
}

async function flushExports(): Promise<void> {
  await runtime.flushTelemetryRuntimeWithin(2_000);
}

beforeEach(async () => {
  capture = await startTransportCaptureServer();
  home = mkdtempSync(join(tmpdir(), "cc-router-telemetry-runtime-"));
  telemetryPath = join(home, "telemetry.json");
  writeState();
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env["NODE_ENV"] = "test";
  process.env["TELEMETRY_PATH"] = telemetryPath;
  delete process.env["CC_ROUTER_TELEMETRY"];
  delete process.env["DO_NOT_TRACK"];
  process.env["CC_ROUTER_TEST_OTLP_TRACE_URL"] = capture.endpoint(TRACE_PATH);
  process.env["CC_ROUTER_TEST_OTLP_LOG_URL"] = capture.endpoint(LOG_PATH);
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const target = typeof input === "string"
      ? input
      : input instanceof URL ? input.href : input.url;
    throw new Error(`telemetry runtime test blocked a network request to ${target}`);
  });
  vi.resetModules();
  runtime = await import("../telemetry/runtime.js");
  facade = await import("../telemetry/facade.js");
});

afterEach(async () => {
  await runtime.shutdownTelemetryRuntimeWithin(500);
  await capture.close();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("telemetry runtime", () => {
  it("exports manual spans and logs carrying only allowlisted attributes", async () => {
    expect(runtime.startTelemetryRuntime({ tracing: true, runtimeMode: "daemon" })).toBe(true);
    expect(runtime.isTelemetryRuntimeActive()).toBe(true);

    context.with(parentContext(true), () => {
      const span = facade.startTelemetrySpan("provider.inference", {
        provider: "openai",
        attempt: 1,
        ...{
          prompt: TELEMETRY_CANARY.prompt,
          authorization: TELEMETRY_CANARY.bearerToken,
          accountId: TELEMETRY_CANARY.accountId,
        },
      } as SafeSpanAttributes);
      span.annotate({ httpStatusCode: 200, outcome: "complete" });
      span.end("ok");
      span.end("error");
    });
    facade.recordSafeLog({
      operation: "proxy.request",
      provider: "anthropic",
      reason: "upstream_5xx",
      severity: "warn",
      httpStatusCode: 503,
      attempt: 2,
      ...{ account: TELEMETRY_CANARY.accountId, home: TELEMETRY_CANARY.homePath },
    });
    await flushExports();
    await vi.waitFor(() => {
      expect(exportedSpans()).not.toHaveLength(0);
      expect(exportedLogs()).not.toHaveLength(0);
    }, { timeout: 3_000 });

    const [span] = exportedSpans();
    expect(span?.name).toBe("provider.inference");
    expect(span?.scope).toBe("cc-router");
    // The exporter rebuilds the span from the allowlist: the operation survives
    // as the span name, every other attribute only through the key map.
    expect(span?.attributes).toEqual({
      "cc_router.provider": "openai",
      "cc_router.attempt": 1,
      "http.response.status_code": 200,
      "cc_router.outcome": "complete",
    });
    expect(Object.keys(span?.resource ?? {}).sort()).toEqual([
      "cc_router.runtime_mode",
      "host.arch",
      "os.type",
      "process.runtime.version",
      "service.instance.id",
      "service.name",
      "service.version",
    ]);
    expect(span?.resource["service.instance.id"]).toBe(INSTALL_ID);
    expect(span?.resource["cc_router.runtime_mode"]).toBe("daemon");

    const [log] = exportedLogs();
    expect(log?.body).toBe("runtime.failure");
    expect(log?.severityText).toBe("WARN");
    expect(log?.scope).toBe("cc-router");
    expect(log?.attributes).toEqual({
      "cc_router.operation": "proxy.request",
      "cc_router.provider": "anthropic",
      "cc_router.reason": "upstream_5xx",
      "http.response.status_code": 503,
      "cc_router.attempt": 2,
      "service.version": expect.any(String),
      "os.type": expect.any(String),
      "cc_router.runtime_mode": "foreground",
    });
    assertNoCanaries(capture.requests);
  });

  it("keeps an unsampled parent out of the trace export without dropping its logs", async () => {
    expect(runtime.startTelemetryRuntime({ tracing: true, runtimeMode: "foreground" })).toBe(true);

    context.with(parentContext(false), () => {
      facade.startTelemetrySpan("model.discovery", { provider: "anthropic" }).end("ok");
      facade.recordSafeLog({
        operation: "model.discovery",
        reason: "timeout",
        severity: "error",
      });
    });
    await flushExports();
    await vi.waitFor(() => {
      expect(exportedLogs()).not.toHaveLength(0);
    }, { timeout: 3_000 });

    expect(exportedSpans()).toHaveLength(0);
    const [log] = exportedLogs();
    expect(log?.attributes["cc_router.operation"]).toBe("model.discovery");
    // A log correlated with an unsampled span would be dropped downstream.
    expect(log?.traceId ?? "").toBe("");
  });

  it("stops exporting after an opt-out rotates the consent generation mid-run", async () => {
    expect(runtime.startTelemetryRuntime({ tracing: true, runtimeMode: "foreground" })).toBe(true);
    context.with(parentContext(true), () => {
      facade.startTelemetrySpan("provider.inference", { provider: "openai" }).end("ok");
    });
    facade.recordSafeLog({ operation: "proxy.request", reason: "timeout", severity: "warn" });
    await flushExports();
    await vi.waitFor(() => {
      expect(exportedSpans()).not.toHaveLength(0);
      expect(exportedLogs()).not.toHaveLength(0);
    }, { timeout: 3_000 });

    writeState({ enabled: false, consentGeneration: NEXT_CONSENT_GENERATION });
    context.with(parentContext(true), () => {
      facade.startTelemetrySpan("oauth.refresh", { provider: "anthropic" }).end("ok");
    });
    facade.recordSafeLog({ operation: "oauth.refresh", reason: "unauthorized", severity: "error" });
    await flushExports();
    await new Promise(resolve => setTimeout(resolve, 750));

    expect(exportedSpans().map(span => span.name)).toEqual(["provider.inference"]);
    expect(exportedLogs().map(log => log.attributes["cc_router.operation"]))
      .toEqual(["proxy.request"]);
  });

  it("never starts or exports when telemetry is disabled on disk", async () => {
    writeState({ enabled: false });

    expect(runtime.startTelemetryRuntime({ tracing: true, runtimeMode: "foreground" })).toBe(false);
    expect(runtime.isTelemetryRuntimeActive()).toBe(false);

    context.with(parentContext(true), () => {
      facade.startTelemetrySpan("provider.inference", { provider: "openai" }).end("ok");
    });
    facade.recordSafeLog({ operation: "proxy.request", reason: "timeout", severity: "warn" });
    await runtime.flushTelemetryRuntimeWithin(500);
    await new Promise(resolve => setTimeout(resolve, 750));

    expect(capture.requests).toHaveLength(0);
  });

  it("serves logs without tracing and upgrades to tracing on the proxy's call", async () => {
    expect(runtime.startTelemetryRuntime({ tracing: false, runtimeMode: "foreground" })).toBe(true);
    facade.recordSafeLog({ operation: "proxy.request", reason: "network_failure", severity: "warn" });
    await flushExports();
    await vi.waitFor(() => {
      expect(exportedLogs()).not.toHaveLength(0);
    }, { timeout: 3_000 });
    expect(requestsTo(TRACE_PATH)).toHaveLength(0);

    expect(runtime.startTelemetryRuntime({ tracing: true, runtimeMode: "foreground" })).toBe(true);
    context.with(parentContext(true), () => {
      facade.startTelemetrySpan("provider.usage_refresh", { provider: "anthropic" }).end("ok");
    });
    await flushExports();
    await vi.waitFor(() => {
      expect(exportedSpans()).not.toHaveLength(0);
    }, { timeout: 3_000 });
    expect(exportedSpans().map(span => span.name)).toEqual(["provider.usage_refresh"]);
  });

  it("bounds flush and shutdown and stays idempotent once stopped", async () => {
    expect(runtime.startTelemetryRuntime({ tracing: true, runtimeMode: "foreground" })).toBe(true);
    context.with(parentContext(true), () => {
      facade.startTelemetrySpan("provider.inference", { provider: "openai" }).end("ok");
    });
    await capture.close();

    const startedAt = Date.now();
    await runtime.flushTelemetryRuntimeWithin(200);
    await runtime.shutdownTelemetryRuntimeWithin(200);
    await runtime.shutdownTelemetryRuntimeWithin(200);
    await runtime.flushTelemetryRuntimeWithin(200);

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(runtime.isTelemetryRuntimeActive()).toBe(false);
  });

  it("keeps the propagator inert for hostile carriers", () => {
    const trusted = parentContext(true);
    const extracted = runtime.noopPropagator.extract(trusted, {
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      baggage: "private=value",
    }, {
      keys: carrier => Object.keys(carrier as object),
      get: (carrier, key) => (carrier as Record<string, string>)[key],
    });
    const injected: Record<string, string> = {};
    runtime.noopPropagator.inject(extracted, injected, {
      set: (carrier, key, value) => { (carrier as Record<string, string>)[key] = value; },
    });

    expect(trace.getSpanContext(extracted)).toEqual(trace.getSpanContext(trusted));
    expect(runtime.noopPropagator.fields()).toEqual([]);
    expect(injected).toEqual({});
  });
});
