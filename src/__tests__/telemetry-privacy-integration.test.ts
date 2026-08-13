import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  type ReadableLogRecord,
  type SdkLogRecord,
} from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import type { TelemetrySnapshot } from "../config/telemetry.js";
import { createPostHogOtlpExporters } from "../telemetry/otel-exporters.js";
import {
  createPostHogTelemetryClient,
  type PostHogTransport,
} from "../telemetry/posthog-client.js";
import { reconstructAnalyticsEvent, sanitizeException } from "../telemetry/privacy.js";
import {
  decodeOtlpProtobuf,
  semanticStrings,
  startTransportCaptureServer,
  TELEMETRY_CANARY,
  telemetryWireRepresentations,
  type CapturedTransportRequest,
  type TransportCaptureServer,
} from "./telemetry-test-helpers.js";

const INSTALL_ID = "70d8062e-1fa0-4ae4-a115-bf782ecca462";
const OTHER_INSTALL_ID = "916ce1d6-2e8d-48b2-a70e-0337bdf82df7";
const PROJECT_ROOT = "/workspace/cc-router";
const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..");
const CI_DEADLINE_MS = 8_000;

function withinDeadline<T>(promise: Promise<T>, context: string): Promise<T> {
  return new Promise((resolveWithin, reject) => {
    const deadline = setTimeout(() => reject(new Error(`${context} after ${CI_DEADLINE_MS}ms`)), CI_DEADLINE_MS);
    promise.then(resolveWithin, reject).finally(() => clearTimeout(deadline));
  });
}

function snapshot(enabled: boolean): TelemetrySnapshot {
  return {
    state: {
      enabled,
      installId: INSTALL_ID,
      firstRunAt: "2026-08-03T00:00:00.000Z",
    },
    environmentDisabled: false,
    enabled,
  };
}

function persistedSnapshot(path: string): TelemetrySnapshot {
  const state = JSON.parse(readFileSync(path, "utf8")) as TelemetrySnapshot["state"];
  return {
    state,
    environmentDisabled: false,
    enabled: state.enabled,
  };
}

function persistTelemetryOff(testHome: string, telemetryPath: string): string {
  const networkMarker = join(testHome, "opt-out-network-attempts.jsonl");
  const preloadPath = join(testHome, "opt-out-network-guard.mjs");
  writeFileSync(preloadPath, `
import { appendFileSync } from "node:fs";
const networkMarker = ${JSON.stringify(networkMarker)};
globalThis.fetch = async (input) => {
  const url = typeof input === "string" || input instanceof URL ? input : input.url;
  appendFileSync(networkMarker, JSON.stringify(url) + "\\n");
  return new Response("", { status: 200 });
};
`);
  const output = execFileSync(process.execPath, [
    "--import", pathToFileURL(preloadPath).href,
    "--import", "tsx",
    join(REPOSITORY_ROOT, "src/cli/bootstrap.ts"),
    "telemetry",
    "off",
  ], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      HOME: testHome,
      TELEMETRY_PATH: telemetryPath,
      NO_UPDATE_NOTIFIER: "1",
      CI: "1",
    },
    encoding: "utf8",
  });
  expect(existsSync(networkMarker)).toBe(false);
  return output;
}

function safeCandidateSpan(spanId: string): ReadableSpan {
  const traceId = "0123456789abcdef0123456789abcdef";
  return {
    name: "/v1/messages?private=true",
    kind: SpanKind.SERVER,
    spanContext: () => ({ traceId, spanId, traceFlags: TraceFlags.SAMPLED }),
    startTime: [1_800_000_000, 0],
    endTime: [1_800_000_000, 1_000_000],
    duration: [0, 1_000_000],
    status: { code: SpanStatusCode.OK },
    attributes: {
      "cc_router.operation": "proxy.request",
      "http.request.method": "POST",
      "cc_router.route": "messages",
      "cc_router.runtime_mode": "foreground",
    },
    links: [],
    events: [],
    ended: true,
    resource: resourceFromAttributes({
      "service.name": "cc-router",
      "service.version": "0.8.2",
      "service.instance.id": "916ce1d6-2e8d-48b2-a70e-0337bdf82df7",
      "process.runtime.version": "22.18.0",
      "os.type": "macos",
      "host.arch": "arm64",
      "cc_router.runtime_mode": "foreground",
    }),
    instrumentationScope: { name: "cc-router" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

function safeCandidateLog(timestamp: number): ReadableLogRecord {
  return {
    hrTime: [timestamp, 0],
    hrTimeObserved: [timestamp, 0],
    severityText: "WARN",
    severityNumber: SeverityNumber.WARN,
    body: "runtime.failure",
    resource: safeCandidateSpan("0123456789abcdef").resource,
    instrumentationScope: { name: "cc-router" },
    attributes: {
      "cc_router.operation": "provider.inference",
      "cc_router.provider": "openai",
      "cc_router.reason": "rate_limited",
      "cc_router.outcome": "rate_limited",
      "http.response.status_code": 429,
      "cc_router.runtime_mode": "foreground",
    },
    droppedAttributesCount: 0,
  };
}

function sdkCandidateLog(timestamp: number): SdkLogRecord {
  const readable = safeCandidateLog(timestamp);
  const record: SdkLogRecord = {
    ...readable,
    setAttribute: () => record,
    setAttributes: () => record,
    setBody: () => record,
    setEventName: () => record,
    setSeverityNumber: () => record,
    setSeverityText: () => record,
  };
  return record;
}

function exportSpan(
  exporter: ReturnType<typeof createPostHogOtlpExporters>["spanExporter"],
  span: ReadableSpan,
): Promise<{ code: number }> {
  return new Promise(resolve => exporter.export([span], resolve));
}

function exportLog(
  exporter: ReturnType<typeof createPostHogOtlpExporters>["logExporter"],
  log: ReadableLogRecord,
): Promise<{ code: number }> {
  return new Promise(resolve => exporter.export([log], resolve));
}

function postHogLoopbackTransport(capture: TransportCaptureServer): PostHogTransport {
  return async (url, options) => {
    const logicalUrl = new URL(url);
    expect(logicalUrl.origin).toBe("https://eu.i.posthog.com");
    return fetch(capture.endpoint(`${logicalUrl.pathname}${logicalUrl.search}`), options as RequestInit);
  };
}

function capturedPostHogEvent(request: CapturedTransportRequest): Record<string, unknown> {
  if (typeof request.json !== "object" || request.json === null || Array.isArray(request.json)) {
    throw new Error("PostHog capture must be a JSON object");
  }
  const batch = (request.json as { batch?: unknown }).batch;
  if (!Array.isArray(batch) || batch.length !== 1 || typeof batch[0] !== "object" || batch[0] === null) {
    throw new Error("PostHog capture must contain exactly one event");
  }
  return batch[0] as Record<string, unknown>;
}

function unsafeFailure(message: string): Error {
  const error = Object.assign(new TypeError(message), {
    account: {
      id: TELEMETRY_CANARY.accountId,
      email: TELEMETRY_CANARY.email,
      token: TELEMETRY_CANARY.bearerToken,
    },
    request: {
      hostname: TELEMETRY_CANARY.hostname,
      query: TELEMETRY_CANARY.queryString,
      headers: { "x-private": TELEMETRY_CANARY.headerValue },
      body: TELEMETRY_CANARY.rawProviderBody,
    },
  });
  error.stack = [
    `TypeError: ${message}`,
    `    at route (${PROJECT_ROOT}/dist/proxy/server.js:42:7)`,
    `    at private (${TELEMETRY_CANARY.homePath}/private.js:1:2)`,
  ].join("\n");
  return error;
}

function sanitizedFailure(installationId: string, diagnosticId: string, message: string) {
  const exception = sanitizeException(unsafeFailure(message), {
    category: "runtime",
    reason: "other",
    operation: "proxy.request",
    provider: "openai",
    runtimeMode: "foreground",
  }, {
    installationId,
    diagnosticId,
  }, {
    projectRoot: PROJECT_ROOT,
  });
  if (!exception) throw new Error("exception fixture must sanitize");
  return exception;
}

function proxyStartedEvent(installationId = INSTALL_ID) {
  const event = reconstructAnalyticsEvent({
    event: "proxy.started",
    properties: {
      serviceVersion: "0.8.2",
      osFamily: "macos",
      runtimeMode: "foreground",
      accountPoolSize: 2,
    },
  }, { installationId });
  if (!event) throw new Error("analytics fixture must reconstruct");
  return event;
}

describe("end-to-end telemetry privacy boundaries", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("finds exact canaries inside escaped and nested JSON carriers semantically", () => {
    const nested = JSON.stringify({
      escaped: JSON.stringify({ privateBody: TELEMETRY_CANARY.rawProviderBody }),
    });
    expect(nested).not.toContain(TELEMETRY_CANARY.rawProviderBody);
    expect(JSON.stringify(JSON.parse(nested))).not.toContain(TELEMETRY_CANARY.rawProviderBody);
    expect(semanticStrings(JSON.parse(nested))).toContain(TELEMETRY_CANARY.rawProviderBody);
  });

  it("rejects unapproved telemetry capture methods and endpoints", async () => {
    const capture = await startTransportCaptureServer({ allowUnapprovedRequests: true });
    try {
      const responses = await Promise.all([
        fetch(capture.endpoint("/decide"), { method: "POST" }),
        fetch(capture.endpoint("/config"), { method: "POST" }),
        fetch(capture.endpoint("/batch/"), { method: "GET" }),
      ]);
      expect(responses.map(response => response.status)).toEqual([404, 404, 405]);
      expect(() => capture.assertOnlyApprovedRequests()).toThrow(
        "unapproved telemetry capture request(s): POST /decide, POST /config, GET /batch/",
      );
    } finally {
      await capture.close();
    }
  });

  it("allows in-flight OTLP requests to finish but starts no queued trace or log request after opt-out", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "cc-router-otlp-opt-out-"));
    temporaryDirectories.push(testHome);
    const telemetryPath = join(testHome, "telemetry.json");
    writeFileSync(telemetryPath, JSON.stringify(snapshot(true).state));
    const requestCounts = new Map<string, number>();
    const firstResponses = new Map<string, ServerResponse>();
    let notifyFirstRequests!: () => void;
    const firstRequests = new Promise<void>(resolve => { notifyFirstRequests = resolve; });
    const collector = createServer((request, response) => {
      expect(request.socket.remoteAddress).toMatch(/^(?:127\.0\.0\.1|::ffff:127\.0\.0\.1)$/);
      const path = request.url ?? "";
      requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
      if (requestCounts.get(path) === 1) {
        firstResponses.set(path, response);
        if (firstResponses.size === 2) notifyFirstRequests();
        return;
      }
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      collector.once("error", reject);
      collector.listen(0, "127.0.0.1", () => resolve());
    });
    const address = collector.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const exporters = createPostHogOtlpExporters({
      traceUrl: `${origin}/i/v1/traces`,
      logUrl: `${origin}/i/v1/logs`,
      getSnapshot: () => persistedSnapshot(telemetryPath),
      requestTimeoutMillis: CI_DEADLINE_MS,
      exportTimeoutMillis: CI_DEADLINE_MS,
    });
    const spanExportCalls: ReadableSpan[][] = [];
    const logExportCalls: ReadableLogRecord[][] = [];
    const spanResults: number[] = [];
    const logResults: number[] = [];
    const spanProcessor = new BatchSpanProcessor({
      export: (spans, callback) => {
        spanExportCalls.push([...spans]);
        exporters.spanExporter.export(spans, result => {
          spanResults.push(result.code);
          callback(result);
        });
      },
      forceFlush: () => exporters.spanExporter.forceFlush(),
      shutdown: () => exporters.spanExporter.shutdown(),
    }, {
      maxQueueSize: 4,
      maxExportBatchSize: 1,
      scheduledDelayMillis: 1,
      exportTimeoutMillis: CI_DEADLINE_MS,
    });
    const logProcessor = new BatchLogRecordProcessor({
      exporter: {
        export: (logs, callback) => {
          logExportCalls.push([...logs]);
          exporters.logExporter.export(logs, result => {
            logResults.push(result.code);
            callback(result);
          });
        },
        forceFlush: () => exporters.logExporter.forceFlush(),
        shutdown: () => exporters.logExporter.shutdown(),
      },
      maxQueueSize: 4,
      maxExportBatchSize: 1,
      scheduledDelayMillis: 1,
      exportTimeoutMillis: CI_DEADLINE_MS,
    });
    try {
      spanProcessor.onEnd(safeCandidateSpan("0123456789abcdef"));
      logProcessor.onEmit(sdkCandidateLog(1_800_000_000));
      await withinDeadline(firstRequests, "first OTLP trace and log requests did not become in-flight");
      spanProcessor.onEnd(safeCandidateSpan("fedcba9876543210"));
      logProcessor.onEmit(sdkCandidateLog(1_800_000_001));
      // onEnd/onEmit synchronously accept into the real SDK queues; delegate call
      // counts remain one until the deliberately blocked exports complete.
      expect(spanExportCalls).toHaveLength(1);
      expect(logExportCalls).toHaveLength(1);
      expect(spanResults).toEqual([]);
      expect(logResults).toEqual([]);
      const optOutOutput = persistTelemetryOff(testHome, telemetryPath);
      expect(persistedSnapshot(telemetryPath).enabled).toBe(false);
      expect(optOutOutput).toContain("New outbound telemetry stops immediately");
      for (const response of firstResponses.values()) response.end();

      await withinDeadline(
        Promise.all([spanProcessor.forceFlush(), logProcessor.forceFlush()]).then(() => undefined),
        "queued OTLP work did not settle",
      );
      expect(spanExportCalls).toHaveLength(2);
      expect(logExportCalls).toHaveLength(2);
      expect(spanExportCalls.flat().map(span => span.spanContext().spanId)).toEqual([
        "0123456789abcdef",
        "fedcba9876543210",
      ]);
      expect(logExportCalls.flat().map(log => log.hrTime[0])).toEqual([
        1_800_000_000,
        1_800_000_001,
      ]);
      expect(spanResults).toEqual([0, 0]);
      expect(logResults).toEqual([0, 0]);
      expect(Object.fromEntries(requestCounts)).toEqual({
        "/i/v1/traces": 1,
        "/i/v1/logs": 1,
      });
    } finally {
      for (const response of firstResponses.values()) response.end();
      await Promise.allSettled([spanProcessor.shutdown(), logProcessor.shutdown()]);
      await new Promise<void>(resolveClose => {
        collector.close(() => resolveClose());
        collector.closeAllConnections();
      });
    }
  });

  it("allows one in-flight PostHog request to finish while opt-out silently discards queued events and exceptions", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "cc-router-posthog-opt-out-"));
    temporaryDirectories.push(testHome);
    const telemetryPath = join(testHome, "telemetry.json");
    writeFileSync(telemetryPath, JSON.stringify(snapshot(true).state));
    const bodies: Buffer[] = [];
    let inFlightResponse: ServerResponse | undefined;
    let notifyInFlight!: () => void;
    const requestInFlight = new Promise<void>(resolve => { notifyInFlight = resolve; });
    const collector = createServer((request, response) => {
      expect(request.socket.remoteAddress).toMatch(/^(?:127\.0\.0\.1|::ffff:127\.0\.0\.1)$/);
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks));
        if (bodies.length === 1) {
          inFlightResponse = response;
          notifyInFlight();
          return;
        }
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      collector.once("error", reject);
      collector.listen(0, "127.0.0.1", () => resolve());
    });
    const address = collector.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/batch/`;
    const client = createPostHogTelemetryClient({
      getSnapshot: () => persistedSnapshot(telemetryPath),
      transport: async (_url, options) => fetch(endpoint, options as RequestInit),
    });

    try {
      const alreadyInFlight = client.captureAnalyticsImmediate(proxyStartedEvent());
      await withinDeadline(requestInFlight, "first PostHog request did not become in-flight");
      client.captureAnalytics(proxyStartedEvent());
      client.captureException(sanitizedFailure(
        INSTALL_ID,
        "ad94f035-1e08-4e29-8517-fd56bdc83d99",
        TELEMETRY_CANARY.exceptionMessage,
      ));
      const optOutOutput = persistTelemetryOff(testHome, telemetryPath);
      expect(persistedSnapshot(telemetryPath).enabled).toBe(false);
      expect(optOutOutput).toContain("New outbound telemetry stops immediately");
      inFlightResponse?.end();
      await withinDeadline(alreadyInFlight, "in-flight PostHog request did not settle");

      await client.flushWithin(100);
      writeFileSync(telemetryPath, JSON.stringify(snapshot(true).state));
      await client.flushWithin(100);
      expect(bodies).toHaveLength(1);
      expect(JSON.parse(bodies[0]!.toString("utf8"))).toEqual(expect.objectContaining({
        batch: [expect.objectContaining({ event: "proxy.started" })],
      }));
    } finally {
      inFlightResponse?.end();
      await client.shutdownWithin(100);
      await new Promise<void>(resolveClose => {
        collector.close(() => resolveClose());
        collector.closeAllConnections();
      });
    }
  });

  it("correlates repeated sanitized failures by installation without profiles or raw canaries", async () => {
    const postHogCapture = await startTransportCaptureServer();
    const otlpCapture = await startTransportCaptureServer();
    const firstClient = createPostHogTelemetryClient({
      getSnapshot: () => ({ ...snapshot(true), state: { ...snapshot(true).state, installId: INSTALL_ID } }),
      transport: postHogLoopbackTransport(postHogCapture),
    });
    const secondClient = createPostHogTelemetryClient({
      getSnapshot: () => ({ ...snapshot(true), state: { ...snapshot(true).state, installId: OTHER_INSTALL_ID } }),
      transport: postHogLoopbackTransport(postHogCapture),
    });
    const first = sanitizedFailure(
      INSTALL_ID,
      "ad94f035-1e08-4e29-8517-fd56bdc83d99",
      TELEMETRY_CANARY.exceptionMessage,
    );
    const repeated = sanitizedFailure(
      INSTALL_ID,
      "2c61632e-7841-462f-a343-c792666ef57b",
      TELEMETRY_CANARY.prompt,
    );
    const otherInstall = sanitizedFailure(
      OTHER_INSTALL_ID,
      "529c9281-f128-446f-a4eb-0c3309e37a61",
      TELEMETRY_CANARY.rawProviderBody,
    );

    try {
      await firstClient.captureExceptionImmediate(first);
      await firstClient.captureExceptionImmediate(repeated);
      await secondClient.captureExceptionImmediate(otherInstall);

      postHogCapture.assertOnlyApprovedRequests();
      expect(postHogCapture.requests).toHaveLength(3);
      expect(postHogCapture.requests.every(request => request.url === "/batch/")).toBe(true);
      const events = postHogCapture.requests.map(capturedPostHogEvent);
      const properties = events.map(event => event.properties as Record<string, unknown>);
      expect(events.map(event => event.distinct_id)).toEqual([
        INSTALL_ID,
        INSTALL_ID,
        OTHER_INSTALL_ID,
      ]);
      expect(properties.map(value => value.$exception_fingerprint)).toEqual([
        first.fingerprint,
        first.fingerprint,
        first.fingerprint,
      ]);
      expect(properties.every(value => value.$process_person_profile === false)).toBe(true);
      expect(properties.every(value => value.$geoip_disable === true)).toBe(true);

      for (const installId of [INSTALL_ID, OTHER_INSTALL_ID]) {
        const exporters = createPostHogOtlpExporters({
          traceUrl: otlpCapture.endpoint("/i/v1/traces"),
          logUrl: otlpCapture.endpoint("/i/v1/logs"),
          getSnapshot: () => ({
            ...snapshot(true),
            state: { ...snapshot(true).state, installId },
          }),
        });
        await exportSpan(exporters.spanExporter, safeCandidateSpan(
          installId === INSTALL_ID ? "0123456789abcdef" : "fedcba9876543210",
        ));
        await exporters.spanExporter.shutdown();
        await exporters.logExporter.shutdown();
      }

      const traceRequests = otlpCapture.requests.filter(request => request.url === "/i/v1/traces");
      otlpCapture.assertOnlyApprovedRequests();
      expect(traceRequests).toHaveLength(2);
      const decodedTraces = traceRequests.map(request => decodeOtlpProtobuf(request.rawBody, "traces"));
      const resourceInstallId = (decoded: ReturnType<typeof decodeOtlpProtobuf>): unknown => {
        expect(decoded.resourceSpans).toHaveLength(1);
        const resource = (decoded.resourceSpans![0] as {
          resource: { attributes: Record<string, unknown> };
        }).resource;
        return resource.attributes["service.instance.id"];
      };
      const resourceInstallIds = decodedTraces.map(resourceInstallId);
      expect(resourceInstallIds).toEqual([INSTALL_ID, OTHER_INSTALL_ID]);
      const misplacedIdentity = structuredClone(decodedTraces[0]);
      const misplacedResourceSpan = misplacedIdentity.resourceSpans![0] as {
        resource: { attributes: Record<string, unknown> };
        scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
      };
      misplacedResourceSpan.resource.attributes["service.instance.id"] = OTHER_INSTALL_ID;
      misplacedResourceSpan.scopeSpans[0]!.spans[0]!.name = INSTALL_ID;
      expect(JSON.stringify(misplacedIdentity)).toContain(INSTALL_ID);
      expect(resourceInstallId(misplacedIdentity)).toBe(OTHER_INSTALL_ID);

      const rawPostHog = Buffer.concat(postHogCapture.requests.map(request => request.rawBody)).toString("utf8");
      const rawOtlp = Buffer.concat(otlpCapture.requests.map(request => request.rawBody)).toString("utf8");
      const decodedValues = [
        ...semanticStrings(postHogCapture.requests.map(request => request.json)),
        ...semanticStrings(decodedTraces),
      ];
      for (const canary of Object.values(TELEMETRY_CANARY)) {
        for (const representation of telemetryWireRepresentations(canary)) {
          expect(rawPostHog).not.toContain(representation);
          expect(rawOtlp).not.toContain(representation);
        }
        expect(decodedValues.some(value => value.includes(canary))).toBe(false);
      }
    } finally {
      await firstClient.shutdownWithin(100);
      await secondClient.shutdownWithin(100);
      await postHogCapture.close();
      await otlpCapture.close();
    }
  });
});
