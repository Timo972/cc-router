import { describe, expect, it } from "vitest";
import {
  reconstructAnalyticsEvent,
  reconstructLog,
  reconstructResource,
  reconstructSpan,
} from "../telemetry/privacy.js";

const INSTALL_ID = "70d8062e-1fa0-4ae4-a115-bf782ecca462";
const DIAGNOSTIC_ID = "ad94f035-1e08-4e29-8517-fd56bdc83d99";
const ACCOUNT_UUID = "57b50aa2-fb24-40af-965b-cd5f2e506cdc";
const SESSION_UUID = "916ce1d6-2e8d-48b2-a70e-0337bdf82df7";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "0123456789abcdef";
const PARENT_SPAN_ID = "fedcba9876543210";
const trustedIdentity = {
  installationId: INSTALL_ID,
  diagnosticId: DIAGNOSTIC_ID,
};

const validResource = {
  serviceName: "cc-router",
  serviceVersion: "0.8.2",
  nodeVersion: "22.18.0",
  osFamily: "macos",
  cpuArchitecture: "arm64",
  runtimeMode: "daemon",
  serviceInstanceId: ACCOUNT_UUID,
};

const validSpan = {
  scope: "cc-router",
  operation: "proxy.request",
  traceId: TRACE_ID,
  spanId: SPAN_ID,
  parentSpanId: PARENT_SPAN_ID,
  kind: "server",
  startTimeMs: 1_800_000_000_000,
  durationMs: 1_250,
  statusCode: "ok",
  statusDescription: "PRIVATE_CANARY",
  attributes: {
    httpMethod: "POST",
    httpStatusCode: 200,
    provider: "anthropic",
    route: "messages",
    modelFamily: "sonnet",
    requestSource: "cli",
    runtimeMode: "daemon",
    streaming: true,
    streamOutcome: "complete",
    outcome: "complete",
    attempt: 2,
    accountPoolSize: 3,
    concurrency: 1,
    inputTokens: 100,
    outputTokens: 20,
    operationDurationMs: 1_200,
  },
};

const validLog = {
  scope: "cc-router",
  body: "account.setup.diagnostic",
  severity: "warn",
  timestampMs: 1_800_000_000_000,
  traceId: TRACE_ID,
  spanId: SPAN_ID,
  attributes: {
    provider: "openai",
    method: "device_oauth",
    stage: "token_exchange",
    reason: "unauthorized",
    outcome: "upstream_error",
    httpStatusCode: 401,
    durationBucket: "5s_to_30s",
    serviceVersion: "0.8.2",
    osFamily: "macos",
    runtimeMode: "foreground",
    diagnosticId: ACCOUNT_UUID,
  },
};

const validEvent = {
  event: "account_setup.failed",
  distinctId: SESSION_UUID,
  properties: {
    provider: "openai",
    method: "device_oauth",
    stage: "token_exchange",
    reason: "unauthorized",
    durationBucket: "5s_to_30s",
    serviceVersion: "0.8.2",
    osFamily: "macos",
    runtimeMode: "foreground",
    diagnosticId: SESSION_UUID,
  },
};

describe("closed telemetry reconstruction", () => {
  it("reconstructs only the approved resource attributes", () => {
    const result = reconstructResource(validResource, trustedIdentity);

    expect(result).toEqual({
      "service.name": "cc-router",
      "service.version": "0.8.2",
      "service.instance.id": INSTALL_ID,
      "process.runtime.version": "22.18.0",
      "os.type": "macos",
      "host.arch": "arm64",
      "cc_router.runtime_mode": "daemon",
    });
    expect(result).not.toBe(validResource);
  });

  it("replaces the span name and reconstructs a closed waterfall record", () => {
    const result = reconstructSpan(validSpan);

    expect(result).toEqual({
      scope: "cc-router",
      name: "proxy.request",
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      parentSpanId: PARENT_SPAN_ID,
      kind: "server",
      startTimeMs: 1_800_000_000_000,
      durationMs: 1_250,
      statusCode: "ok",
      attributes: {
        httpMethod: "POST",
        httpStatusCode: 200,
        provider: "anthropic",
        route: "messages",
        modelFamily: "sonnet",
        requestSource: "cli",
        runtimeMode: "daemon",
        streaming: true,
        streamOutcome: "complete",
        outcome: "complete",
        attempt: 2,
        accountPoolSize: 3,
        concurrency: 1,
        inputTokens: 100,
        outputTokens: 20,
        operationDurationMs: 1_200,
      },
    });
    expect(result).not.toBe(validSpan);
    expect(result?.attributes).not.toBe(validSpan.attributes);
  });

  it("reconstructs a fixed-code setup diagnostic log", () => {
    const result = reconstructLog(validLog, trustedIdentity);

    expect(result).toEqual({
      scope: "cc-router",
      body: "account.setup.diagnostic",
      severity: "warn",
      timestampMs: 1_800_000_000_000,
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      attributes: {
        provider: "openai",
        method: "device_oauth",
        stage: "token_exchange",
        reason: "unauthorized",
        outcome: "upstream_error",
        httpStatusCode: 401,
        durationBucket: "5s_to_30s",
        serviceVersion: "0.8.2",
        osFamily: "macos",
        runtimeMode: "foreground",
        diagnosticId: DIAGNOSTIC_ID,
      },
    });
    expect(result).not.toBe(validLog);
    expect(result?.attributes).not.toBe(validLog.attributes);
  });

  it("reconstructs a typed analytics event with privacy flags forced on", () => {
    const result = reconstructAnalyticsEvent(validEvent, trustedIdentity);

    expect(result).toEqual({
      event: "account_setup.failed",
      distinctId: INSTALL_ID,
      processPersonProfile: false,
      disableGeoip: true,
      properties: {
        provider: "openai",
        method: "device_oauth",
        stage: "token_exchange",
        reason: "unauthorized",
        durationBucket: "5s_to_30s",
        serviceVersion: "0.8.2",
        osFamily: "macos",
        runtimeMode: "foreground",
        diagnosticId: DIAGNOSTIC_ID,
      },
    });
    expect(result).not.toBe(validEvent);
    expect(result?.properties).not.toBe(validEvent.properties);
  });
});

describe("closed allowlists", () => {
  it.each([
    ["resource", () => reconstructResource({ ...validResource, runtimeMode: "cron" }, trustedIdentity)],
    ["span scope", () => reconstructSpan({ ...validSpan, scope: "unknown-library" })],
    ["span operation", () => reconstructSpan({ ...validSpan, operation: "/v1/messages/private" })],
    ["log code", () => reconstructLog({ ...validLog, body: "user.supplied.message" }, trustedIdentity)],
    ["event name", () => reconstructAnalyticsEvent({ ...validEvent, event: "telemetry_disabled" }, trustedIdentity)],
  ])("drops a record with an unknown fixed %s", (_name, reconstruct) => {
    expect(reconstruct()).toBeUndefined();
  });

  it("normalizes unknown non-identity attribute enums without discarding the failure", () => {
    const span = reconstructSpan({
      ...validSpan,
      attributes: {
        ...validSpan.attributes,
        provider: "private-provider",
        route: "/private/route",
        modelFamily: "private-model-name",
        requestSource: "private-client",
        outcome: "never-seen-before",
        streamOutcome: "strange-terminal-state",
      },
    });
    const log = reconstructLog({
      ...validLog,
      attributes: {
        ...validLog.attributes,
        reason: "private raw failure",
        outcome: "never-seen-before",
      },
    }, trustedIdentity);
    const event = reconstructAnalyticsEvent({
      ...validEvent,
      properties: { ...validEvent.properties, reason: "private raw failure" },
    }, trustedIdentity);

    expect(span?.attributes).toEqual(expect.objectContaining({
      provider: "other",
      route: "other",
      modelFamily: "other",
      requestSource: "other",
      outcome: "other",
      streamOutcome: "other",
    }));
    expect(log?.attributes).toEqual(expect.objectContaining({ reason: "other", outcome: "other" }));
    expect(event?.properties).toEqual(expect.objectContaining({ reason: "other" }));
  });

  it("keeps setup provider and credential method combinations closed", () => {
    expect(reconstructLog({
      ...validLog,
      attributes: { ...validLog.attributes, provider: "anthropic", method: "device_oauth" },
    }, trustedIdentity)).toBeUndefined();
    expect(reconstructAnalyticsEvent({
      ...validEvent,
      properties: { ...validEvent.properties, provider: "openai", method: "macos_keychain" },
    }, trustedIdentity)).toBeUndefined();
  });

  it("drops logs with missing or unknown instrumentation scopes", () => {
    const { scope: _scope, ...withoutScope } = validLog;

    expect(reconstructLog(withoutScope, trustedIdentity)).toBeUndefined();
    expect(reconstructLog({ ...validLog, scope: "unknown-library" }, trustedIdentity)).toBeUndefined();
  });
});

describe("bounded primitives and identifiers", () => {
  it("drops records with invalid required identifiers, strings, timestamps, or durations", () => {
    expect(reconstructResource({ ...validResource, serviceVersion: "x".repeat(200) }, trustedIdentity)).toBeUndefined();
    expect(reconstructResource(validResource, { installationId: "not-a-uuid" })).toBeUndefined();
    expect(reconstructSpan({ ...validSpan, traceId: "not-a-trace-id" })).toBeUndefined();
    expect(reconstructSpan({ ...validSpan, durationMs: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(reconstructLog({ ...validLog, timestampMs: -1 }, trustedIdentity)).toBeUndefined();
    expect(reconstructAnalyticsEvent(validEvent, { installationId: "not-a-uuid" })).toBeUndefined();
  });

  it("omits invalid optional identifiers and unbounded numeric attributes", () => {
    const result = reconstructSpan({
      ...validSpan,
      parentSpanId: "/Users/private/parent",
      attributes: {
        ...validSpan.attributes,
        attempt: -1,
        accountPoolSize: Number.MAX_VALUE,
        concurrency: { nested: true },
        inputTokens: [123],
        outputTokens: Number.POSITIVE_INFINITY,
        operationDurationMs: 100_000_000_000,
      },
    });

    expect(result).toBeDefined();
    expect(result).not.toHaveProperty("parentSpanId");
    expect(result?.attributes).not.toHaveProperty("attempt");
    expect(result?.attributes).not.toHaveProperty("accountPoolSize");
    expect(result?.attributes).not.toHaveProperty("concurrency");
    expect(result?.attributes).not.toHaveProperty("inputTokens");
    expect(result?.attributes).not.toHaveProperty("outputTokens");
    expect(result?.attributes).not.toHaveProperty("operationDurationMs");
  });

  it("normalizes valid uppercase trace identifiers without retaining their input strings", () => {
    const result = reconstructSpan({
      ...validSpan,
      traceId: TRACE_ID.toUpperCase(),
      spanId: SPAN_ID.toUpperCase(),
    });

    expect(result?.traceId).toBe(TRACE_ID);
    expect(result?.spanId).toBe(SPAN_ID);
  });
});

describe("reconstruction is the privacy boundary", () => {
  const rawAccountId = "acct-private-canary-123";
  const sha256AccountId = "802f647e793b992381f66f85b4f8ae12e588b30a23e504d4a539d04f70e40ee8";
  const sha1AccountId = "3749230551b38c1e57c4554cd54f9328625bd1aa";
  const base64AccountId = "YWNjdC1wcml2YXRlLWNhbmFyeS0xMjM=";
  const hostile = {
    accountId: rawAccountId,
    account_id_hash: sha256AccountId,
    fingerprint: sha1AccountId,
    encodedIdentity: base64AccountId,
    rawBody: "PRIVATE_CANARY request body",
    headers: { authorization: "PRIVATE_CANARY bearer" },
    url: "https://PRIVATE_CANARY.example/private?q=secret",
    queryString: "PRIVATE_CANARY=true",
    credentials: { token: "PRIVATE_CANARY" },
    oauthPayload: { device_code: "PRIVATE_CANARY" },
    sessionId: "PRIVATE_CANARY",
    hostname: "PRIVATE_CANARY.internal",
    absolutePath: "/Users/private/PRIVATE_CANARY.txt",
    message: "PRIVATE_CANARY raw error",
    nested: { PRIVATE_CANARY: true },
    array: ["PRIVATE_CANARY"],
    extraNumber: Number.POSITIVE_INFINITY,
    overlong: `PRIVATE_CANARY${"x".repeat(1_000)}`,
  };

  it.each([
    ["UUID-shaped account ID", ACCOUNT_UUID],
    ["UUID-shaped session ID", SESSION_UUID],
    ["raw account ID", rawAccountId],
    ["SHA-256 account digest", sha256AccountId],
    ["SHA-1 account digest", sha1AccountId],
    ["base64 account encoding", base64AccountId],
  ])("uses trusted installation identity instead of candidate %s", (_name, candidateIdentity) => {
    const resource = reconstructResource({
      ...validResource,
      serviceInstanceId: candidateIdentity,
      distinctId: candidateIdentity,
      installationId: candidateIdentity,
    }, trustedIdentity);
    const event = reconstructAnalyticsEvent({
      ...validEvent,
      distinctId: candidateIdentity,
      serviceInstanceId: candidateIdentity,
      installationId: candidateIdentity,
    }, trustedIdentity);

    expect(resource?.["service.instance.id"]).toBe(INSTALL_ID);
    expect(event?.distinctId).toBe(INSTALL_ID);
    expect(JSON.stringify({ resource, event })).not.toContain(candidateIdentity);
  });

  it("uses only the trusted per-attempt diagnostic ID and keeps it distinct from installation identity", () => {
    const log = reconstructLog({
      ...validLog,
      diagnosticId: ACCOUNT_UUID,
      attributes: { ...validLog.attributes, diagnosticId: ACCOUNT_UUID },
    }, trustedIdentity);
    const event = reconstructAnalyticsEvent({
      ...validEvent,
      diagnosticId: SESSION_UUID,
      properties: { ...validEvent.properties, diagnosticId: SESSION_UUID },
    }, trustedIdentity);

    expect(log?.attributes.diagnosticId).toBe(DIAGNOSTIC_ID);
    expect(event?.properties).toEqual(expect.objectContaining({ diagnosticId: DIAGNOSTIC_ID }));
    expect(JSON.stringify({ log, event })).not.toContain(ACCOUNT_UUID);
    expect(JSON.stringify({ log, event })).not.toContain(SESSION_UUID);

    const reusedStableIdentity = { installationId: INSTALL_ID, diagnosticId: INSTALL_ID };
    expect(reconstructLog(validLog, reusedStableIdentity)).toBeUndefined();
    expect(reconstructAnalyticsEvent(validEvent, reusedStableIdentity)).toBeUndefined();
  });

  it.each([
    ["resource", () => reconstructResource({ ...validResource, ...hostile }, trustedIdentity)],
    ["span", () => reconstructSpan({
      ...validSpan,
      ...hostile,
      attributes: { ...validSpan.attributes, ...hostile },
      resource: hostile,
      events: [hostile],
      links: [hostile],
    })],
    ["log", () => reconstructLog({
      ...validLog,
      ...hostile,
      attributes: { ...validLog.attributes, ...hostile },
    }, trustedIdentity)],
    ["event", () => reconstructAnalyticsEvent({
      ...validEvent,
      ...hostile,
      properties: { ...validEvent.properties, ...hostile },
    }, trustedIdentity)],
  ])("does not serialize raw or reconstructable identity and canary fields from %s", (_name, reconstruct) => {
    const result = reconstruct();
    const serialized = JSON.stringify(result);

    expect(result).toBeDefined();
    expect(serialized).not.toContain("PRIVATE_CANARY");
    expect(serialized).not.toContain(rawAccountId);
    expect(serialized).not.toContain(sha256AccountId);
    expect(serialized).not.toContain(sha1AccountId);
    expect(serialized).not.toContain(base64AccountId);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("/Users/");
  });

  it.each([
    ["resource", validResource, (input: unknown) => reconstructResource(input, trustedIdentity)],
    ["span", validSpan, reconstructSpan],
    ["log", validLog, (input: unknown) => reconstructLog(input, trustedIdentity)],
    ["event", validEvent, (input: unknown) => reconstructAnalyticsEvent(input, trustedIdentity)],
  ] as const)("never mutates the %s input", (_name, input, reconstruct) => {
    const snapshot = structuredClone(input);

    reconstruct(input);

    expect(input).toEqual(snapshot);
  });
});
