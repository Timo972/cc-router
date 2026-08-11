import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";

// ─── Isolated temp directory for every run ───────────────────────────────────
const MOCK_DIR = vi.hoisted(() => {
  const tmp = process.env["TMPDIR"] ?? process.env["TEMP"] ?? "/tmp";
  return `${tmp}/cc-router-telemetry-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
});

vi.mock("../config/paths.js", () => ({
  CONFIG_DIR: MOCK_DIR,
  TELEMETRY_PATH: `${MOCK_DIR}/telemetry.json`,
  ACCOUNTS_PATH: `${MOCK_DIR}/accounts.json`,
  CLAUDE_SETTINGS_PATH: `${MOCK_DIR}/settings.json`,
  CONFIG_PATH: `${MOCK_DIR}/config.json`,
  PROXY_PORT: 3456,
  LITELLM_PORT: 4000,
  LITELLM_URL: undefined,
}));

import {
  loadTelemetryState,
  writeTelemetryState,
  getTelemetrySnapshot,
  isTelemetryEnabled,
  claimTelemetryFirstStart,
  type TelemetryState,
} from "../config/telemetry.js";

beforeEach(() => {
  fs.mkdirSync(MOCK_DIR, { recursive: true });
  // Reset env vars
  delete process.env["DO_NOT_TRACK"];
  delete process.env["CC_ROUTER_TELEMETRY"];
});

afterEach(() => {
  fs.rmSync(MOCK_DIR, { recursive: true, force: true });
  delete process.env["DO_NOT_TRACK"];
  delete process.env["CC_ROUTER_TELEMETRY"];
});

// ─── TelemetryState persistence ──────────────────────────────────────────────

describe("loadTelemetryState", () => {
  it("creates fresh state with UUID and persists on first call", () => {
    const state = loadTelemetryState();
    expect(state.enabled).toBe(true);
    expect(state.installId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(new Date(state.firstRunAt).getTime()).toBeGreaterThan(0);

    // Was persisted to disk
    const onDisk = JSON.parse(
      fs.readFileSync(`${MOCK_DIR}/telemetry.json`, "utf-8"),
    ) as TelemetryState;
    expect(onDisk.installId).toBe(state.installId);
  });

  it("returns the same installId on subsequent calls", () => {
    const first = loadTelemetryState();
    const second = loadTelemetryState();
    expect(second.installId).toBe(first.installId);
  });

  it("lets only the process that creates fresh state claim first start once", () => {
    const created = loadTelemetryState();

    expect(claimTelemetryFirstStart()?.state.installId).toBe(created.installId);
    expect(claimTelemetryFirstStart()).toBeUndefined();

    fs.rmSync(MOCK_DIR, { recursive: true, force: true });
    fs.mkdirSync(MOCK_DIR, { recursive: true });
    loadTelemetryState();
    expect(claimTelemetryFirstStart()).toBeUndefined();

    fs.rmSync(MOCK_DIR, { recursive: true, force: true });
    fs.mkdirSync(MOCK_DIR, { recursive: true });
    writeTelemetryState({
      enabled: true,
      installId: "existing-install-id",
      firstRunAt: "2026-01-01T00:00:00.000Z",
    });
    expect(loadTelemetryState().installId).toBe("existing-install-id");
    expect(claimTelemetryFirstStart()).toBeUndefined();
  });

  it("recovers from corrupted JSON", () => {
    fs.writeFileSync(`${MOCK_DIR}/telemetry.json`, "NOT_JSON{}", "utf-8");
    const state = loadTelemetryState();
    expect(state.enabled).toBe(true);
    expect(state.installId).toBeDefined();
  });

  it("migrates a state missing enabled to enabled without replacing its install identity", () => {
    fs.writeFileSync(`${MOCK_DIR}/telemetry.json`, JSON.stringify({
      installId: "existing-install-id",
      firstRunAt: "2026-01-01T00:00:00.000Z",
    }), "utf-8");

    expect(loadTelemetryState()).toEqual({
      enabled: true,
      installId: "existing-install-id",
      firstRunAt: "2026-01-01T00:00:00.000Z",
    });
    expect(JSON.parse(fs.readFileSync(`${MOCK_DIR}/telemetry.json`, "utf-8"))).toEqual({
      enabled: true,
      installId: "existing-install-id",
      firstRunAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it.each([true, false])("preserves a persisted enabled value of %s", (enabled) => {
    fs.writeFileSync(`${MOCK_DIR}/telemetry.json`, JSON.stringify({
      enabled,
      installId: "existing-install-id",
      firstRunAt: "2026-01-01T00:00:00.000Z",
    }), "utf-8");

    expect(loadTelemetryState().enabled).toBe(enabled);
  });

  it("atomically rewrites every missing state field", () => {
    fs.writeFileSync(`${MOCK_DIR}/telemetry.json`, "{}", "utf-8");

    const state = loadTelemetryState();

    expect(state.enabled).toBe(true);
    expect(state.installId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(new Date(state.firstRunAt).getTime()).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(`${MOCK_DIR}/telemetry.json`, "utf-8"))).toEqual(state);
    expect(fs.existsSync(`${MOCK_DIR}/telemetry.json.tmp`)).toBe(false);
  });
});

describe("writeTelemetryState", () => {
  it("atomically writes state", () => {
    const state: TelemetryState = {
      enabled: false,
      installId: "test-uuid",
      firstRunAt: "2026-01-01T00:00:00.000Z",
    };
    writeTelemetryState(state);
    const raw = JSON.parse(
      fs.readFileSync(`${MOCK_DIR}/telemetry.json`, "utf-8"),
    ) as TelemetryState;
    expect(raw).toEqual(state);
    // .tmp was cleaned up (rename replaces)
    expect(fs.existsSync(`${MOCK_DIR}/telemetry.json.tmp`)).toBe(false);
  });
});

// ─── Effective telemetry enablement ──────────────────────────────────────────

describe("isTelemetryEnabled", () => {
  it("returns true for fresh persisted state", () => {
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("lets DO_NOT_TRACK=1 disable a persisted opt-in", () => {
    writeTelemetryState({
      enabled: true,
      installId: "existing-install-id",
      firstRunAt: "2026-01-01T00:00:00.000Z",
    });
    process.env["DO_NOT_TRACK"] = "1";
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("lets CC_ROUTER_TELEMETRY=0 disable a persisted opt-in", () => {
    writeTelemetryState({
      enabled: true,
      installId: "existing-install-id",
      firstRunAt: "2026-01-01T00:00:00.000Z",
    });
    process.env["CC_ROUTER_TELEMETRY"] = "0";
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("does not let non-kill-switch environment values override a persisted opt-out", () => {
    writeTelemetryState({
      enabled: false,
      installId: "existing-install-id",
      firstRunAt: "2026-01-01T00:00:00.000Z",
    });
    process.env["DO_NOT_TRACK"] = "0";
    process.env["CC_ROUTER_TELEMETRY"] = "1";

    expect(isTelemetryEnabled()).toBe(false);
  });
});

describe("getTelemetrySnapshot", () => {
  it("returns the persisted state with the authoritative effective value", () => {
    writeTelemetryState({
      enabled: true,
      installId: "existing-install-id",
      firstRunAt: "2026-01-01T00:00:00.000Z",
    });
    process.env["DO_NOT_TRACK"] = "1";

    expect(getTelemetrySnapshot()).toEqual({
      state: {
        enabled: true,
        installId: "existing-install-id",
        firstRunAt: "2026-01-01T00:00:00.000Z",
      },
      environmentDisabled: true,
      enabled: false,
    });
  });
});

// Typed application facade

describe("typed telemetry facade", () => {
  const INSTALL_ID = "123e4567-e89b-42d3-a456-426614174000";
  const DIAGNOSTIC_ID = "123e4567-e89b-42d3-a456-426614174001";

  function snapshot(enabled = true) {
    return {
      state: {
        enabled,
        installId: INSTALL_ID,
        firstRunAt: "2026-08-11T12:00:00.000Z",
      },
      environmentDisabled: false,
      enabled,
    };
  }

  it("exposes named operations without a generic event or property escape hatch", async () => {
    const { createTelemetryFacade } = await import("../telemetry/facade.js");
    const facade = createTelemetryFacade({
      getSnapshot: () => snapshot(false),
      claimFirstStart: () => undefined,
    });

    expect(Object.keys(facade).sort()).toEqual([
      "annotateActiveSpan",
      "flushTelemetryWithin",
      "recordApplicationStart",
      "recordExpectedSetupFailure",
      "recordProxyStarted",
      "recordSafeLog",
      "recordSetupResult",
      "recordSetupStage",
      "recordUnexpectedException",
      "shutdownTelemetryWithin",
      "startProxyHeartbeat",
    ]);
    expect(facade).not.toHaveProperty("trackEvent");
    expect(facade).not.toHaveProperty("capture");
    expect(facade).not.toHaveProperty("telemetryDisabled");
  });

  it("makes every disabled capture a synchronous no-op", async () => {
    const { createTelemetryFacade } = await import("../telemetry/facade.js");
    let dependencyCalls = 0;
    const facade = createTelemetryFacade({
      getSnapshot: () => snapshot(false),
      claimFirstStart: () => undefined,
      getAnalytics: () => {
        dependencyCalls += 1;
        throw new Error("must not initialize");
      },
      emitLog: () => { dependencyCalls += 1; },
      annotateSpan: () => { dependencyCalls += 1; },
      setInterval: () => {
        dependencyCalls += 1;
        throw new Error("must not schedule");
      },
    });

    expect(facade.recordApplicationStart()).toBeUndefined();
    expect(facade.recordProxyStarted(4)).toBeUndefined();
    expect(facade.startProxyHeartbeat(4)).toBeUndefined();
    expect(facade.recordSafeLog({
      operation: "proxy.request",
      reason: "network_failure",
      severity: "warn",
    })).toBeUndefined();
    expect(facade.recordSetupStage({
      provider: "openai",
      method: "device_oauth",
      stage: "token_exchange",
      diagnosticId: DIAGNOSTIC_ID,
    })).toBeUndefined();
    expect(facade.recordSetupResult({
      provider: "openai",
      method: "device_oauth",
      result: "succeeded",
      diagnosticId: DIAGNOSTIC_ID,
    })).toBeUndefined();
    expect(facade.recordExpectedSetupFailure({
      provider: "openai",
      method: "device_oauth",
      stage: "token_exchange",
      reason: "unauthorized",
      diagnosticId: DIAGNOSTIC_ID,
    })).toBeUndefined();
    expect(facade.recordUnexpectedException(new Error("private"), {
      category: "runtime",
      reason: "other",
    })).toBeUndefined();
    expect(facade.annotateActiveSpan("proxy.request", { provider: "openai" })).toBeUndefined();
    expect(dependencyCalls).toBe(0);
  });

  it("emits first start once only when this process created fresh state", async () => {
    const { createTelemetryFacade } = await import("../telemetry/facade.js");
    const events: Array<{ event: string; properties: object }> = [];
    let claim: ReturnType<typeof snapshot> | undefined = snapshot();
    const analytics = {
      captureAnalytics: (event: { event: string; properties: object }) => { events.push(event); },
      captureAnalyticsImmediate: async (event: { event: string; properties: object }) => { events.push(event); },
      captureException: () => undefined,
      captureExceptionImmediate: async () => undefined,
      flushWithin: async () => undefined,
      shutdownWithin: async () => undefined,
      discardPending: () => undefined,
    };
    const facade = createTelemetryFacade({
      getSnapshot: () => snapshot(),
      claimFirstStart: () => {
        const claimed = claim;
        claim = undefined;
        return claimed;
      },
      runtimeMetadata: () => ({
        serviceVersion: "0.8.2",
        osFamily: "linux",
        runtimeMode: "foreground",
      }),
      getAnalytics: () => analytics,
    });

    facade.recordApplicationStart();
    facade.recordApplicationStart();

    expect(events).toEqual([{
      event: "app.first_start",
      properties: {
        serviceVersion: "0.8.2",
        osFamily: "linux",
        runtimeMode: "foreground",
      },
      distinctId: INSTALL_ID,
      processPersonProfile: false,
      disableGeoip: true,
    }]);

    const nonCreatorEvents: unknown[] = [];
    createTelemetryFacade({
      getSnapshot: () => snapshot(),
      claimFirstStart: () => undefined,
      getAnalytics: () => ({
        ...analytics,
        captureAnalyticsImmediate: async event => { nonCreatorEvents.push(event); },
      }),
    }).recordApplicationStart();
    expect(nonCreatorEvents).toEqual([]);
  });

  it("loads state before claiming first start on a non-proxy CLI invocation", async () => {
    const { createTelemetryFacade } = await import("../telemetry/facade.js");
    let stateLoaded = false;
    const events: string[] = [];
    const facade = createTelemetryFacade({
      getSnapshot: () => {
        stateLoaded = true;
        return snapshot();
      },
      claimFirstStart: () => stateLoaded ? snapshot() : undefined,
      getAnalytics: () => ({
        captureAnalytics: event => { events.push(event.event); },
        captureAnalyticsImmediate: async event => { events.push(event.event); },
        captureException: () => undefined,
        captureExceptionImmediate: async () => undefined,
        flushWithin: async () => undefined,
        shutdownWithin: async () => undefined,
        discardPending: () => undefined,
      }),
    });

    facade.recordApplicationStart();

    expect(events).toEqual(["app.first_start"]);
  });

  it("emits closed proxy lifecycle payloads, clamps account count, and unreferences heartbeat", async () => {
    const { createTelemetryFacade } = await import("../telemetry/facade.js");
    const events: Array<{ event: string; properties: object }> = [];
    let heartbeat: (() => void) | undefined;
    let intervalMs = 0;
    let unrefs = 0;
    const facade = createTelemetryFacade({
      getSnapshot: () => snapshot(),
      claimFirstStart: () => undefined,
      runtimeMetadata: () => ({
        serviceVersion: "0.8.2",
        osFamily: "macos",
        runtimeMode: "daemon",
      }),
      getAnalytics: () => ({
        captureAnalytics: event => { events.push(event); },
        captureAnalyticsImmediate: async event => { events.push(event); },
        captureException: () => undefined,
        captureExceptionImmediate: async () => undefined,
        flushWithin: async () => undefined,
        shutdownWithin: async () => undefined,
        discardPending: () => undefined,
      }),
      setInterval: (callback, delay) => {
        heartbeat = callback;
        intervalMs = delay;
        return { unref: () => { unrefs += 1; } };
      },
    });

    facade.recordProxyStarted(50_000);
    facade.startProxyHeartbeat(-20);
    heartbeat?.();

    expect(intervalMs).toBe(60 * 60 * 1_000);
    expect(unrefs).toBe(1);
    expect(events.map(event => event.event)).toEqual(["proxy.started", "proxy.heartbeat"]);
    expect(events.map(event => event.properties)).toEqual([
      {
        serviceVersion: "0.8.2",
        osFamily: "macos",
        runtimeMode: "daemon",
        accountPoolSize: 10_000,
      },
      {
        serviceVersion: "0.8.2",
        osFamily: "macos",
        runtimeMode: "daemon",
        accountPoolSize: 0,
      },
    ]);
  });

  it("routes safe logs, setup outcomes, sanitized exceptions, and span annotations through closed dependencies", async () => {
    const { createTelemetryFacade } = await import("../telemetry/facade.js");
    const events: Array<{ event: string }> = [];
    const logs: Array<{ body: string; attributes: object }> = [];
    const exceptions: Array<{ reason: string; diagnosticId: string }> = [];
    const annotations: Array<{ operation: string; attributes: object }> = [];
    const facade = createTelemetryFacade({
      getSnapshot: () => snapshot(),
      claimFirstStart: () => undefined,
      now: () => 1_800_000_000_000,
      randomUUID: () => DIAGNOSTIC_ID,
      runtimeMetadata: () => ({
        serviceVersion: "0.8.2",
        osFamily: "linux",
        runtimeMode: "service",
      }),
      getAnalytics: () => ({
        captureAnalytics: event => { events.push(event); },
        captureAnalyticsImmediate: async event => { events.push(event); },
        captureException: exception => {
          exceptions.push({ reason: exception.reason, diagnosticId: exception.diagnosticId });
        },
        captureExceptionImmediate: async exception => {
          exceptions.push({ reason: exception.reason, diagnosticId: exception.diagnosticId });
        },
        flushWithin: async () => undefined,
        shutdownWithin: async () => undefined,
        discardPending: () => undefined,
      }),
      emitLog: log => { logs.push(log); },
      annotateSpan: (operation, attributes) => { annotations.push({ operation, attributes }); },
      sanitizeException: (_error, context, identity) => ({
        error: new Error(context.reason),
        category: context.category,
        reason: context.reason,
        errorKind: "unexpected_error",
        frames: [],
        fingerprint: "a".repeat(64) as never,
        diagnosticId: identity.diagnosticId as never,
      }),
    });

    facade.recordSafeLog({
      operation: "provider.inference",
      provider: "openai",
      reason: "rate_limited",
      severity: "warn",
      httpStatusCode: 429,
    });
    facade.recordSetupStage({
      provider: "openai",
      method: "device_oauth",
      stage: "token_exchange",
      diagnosticId: DIAGNOSTIC_ID,
    });
    facade.recordSetupResult({
      provider: "openai",
      method: "device_oauth",
      result: "cancelled",
      diagnosticId: DIAGNOSTIC_ID,
    });
    facade.recordExpectedSetupFailure({
      provider: "openai",
      method: "device_oauth",
      stage: "token_validation",
      reason: "unauthorized",
      diagnosticId: DIAGNOSTIC_ID,
      httpStatusCode: 401,
    });
    expect(facade.recordUnexpectedException(new Error("private"), {
      category: "runtime",
      reason: "other",
      operation: "proxy.request",
    })).toBe(DIAGNOSTIC_ID);
    facade.annotateActiveSpan("provider.inference", {
      provider: "openai",
      httpStatusCode: 429,
      accountPoolSize: 2,
    });

    expect(events.map(event => event.event)).toEqual([
      "account_setup.stage_completed",
      "account_setup.cancelled",
      "account_setup.failed",
    ]);
    expect(logs.map(log => ({ body: log.body, attributes: log.attributes }))).toEqual([
      {
        body: "runtime.failure",
        attributes: expect.objectContaining({
          operation: "provider.inference",
          provider: "openai",
          reason: "rate_limited",
          httpStatusCode: 429,
        }),
      },
      {
        body: "account.setup.diagnostic",
        attributes: expect.objectContaining({
          provider: "openai",
          method: "device_oauth",
          stage: "token_exchange",
          diagnosticId: DIAGNOSTIC_ID,
        }),
      },
      {
        body: "account.setup.diagnostic",
        attributes: expect.objectContaining({
          stage: "cancellation",
          reason: "user_cancelled",
          outcome: "cancelled",
        }),
      },
      {
        body: "account.setup.diagnostic",
        attributes: expect.objectContaining({
          stage: "token_validation",
          reason: "unauthorized",
          httpStatusCode: 401,
        }),
      },
    ]);
    expect(exceptions).toEqual([{ reason: "other", diagnosticId: DIAGNOSTIC_ID }]);
    expect(annotations).toEqual([{
      operation: "provider.inference",
      attributes: {
        provider: "openai",
        httpStatusCode: 429,
        accountPoolSize: 2,
      },
    }]);
  });

  it("contains synchronous and asynchronous dependency failures", async () => {
    const { createTelemetryFacade } = await import("../telemetry/facade.js");
    const brokenClient = {
      captureAnalytics: () => { throw new Error("capture"); },
      captureAnalyticsImmediate: async () => { throw new Error("capture immediate"); },
      captureException: () => { throw new Error("exception"); },
      captureExceptionImmediate: async () => { throw new Error("exception immediate"); },
      flushWithin: async () => { throw new Error("flush"); },
      shutdownWithin: async () => { throw new Error("shutdown"); },
      discardPending: () => { throw new Error("discard"); },
    };
    const facade = createTelemetryFacade({
      getSnapshot: () => snapshot(),
      claimFirstStart: () => snapshot(),
      getAnalytics: () => brokenClient,
      emitLog: () => { throw new Error("log"); },
      annotateSpan: () => { throw new Error("span"); },
      flushRuntime: async () => { throw new Error("runtime flush"); },
      shutdownRuntime: async () => { throw new Error("runtime shutdown"); },
      randomUUID: () => DIAGNOSTIC_ID,
    });

    expect(() => facade.recordApplicationStart()).not.toThrow();
    expect(() => facade.recordProxyStarted(1)).not.toThrow();
    expect(() => facade.recordSafeLog({
      operation: "proxy.request",
      reason: "other",
      severity: "error",
    })).not.toThrow();
    expect(() => facade.recordUnexpectedException(new Error("private"), {
      category: "runtime",
      reason: "other",
    })).not.toThrow();
    expect(() => facade.annotateActiveSpan("proxy.request", {})).not.toThrow();
    await expect(facade.flushTelemetryWithin(20)).resolves.toBeUndefined();
    await expect(facade.shutdownTelemetryWithin(20)).resolves.toBeUndefined();
  });

  it("rejects a non-random diagnostic identity at the facade boundary", async () => {
    const { createTelemetryFacade } = await import("../telemetry/facade.js");
    let sanitizerCalls = 0;
    const facade = createTelemetryFacade({
      getSnapshot: () => snapshot(),
      claimFirstStart: () => undefined,
      randomUUID: () => "account-id-from-upstream",
      sanitizeException: () => {
        sanitizerCalls += 1;
        return undefined;
      },
    });

    expect(facade.recordUnexpectedException(new Error("private"), {
      category: "runtime",
      reason: "other",
    })).toBeUndefined();
    expect(sanitizerCalls).toBe(0);
  });

  it("discards both analytics and runtime queues when flush observes opt-out", async () => {
    const { createTelemetryFacade } = await import("../telemetry/facade.js");
    let enabled = true;
    let discards = 0;
    let runtimeFlushes = 0;
    const facade = createTelemetryFacade({
      getSnapshot: () => snapshot(enabled),
      claimFirstStart: () => undefined,
      getAnalytics: () => ({
        captureAnalytics: () => undefined,
        captureAnalyticsImmediate: async () => undefined,
        captureException: () => undefined,
        captureExceptionImmediate: async () => undefined,
        flushWithin: async () => undefined,
        shutdownWithin: async () => undefined,
        discardPending: () => { discards += 1; },
      }),
      flushRuntime: async () => { runtimeFlushes += 1; },
    });
    facade.recordProxyStarted(1);
    enabled = false;

    await facade.flushTelemetryWithin(20);

    expect(discards).toBe(1);
    expect(runtimeFlushes).toBe(1);
  });

  it("drops an invalid runtime setup result without touching recorders or the client", async () => {
    const { createTelemetryFacade } = await import("../telemetry/facade.js");
    let analyticsCalls = 0;
    let logCalls = 0;
    const facade = createTelemetryFacade({
      getSnapshot: () => snapshot(),
      claimFirstStart: () => undefined,
      getAnalytics: () => {
        analyticsCalls += 1;
        throw new Error("invalid result must not initialize analytics");
      },
      emitLog: () => { logCalls += 1; },
    });

    facade.recordSetupResult({
      provider: "openai",
      method: "device_oauth",
      result: "bogus",
      diagnosticId: DIAGNOSTIC_ID,
    } as never);

    expect(analyticsCalls).toBe(0);
    expect(logCalls).toBe(0);
  });

  it.each([
    ["not_found", undefined],
    ["permission_denied", undefined],
    ["malformed_credentials", undefined],
    ["invalid_token", undefined],
    ["unauthorized", "upstream_error"],
    ["forbidden", "upstream_error"],
    ["rate_limited", "rate_limited"],
    ["upstream_4xx", "upstream_error"],
    ["upstream_5xx", "upstream_error"],
    ["timeout", "timeout"],
    ["network_failure", undefined],
    ["unexpected_response_shape", "upstream_error"],
    ["persistence_failure", undefined],
    ["user_cancelled", "cancelled"],
    ["other", "other"],
  ] as const)("maps expected setup reason %s to truthful outcome %s", async (reason, expectedOutcome) => {
    const { createTelemetryFacade } = await import("../telemetry/facade.js");
    const events: Array<{ properties: Record<string, unknown> }> = [];
    const recordedLogs: Array<{ attributes: Record<string, unknown> }> = [];
    const facade = createTelemetryFacade({
      getSnapshot: () => snapshot(),
      claimFirstStart: () => undefined,
      getAnalytics: () => ({
        captureAnalytics: event => { events.push(event); },
        captureAnalyticsImmediate: async event => { events.push(event); },
        captureException: () => undefined,
        captureExceptionImmediate: async () => undefined,
        flushWithin: async () => undefined,
        shutdownWithin: async () => undefined,
        discardPending: () => undefined,
      }),
      emitLog: log => { recordedLogs.push(log); },
    });

    facade.recordExpectedSetupFailure({
      provider: "anthropic",
      method: "manual_token",
      stage: "token_validation",
      reason,
      diagnosticId: DIAGNOSTIC_ID,
    });

    expect(events).toHaveLength(1);
    expect(recordedLogs).toHaveLength(1);
    expect(events[0].properties).not.toHaveProperty("outcome");
    if (expectedOutcome === undefined) {
      expect(recordedLogs[0].attributes).not.toHaveProperty("outcome");
    } else {
      expect(recordedLogs[0].attributes.outcome).toBe(expectedOutcome);
    }
  });
});
