import { setImmediate as waitForImmediate } from "node:timers/promises";
import { PostHog, type PostHogOptions } from "posthog-node";
import { describe, expect, it, vi } from "vitest";
import type { TelemetrySnapshot } from "../config/telemetry.js";
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
const PROJECT_ROOT = "/workspace/cc-router";

function snapshot(enabled = true, revision = 0): TelemetrySnapshot {
  return {
    state: {
      enabled,
      installId: INSTALL_ID,
      firstRunAt: "2026-08-03T00:00:00.000Z",
      revision,
    },
    environmentDisabled: false,
    enabled,
  };
}

function analyticsEvent(): SafeAnalyticsEvent {
  const event = reconstructAnalyticsEvent({
    event: "account_setup.failed",
    distinctId: "candidate identity must be ignored",
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
  }, {
    installationId: OTHER_INSTALL_ID,
    diagnosticId: DIAGNOSTIC_ID,
  });
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
  }, {
    installationId: INSTALL_ID,
    diagnosticId: DIAGNOSTIC_ID,
  }, { projectRoot: PROJECT_ROOT });
  if (!contract) throw new Error("test exception fixture must be valid");
  return contract;
}

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function successfulResponse() {
  return {
    status: 200,
    text: async () => "",
    json: async () => ({}),
    headers: { get: () => null },
  };
}

function captureTransport(requests: CapturedRequest[]): PostHogTransport {
  return async (url, options) => {
    if (typeof options.body !== "string") throw new Error("test transport expects uncompressed JSON");
    requests.push({
      url,
      body: JSON.parse(options.body) as Record<string, unknown>,
    });
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
    const client = createPostHogTelemetryClient({ getSnapshot: () => snapshot(false) });

    expect(Object.keys(client).sort()).toEqual([
      "captureAnalytics",
      "captureAnalyticsImmediate",
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
    let currentSnapshot = snapshot(false);
    let creations = 0;
    const requests: CapturedRequest[] = [];
    const uncaughtBefore = process.listenerCount("uncaughtException");
    const rejectionBefore = process.listenerCount("unhandledRejection");
    const client = createPostHogTelemetryClient({
      getSnapshot: () => currentSnapshot,
      transport: captureTransport(requests),
      createSdkClient: (token, options) => {
        creations += 1;
        return new PostHog(token, options);
      },
    });

    await client.captureAnalyticsImmediate(analyticsEvent());
    expect(creations).toBe(0);

    currentSnapshot = snapshot(true);
    await client.captureAnalyticsImmediate(analyticsEvent());

    expect(creations).toBe(1);
    expect(requests).toHaveLength(1);
    expect(process.listenerCount("uncaughtException")).toBe(uncaughtBefore);
    expect(process.listenerCount("unhandledRejection")).toBe(rejectionBefore);
    await client.shutdownWithin(100);
  });

  it("sends immediate analytics only to the EU host with the trusted install ID and privacy flags", async () => {
    const requests: CapturedRequest[] = [];
    const client = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      transport: captureTransport(requests),
    });
    const hostile = {
      ...analyticsEvent(),
      distinctId: OTHER_INSTALL_ID,
      properties: {
        ...analyticsEvent().properties,
        prompt: "PRIVATE prompt",
        accountId: "PRIVATE account",
        $set: { email: "private@example.test" },
      },
    } as unknown as SafeAnalyticsEvent;

    await client.captureAnalyticsImmediate(hostile);

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
    await client.shutdownWithin(100);
  });

  it("reconstructs real SDK exception output to the required safe error-tracking structure", async () => {
    const requests: CapturedRequest[] = [];
    const client = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      transport: captureTransport(requests),
    });
    const safeException = exceptionContract();
    const hostile = {
      ...safeException,
      token: "PRIVATE token",
      request: { url: "https://private.example.test" },
    } as SafeExceptionContract;

    await client.captureExceptionImmediate(hostile);

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
            {
              platform: "node:javascript",
              filename: "dist/config/store.js",
              lineno: 42,
              colno: 7,
            },
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
    for (const forbidden of ["PRIVATE", "/Users/alice", "private.example.test", "abs_path", "context_line", "pre_context", "post_context", "vars"]) {
      expect(serialized).not.toContain(forbidden);
    }
    await client.shutdownWithin(100);
  });

  it("drops malformed analytics and exceptions before transport", async () => {
    const requests: CapturedRequest[] = [];
    const client = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      transport: captureTransport(requests),
    });
    const malformedAnalytics = {
      ...analyticsEvent(),
      event: "unknown.event",
    } as unknown as SafeAnalyticsEvent;
    const malformedException = {
      ...exceptionContract(),
      fingerprint: "not-a-safe-fingerprint",
    } as unknown as SafeExceptionContract;

    await expect(client.captureAnalyticsImmediate(malformedAnalytics)).resolves.toBeUndefined();
    await expect(client.captureExceptionImmediate(malformedException)).resolves.toBeUndefined();

    expect(requests).toHaveLength(0);
    await client.shutdownWithin(100);
  });

  it("rechecks effective state in before_send and immediately before transport", async () => {
    const requests: CapturedRequest[] = [];
    let reads = 0;
    const client = createPostHogTelemetryClient({
      getSnapshot: () => {
        reads += 1;
        return snapshot(reads < 3);
      },
      transport: captureTransport(requests),
    });

    await expect(client.captureAnalyticsImmediate(analyticsEvent())).resolves.toBeUndefined();

    expect(reads).toBeGreaterThanOrEqual(3);
    expect(requests).toHaveLength(0);
    await client.shutdownWithin(100);
  });

  it("cancels analytics still preparing when opt-out and discard happen immediately", async () => {
    let currentSnapshot = snapshot(true);
    const requests: CapturedRequest[] = [];
    const client = createPostHogTelemetryClient({
      getSnapshot: () => currentSnapshot,
      transport: captureTransport(requests),
    });

    client.captureAnalytics(analyticsEvent());
    currentSnapshot = snapshot(false);
    client.discardPending();
    currentSnapshot = snapshot(true);
    await client.flushWithin(100);

    expect(requests).toHaveLength(0);
    await client.shutdownWithin(100);
  });

  it("cancels exceptions still preparing when opt-out and discard happen immediately", async () => {
    let currentSnapshot = snapshot(true);
    const requests: CapturedRequest[] = [];
    const client = createPostHogTelemetryClient({
      getSnapshot: () => currentSnapshot,
      transport: captureTransport(requests),
    });

    client.captureException(exceptionContract());
    currentSnapshot = snapshot(false);
    client.discardPending();
    currentSnapshot = snapshot(true);
    await client.flushWithin(100);

    expect(requests).toHaveLength(0);
    await client.shutdownWithin(100);
  });

  it("never revives queued analytics after persisted off then on before flush", async () => {
    let currentSnapshot = snapshot(true, 10);
    const requests: CapturedRequest[] = [];
    const oldClient = createPostHogTelemetryClient({
      getSnapshot: () => currentSnapshot,
      transport: captureTransport(requests),
    });

    oldClient.captureAnalytics(analyticsEvent());
    await waitForImmediate();
    currentSnapshot = snapshot(true, 12);
    await oldClient.flushWithin(100);
    currentSnapshot = snapshot(true, 10);
    oldClient.captureAnalytics(analyticsEvent());
    await oldClient.flushWithin(100);
    expect(requests).toHaveLength(0);

    currentSnapshot = snapshot(true, 12);
    const newClient = createPostHogTelemetryClient({
      getSnapshot: () => currentSnapshot,
      transport: captureTransport(requests),
    });
    await newClient.captureAnalyticsImmediate(analyticsEvent());
    expect(requests).toHaveLength(1);
    await oldClient.shutdownWithin(100);
    await newClient.shutdownWithin(100);
  });

  it("never revives queued exceptions after persisted off then on before flush", async () => {
    let currentSnapshot = snapshot(true, 20);
    const requests: CapturedRequest[] = [];
    const oldClient = createPostHogTelemetryClient({
      getSnapshot: () => currentSnapshot,
      transport: captureTransport(requests),
    });

    oldClient.captureException(exceptionContract());
    await waitForImmediate();
    currentSnapshot = snapshot(true, 22);
    await oldClient.flushWithin(100);
    currentSnapshot = snapshot(true, 20);
    oldClient.captureException(exceptionContract());
    await oldClient.flushWithin(100);
    expect(requests).toHaveLength(0);

    currentSnapshot = snapshot(true, 22);
    const newClient = createPostHogTelemetryClient({
      getSnapshot: () => currentSnapshot,
      transport: captureTransport(requests),
    });
    await newClient.captureExceptionImmediate(exceptionContract());
    expect(requests).toHaveLength(1);
    await oldClient.shutdownWithin(100);
    await newClient.shutdownWithin(100);
  });

  it("discards queued events without contacting transport", async () => {
    const requests: CapturedRequest[] = [];
    const client = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      transport: captureTransport(requests),
    });

    client.captureAnalytics(analyticsEvent());
    await waitForImmediate();
    client.discardPending();
    await client.flushWithin(100);

    expect(requests).toHaveLength(0);
    await client.shutdownWithin(100);
  });

  it("bounds flush and shutdown waits even when the SDK does not settle", async () => {
    let releaseTransport: (() => void) | undefined;
    const transport: PostHogTransport = () => new Promise(resolve => {
      releaseTransport = () => resolve(successfulResponse());
    });
    const client = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      transport,
    });
    client.captureAnalytics(analyticsEvent());
    await waitForImmediate();

    const flushStarted = Date.now();
    await client.flushWithin(10);
    expect(Date.now() - flushStarted).toBeLessThan(250);

    const shutdownStarted = Date.now();
    await client.shutdownWithin(10);
    expect(Date.now() - shutdownStarted).toBeLessThan(250);
    releaseTransport?.();
  });

  it.each([
    ["analytics", "throw"],
    ["analytics", "http_error"],
    ["exception", "throw"],
    ["exception", "http_error"],
  ] as const)(
    "forgets %s immediate capture provenance after a %s transport failure",
    async (captureKind, failureMode) => {
      let mode: "throw" | "http_error" | "success" = failureMode;
      let gatedFetch: PostHogTransport | undefined;
      let attemptedRequest: Parameters<PostHogTransport> | undefined;
      let underlyingCalls = 0;
      const transport: PostHogTransport = async (url, options) => {
        underlyingCalls += 1;
        attemptedRequest = [url, options];
        if (mode === "throw") throw new Error("transport failed");
        return { ...successfulResponse(), status: mode === "http_error" ? 500 : 200 };
      };
      const client = createPostHogTelemetryClient({
        getSnapshot: () => snapshot(),
        transport,
        createSdkClient: (token, options) => {
          gatedFetch = options.fetch;
          return new PostHog(token, options);
        },
      });

      if (captureKind === "analytics") {
        await client.captureAnalyticsImmediate(analyticsEvent());
      } else {
        await client.captureExceptionImmediate(exceptionContract());
      }
      expect(underlyingCalls).toBe(1);
      if (!gatedFetch || !attemptedRequest) throw new Error("test must capture the gated SDK request");

      mode = "success";
      await gatedFetch(...attemptedRequest);

      expect(underlyingCalls).toBe(1);
      await client.shutdownWithin(100);
    },
  );

  it("fails closed for provenance evicted with the SDK's bounded queue", async () => {
    let gatedFetch: PostHogTransport | undefined;
    let sdkClient: PostHog | undefined;
    const queuedMessages: Record<string, unknown>[] = [];
    let underlyingCalls = 0;
    const client = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      transport: async () => {
        underlyingCalls += 1;
        return successfulResponse();
      },
      createSdkClient: (token, options) => {
        gatedFetch = options.fetch;
        sdkClient = new PostHog(token, { ...options, flushAt: 100, maxQueueSize: 100, flushInterval: 0 });
        sdkClient.flush = async () => undefined;
        sdkClient.on("capture", message => {
          if (typeof message === "object" && message !== null) {
            queuedMessages.push(message as Record<string, unknown>);
          }
        });
        return sdkClient;
      },
    });

    for (let index = 0; index < 101; index += 1) client.captureAnalytics(analyticsEvent());
    await waitForImmediate();

    expect(queuedMessages).toHaveLength(101);
    const evicted = queuedMessages[0];
    if (!evicted || !gatedFetch || !sdkClient) throw new Error("test must observe the real SDK queue");
    const queue = sdkClient.getPersistedProperty("queue" as Parameters<PostHog["getPersistedProperty"]>[0]) as Array<{
      message?: Record<string, unknown>;
    }>;
    expect(queue).toHaveLength(100);
    expect(queue.some(item => item.message?.uuid === evicted.uuid)).toBe(false);

    await gatedFetch("https://eu.i.posthog.com/batch/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch: [evicted] }),
    });

    expect(underlyingCalls).toBe(0);
    client.discardPending();
    await client.shutdownWithin(100);
  });

  it("swallows SDK initialization, capture, transport, flush, and shutdown failures", async () => {
    const throwingFactory = vi.fn((_token: string, _options: PostHogOptions): PostHogSdkClient => {
      throw new Error("initialization failed");
    });
    const initializationFailure = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      createSdkClient: throwingFactory,
    });

    expect(() => initializationFailure.captureAnalytics(analyticsEvent())).not.toThrow();
    await expect(initializationFailure.captureAnalyticsImmediate(analyticsEvent())).resolves.toBeUndefined();
    await expect(initializationFailure.captureExceptionImmediate(exceptionContract())).resolves.toBeUndefined();
    await expect(initializationFailure.flushWithin(10)).resolves.toBeUndefined();
    await expect(initializationFailure.shutdownWithin(10)).resolves.toBeUndefined();
    expect(throwingFactory).toHaveBeenCalled();

    const transportFailure = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      transport: async () => { throw new Error("transport failed"); },
    });
    await expect(transportFailure.captureAnalyticsImmediate(analyticsEvent())).resolves.toBeUndefined();
    await expect(transportFailure.flushWithin(10)).resolves.toBeUndefined();
    await expect(transportFailure.shutdownWithin(10)).resolves.toBeUndefined();

    const lifecycleFailure = createPostHogTelemetryClient({
      getSnapshot: () => snapshot(),
      createSdkClient: () => ({
        capture: () => { throw new Error("capture failed"); },
        captureImmediate: async () => { throw new Error("capture failed"); },
        captureException: () => { throw new Error("capture failed"); },
        captureExceptionImmediate: async () => { throw new Error("capture failed"); },
        flush: async () => { throw new Error("flush failed"); },
        shutdown: async () => { throw new Error("shutdown failed"); },
        getPersistedProperty: () => undefined,
        setPersistedProperty: () => { throw new Error("discard failed"); },
      }),
    });
    expect(() => lifecycleFailure.captureAnalytics(analyticsEvent())).not.toThrow();
    await expect(lifecycleFailure.captureAnalyticsImmediate(analyticsEvent())).resolves.toBeUndefined();
    await expect(lifecycleFailure.captureExceptionImmediate(exceptionContract())).resolves.toBeUndefined();
    expect(() => lifecycleFailure.discardPending()).not.toThrow();
    await expect(lifecycleFailure.flushWithin(10)).resolves.toBeUndefined();
    await expect(lifecycleFailure.shutdownWithin(10)).resolves.toBeUndefined();
  });
});
