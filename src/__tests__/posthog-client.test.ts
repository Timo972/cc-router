import { setImmediate as waitForImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PostHog, type PostHogOptions } from "posthog-node";
import { describe, expect, it, vi } from "vitest";
import { createTelemetryConsentGate, type TelemetrySnapshot } from "../config/telemetry.js";
import type { SafeAnalyticsEvent, SafeExceptionContract } from "../telemetry/contracts.js";
import {
  createPostHogTelemetryClient,
  type PostHogSdkClient,
  type PostHogTransport,
} from "../telemetry/posthog-client.js";
import { reconstructAnalyticsEvent, sanitizeException } from "../telemetry/privacy.js";

const INSTALL_ID = "70d8062e-1fa0-4ae4-a115-bf782ecca462";
const OTHER_INSTALL_ID = "916ce1d6-2e8d-48b2-a70e-0337bdf82df7";
const DIAGNOSTIC_ID = "ad94f035-1e08-4e29-8517-fd56bdc83d99";
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/+$/, "");
const CONSENT_GENERATION = "123e4567-e89b-42d3-a456-426614174010";
const NEXT_CONSENT_GENERATION = "123e4567-e89b-42d3-a456-426614174011";

function snapshot(enabled = true, consentGeneration = CONSENT_GENERATION): TelemetrySnapshot {
  return {
    state: {
      enabled,
      installId: INSTALL_ID,
      firstRunAt: "2026-08-03T00:00:00.000Z",
      consentGeneration,
    },
    environmentDisabled: false,
    enabled,
  };
}

function analyticsEvent(): SafeAnalyticsEvent {
  const event = reconstructAnalyticsEvent({
    event: "account_setup.failed",
    installationId: "candidate identity must be ignored",
    properties: {
      provider: "openai",
      method: "device_oauth",
      stage: "token_exchange",
      reason: "unauthorized",
      durationBucket: "5s_to_30s",
      serviceVersion: "0.8.2",
      osFamily: "macos",
      runtimeMode: "foreground",
      diagnosticId: "candidate diagnostic must be ignored",
    },
  }, { installationId: OTHER_INSTALL_ID, diagnosticId: DIAGNOSTIC_ID });
  if (!event) throw new Error("test analytics fixture must be valid");
  return event;
}

function exceptionContract(): SafeExceptionContract {
  const error = Object.assign(new TypeError("PRIVATE exception message"), {
    code: "ECONNRESET",
    statusCode: 502,
    token: "PRIVATE token",
  });
  error.stack = [
    "TypeError: PRIVATE exception message",
    `    at persist (${PROJECT_ROOT}/dist/config/store.js:42:7)`,
    `    at dependency (${PROJECT_ROOT}/node_modules/@scope/safe-package/lib/index.js:19:4)`,
    "    at private (/Users/alice/private.js:1:2)",
  ].join("\n");

  const contract = sanitizeException(error, {
    category: "setup",
    reason: "persistence_failure",
    operation: "oauth.refresh",
    provider: "openai",
    setupStage: "persistence",
    runtimeMode: "foreground",
  }, { installationId: INSTALL_ID, diagnosticId: DIAGNOSTIC_ID });
  if (!contract) throw new Error("test exception fixture must be valid");
  return contract;
}

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function successfulResponse() {
  return { status: 200, text: async () => "", json: async () => ({}), headers: { get: () => null } };
}

function captureTransport(requests: CapturedRequest[]): PostHogTransport {
  return async (url, options) => {
    if (typeof options.body !== "string") throw new Error("test transport expects uncompressed JSON");
    requests.push({ url, body: JSON.parse(options.body) as Record<string, unknown> });
    return successfulResponse();
  };
}

function capturedEvent(request: CapturedRequest): Record<string, unknown> {
  const batch = request.body.batch;
  if (!Array.isArray(batch) || batch.length !== 1 || typeof batch[0] !== "object" || batch[0] === null) {
    throw new Error("test transport expected one PostHog batch event");
  }
  return batch[0] as Record<string, unknown>;
}

describe("gated PostHog EU client", () => {
  it("exposes only typed capture and lifecycle methods", () => {
    const client = createPostHogTelemetryClient({ getSnapshot: () => undefined });

    expect(Object.keys(client).sort()).toEqual([
      "captureAnalytics",
      "captureException",
      "captureExceptionImmediate",
      "discardPending",
      "flushWithin",
      "shutdownWithin",
    ]);
    expect(client).not.toHaveProperty("capture");
    expect(client).not.toHaveProperty("identify");
    expect(client).not.toHaveProperty("alias");
    expect(client).not.toHaveProperty("groupIdentify");
  });

  it("initializes lazily after late enablement without installing raw exception listeners", async () => {
    let current: TelemetrySnapshot | undefined;
    let creations = 0;
    const requests: CapturedRequest[] = [];
    const uncaughtBefore = process.listenerCount("uncaughtException");
    const rejectionBefore = process.listenerCount("unhandledRejection");
    const client = createPostHogTelemetryClient({
      getSnapshot: () => current,
      fetch: captureTransport(requests),
      createSdkClient: (token, options) => {
        creations += 1;
        return new PostHog(token, options);
      },
    });

    client.captureAnalytics(analyticsEvent(), CONSENT_GENERATION);
    await client.flushWithin(100);
    expect(creations).toBe(0);

    current = snapshot(true);
    client.captureAnalytics(analyticsEvent(), CONSENT_GENERATION);
    await client.flushWithin(100);

    expect(creations).toBe(1);
    expect(requests).toHaveLength(1);
    expect(process.listenerCount("uncaughtException")).toBe(uncaughtBefore);
    expect(process.listenerCount("unhandledRejection")).toBe(rejectionBefore);
    await client.shutdownWithin(100);
  });

  it("sends analytics only to the EU host with the trusted install ID and privacy flags", async () => {
    const requests: CapturedRequest[] = [];
    const client = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      fetch: captureTransport(requests),
    });
    const hostile = {
      ...analyticsEvent(),
      installationId: OTHER_INSTALL_ID,
      properties: {
        ...analyticsEvent().properties,
        prompt: "PRIVATE prompt",
        accountId: "PRIVATE account",
        $set: { email: "private@example.test" },
      },
    } as unknown as SafeAnalyticsEvent;

    client.captureAnalytics(hostile, CONSENT_GENERATION);
    await client.flushWithin(100);

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).origin).toBe("https://eu.i.posthog.com");
    const event = capturedEvent(requests[0]!);
    expect(event.event).toBe("account_setup.failed");
    expect(event.distinct_id).toBe(INSTALL_ID);
    expect(event.properties).toEqual({
      provider: "openai",
      method: "device_oauth",
      stage: "token_exchange",
      reason: "unauthorized",
      durationBucket: "5s_to_30s",
      serviceVersion: "0.8.2",
      osFamily: "macos",
      runtimeMode: "foreground",
      diagnosticId: DIAGNOSTIC_ID,
      $process_person_profile: false,
      $lib: "posthog-node",
      $lib_version: expect.any(String),
      $is_server: true,
      $geoip_disable: true,
    });
    expect(JSON.stringify(event)).not.toContain("PRIVATE");
    expect(JSON.stringify(event)).not.toContain(OTHER_INSTALL_ID);
    expect(JSON.stringify(event)).not.toContain(CONSENT_GENERATION);
    await client.shutdownWithin(100);
  });

  it("reconstructs real SDK exception output to the required safe error-tracking structure", async () => {
    const requests: CapturedRequest[] = [];
    const client = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      fetch: captureTransport(requests),
    });
    const safeException = exceptionContract();
    const hostile = {
      ...safeException,
      token: "PRIVATE token",
      request: { url: "https://private.example.test" },
    } as SafeExceptionContract;

    await client.captureExceptionImmediate(hostile, CONSENT_GENERATION);

    expect(requests).toHaveLength(1);
    const event = capturedEvent(requests[0]!);
    expect(event.event).toBe("$exception");
    expect(event.distinct_id).toBe(INSTALL_ID);
    expect(event.properties).toEqual({
      $exception_list: [{
        type: "Error",
        value: "persistence_failure",
        mechanism: { type: "generic", handled: true, synthetic: false },
        stacktrace: {
          type: "raw",
          frames: [
            {
              platform: "node:javascript",
              filename: "node_modules/@scope/safe-package/lib/index.js",
              lineno: 19,
              colno: 4,
            },
            { platform: "node:javascript", filename: "dist/config/store.js", lineno: 42, colno: 7 },
          ],
        },
      }],
      $exception_level: "error",
      $exception_fingerprint: safeException.fingerprint,
      category: "setup",
      reason: "persistence_failure",
      errorKind: "type_error",
      systemErrorCode: "ECONNRESET",
      httpStatusCode: 502,
      operation: "oauth.refresh",
      provider: "openai",
      setupStage: "persistence",
      runtimeMode: "foreground",
      diagnosticId: DIAGNOSTIC_ID,
      $process_person_profile: false,
      $lib: "posthog-node",
      $lib_version: expect.any(String),
      $is_server: true,
      $geoip_disable: true,
    });
    const serialized = JSON.stringify(event);
    for (const forbidden of [
      "PRIVATE",
      "/Users/alice",
      "private.example.test",
      "abs_path",
      "context_line",
      "pre_context",
      "post_context",
      "vars",
      CONSENT_GENERATION,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    await client.shutdownWithin(100);
  });

  it("drops malformed analytics and exceptions before transport", async () => {
    const requests: CapturedRequest[] = [];
    const client = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      fetch: captureTransport(requests),
    });

    client.captureAnalytics({ ...analyticsEvent(), event: "unknown.event" } as unknown as SafeAnalyticsEvent, CONSENT_GENERATION);
    await expect(client.captureExceptionImmediate(
      { ...exceptionContract(), fingerprint: "not-a-safe-fingerprint" } as SafeExceptionContract,
      CONSENT_GENERATION,
    )).resolves.toBeUndefined();
    await client.flushWithin(100);

    expect(requests).toHaveLength(0);
    await client.shutdownWithin(100);
  });

  it("rechecks effective state in before_send and immediately before transport", async () => {
    const requests: CapturedRequest[] = [];
    let reads = 0;
    const client = createPostHogTelemetryClient({
      getSnapshot: () => {
        reads += 1;
        return reads < 3 ? snapshot() : undefined;
      },
      fetch: captureTransport(requests),
    });

    await expect(client.captureExceptionImmediate(
      exceptionContract(),
      CONSENT_GENERATION,
    )).resolves.toBeUndefined();

    expect(reads).toBeGreaterThanOrEqual(3);
    expect(requests).toHaveLength(0);
    await client.shutdownWithin(100);
  });

  it("never revives queued captures after an explicit choice, and a new client adopts it", async () => {
    let current = snapshot(true, CONSENT_GENERATION);
    const requests: CapturedRequest[] = [];
    const oldGate = createTelemetryConsentGate(() => current);
    const oldClient = createPostHogTelemetryClient({
      getSnapshot: () => oldGate.getSnapshot(),
      fetch: captureTransport(requests),
    });

    oldClient.captureAnalytics(analyticsEvent(), CONSENT_GENERATION);
    await waitForImmediate();
    current = snapshot(true, NEXT_CONSENT_GENERATION);
    await oldClient.flushWithin(100);
    current = snapshot(true, CONSENT_GENERATION);
    oldClient.captureAnalytics(analyticsEvent(), CONSENT_GENERATION);
    await oldClient.flushWithin(100);
    expect(requests).toHaveLength(0);
    expect(oldGate.latched).toBe(true);

    current = snapshot(true, NEXT_CONSENT_GENERATION);
    const newGate = createTelemetryConsentGate(() => current);
    const newClient = createPostHogTelemetryClient({
      getSnapshot: () => newGate.getSnapshot(),
      fetch: captureTransport(requests),
    });
    newClient.captureAnalytics(analyticsEvent(), NEXT_CONSENT_GENERATION);
    await newClient.flushWithin(100);

    expect(requests).toHaveLength(1);
    await oldClient.shutdownWithin(100);
    await newClient.shutdownWithin(100);
  });

  it.each(["analytics", "exception"] as const)(
    "discards queued %s without contacting transport",
    async (kind) => {
      const requests: CapturedRequest[] = [];
      const client = createPostHogTelemetryClient({
        getSnapshot: () => snapshot(),
        fetch: captureTransport(requests),
      });

      if (kind === "analytics") client.captureAnalytics(analyticsEvent(), CONSENT_GENERATION);
      else client.captureException(exceptionContract(), CONSENT_GENERATION);
      await waitForImmediate();
      client.discardPending();
      await client.flushWithin(100);

      expect(requests).toHaveLength(0);
      await client.shutdownWithin(100);
    },
  );

  it("bounds flush and shutdown waits even when the SDK does not settle", async () => {
    let releaseTransport: (() => void) | undefined;
    const client = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      fetch: () => new Promise(resolve => { releaseTransport = () => resolve(successfulResponse()); }),
    });
    client.captureAnalytics(analyticsEvent(), CONSENT_GENERATION);
    await waitForImmediate();

    const flushStarted = Date.now();
    await client.flushWithin(10);
    expect(Date.now() - flushStarted).toBeLessThan(250);

    const shutdownStarted = Date.now();
    await client.shutdownWithin(10);
    expect(Date.now() - shutdownStarted).toBeLessThan(250);
    releaseTransport?.();
  });

  it("aborts an in-flight transport when bounded shutdown expires", async () => {
    let transportSignal: AbortSignal | undefined;
    const client = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      fetch: (_url, options) => new Promise((_resolve, reject) => {
        transportSignal = options.signal ?? undefined;
        transportSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        if (transportSignal?.aborted) reject(new Error("aborted"));
      }),
    });
    const capture = client.captureExceptionImmediate(exceptionContract(), CONSENT_GENERATION);
    await vi.waitFor(() => expect(transportSignal).toBeDefined());

    await client.shutdownWithin(10);

    expect(transportSignal?.aborted).toBe(true);
    await expect(capture).resolves.toBeUndefined();
  });

  it("swallows SDK initialization, capture, transport, flush, and shutdown failures", async () => {
    const throwingFactory = vi.fn((_token: string, _options: PostHogOptions): PostHogSdkClient => {
      throw new Error("initialization failed");
    });
    const initializationFailure = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      createSdkClient: throwingFactory,
    });

    expect(() => initializationFailure.captureAnalytics(analyticsEvent(), CONSENT_GENERATION)).not.toThrow();
    await expect(initializationFailure.captureExceptionImmediate(
      exceptionContract(),
      CONSENT_GENERATION,
    )).resolves.toBeUndefined();
    await expect(initializationFailure.flushWithin(10)).resolves.toBeUndefined();
    await expect(initializationFailure.shutdownWithin(10)).resolves.toBeUndefined();
    expect(throwingFactory).toHaveBeenCalled();

    const transportFailure = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      fetch: async () => { throw new Error("transport failed"); },
    });
    await expect(transportFailure.captureExceptionImmediate(
      exceptionContract(),
      CONSENT_GENERATION,
    )).resolves.toBeUndefined();
    await expect(transportFailure.flushWithin(10)).resolves.toBeUndefined();
    await expect(transportFailure.shutdownWithin(10)).resolves.toBeUndefined();

    const lifecycleFailure = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      createSdkClient: () => ({
        capture: () => { throw new Error("capture failed"); },
        captureException: () => { throw new Error("capture failed"); },
        captureExceptionImmediate: async () => { throw new Error("capture failed"); },
        flush: async () => { throw new Error("flush failed"); },
        shutdown: async () => { throw new Error("shutdown failed"); },
        setPersistedProperty: () => { throw new Error("discard failed"); },
      }),
    });
    expect(() => lifecycleFailure.captureAnalytics(analyticsEvent(), CONSENT_GENERATION)).not.toThrow();
    expect(() => lifecycleFailure.captureException(exceptionContract(), CONSENT_GENERATION)).not.toThrow();
    await expect(lifecycleFailure.captureExceptionImmediate(
      exceptionContract(),
      CONSENT_GENERATION,
    )).resolves.toBeUndefined();
    expect(() => lifecycleFailure.discardPending()).not.toThrow();
    await expect(lifecycleFailure.flushWithin(10)).resolves.toBeUndefined();
    await expect(lifecycleFailure.shutdownWithin(10)).resolves.toBeUndefined();
  });
});
