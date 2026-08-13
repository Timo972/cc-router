import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelemetryFacade } from "../telemetry/facade.js";
import {
  SetupDiagnosticError,
  classifyAccountStateReadFailure,
  classifyHttpSetupFailure,
  classifyNetworkSetupFailure,
  createSetupAttempt,
  persistSetupAttempts,
  withSetupTelemetryFlush,
  type SetupDiagnosticRecorder,
} from "../telemetry/setup-diagnostics.js";
import { validateToken } from "../utils/token-validator.js";

const INSTALL_ID = "11111111-1111-4111-8111-111111111111";
const DIAGNOSTIC_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async input => {
    const url = input instanceof Request ? input.url : String(input);
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (!hostname.startsWith("127.") && hostname !== "::1") {
      throw new Error(`Task 9 test blocked non-loopback fetch: ${hostname}`);
    }
    throw new Error("Task 9 test requires an injected loopback transport");
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function recorder() {
  const stages: unknown[] = [];
  const stageFailures: unknown[] = [];
  const results: unknown[] = [];
  const failures: unknown[] = [];
  const exceptions: Array<{ error: unknown; context: unknown; diagnosticId?: string }> = [];
  const value: SetupDiagnosticRecorder = {
    recordSetupStage: input => { stages.push(input); },
    recordSetupStageFailure: input => { stageFailures.push(input); },
    recordSetupResult: input => { results.push(input); },
    recordExpectedSetupFailure: input => { failures.push(input); },
    recordUnexpectedException: (error, context, diagnosticId) => {
      exceptions.push({ error, context, diagnosticId });
      return diagnosticId as never;
    },
    flushTelemetryWithin: async () => undefined,
  };
  return { value, stages, stageFailures, results, failures, exceptions };
}

describe("setup diagnostic stage matrix", () => {
  it.each([
    ["anthropic", "macos_keychain", ["credential_read", "credential_parse", "token_validation", "persistence"]],
    ["anthropic", "claude_credentials_file", ["credential_read", "credential_parse", "token_validation", "persistence"]],
    ["anthropic", "manual_token", ["credential_read", "credential_parse", "token_validation", "persistence"]],
    ["openai", "manual_token", ["credential_read", "credential_parse", "persistence"]],
    ["openai", "device_oauth", ["device_code_request", "authorization_polling", "token_exchange", "access_token_parse", "persistence"]],
  ] as const)("records the complete %s/%s success path", (provider, method, completedStages) => {
    const recorded = recorder();
    const attempt = createSetupAttempt({
      provider,
      method,
      recorder: recorded.value,
      randomUUID: () => DIAGNOSTIC_ID,
      now: () => 1_000,
    });

    attempt.stageCompleted("credential_source_selection");
    for (const stage of completedStages) attempt.stageCompleted(stage);
    attempt.succeeded();

    expect(recorded.stages).toEqual([
      expect.objectContaining({ provider, method, stage: "attempt_start", diagnosticId: DIAGNOSTIC_ID }),
      expect.objectContaining({ provider, method, stage: "credential_source_selection", diagnosticId: DIAGNOSTIC_ID }),
      ...completedStages.map(stage => expect.objectContaining({ provider, method, stage, diagnosticId: DIAGNOSTIC_ID })),
    ]);
    expect(recorded.results).toEqual([
      expect.objectContaining({ provider, method, result: "succeeded", diagnosticId: DIAGNOSTIC_ID }),
    ]);
    expect(recorded.failures).toEqual([]);
    expect(recorded.exceptions).toEqual([]);
  });

  it.each([
    ["credential_read", "not_found", undefined],
    ["credential_read", "permission_denied", undefined],
    ["credential_parse", "malformed_credentials", undefined],
    ["token_validation", "invalid_token", undefined],
    ["token_validation", "unauthorized", 401],
    ["token_validation", "forbidden", 403],
    ["token_validation", "rate_limited", 429],
    ["device_code_request", "upstream_4xx", 418],
    ["token_exchange", "upstream_5xx", 503],
    ["authorization_polling", "timeout", undefined],
    ["device_code_request", "network_failure", undefined],
    ["access_token_parse", "unexpected_response_shape", undefined],
  ] as const)("keeps known %s/%s failures out of Error Tracking", (stage, reason, httpStatusCode) => {
    const recorded = recorder();
    const attempt = createSetupAttempt({
      provider: "openai",
      method: "device_oauth",
      recorder: recorded.value,
      randomUUID: () => DIAGNOSTIC_ID,
      now: () => 1_000,
    });

    const error = new SetupDiagnosticError("local detail", {
      stage,
      reason,
      expected: true,
      ...(httpStatusCode === undefined ? {} : { httpStatusCode }),
    });
    const outcome = attempt.failed(error, stage);

    expect(outcome).toEqual({ diagnosticId: DIAGNOSTIC_ID, unexpected: false });
    expect(recorded.failures).toEqual([
      expect.objectContaining({
        stage,
        reason,
        diagnosticId: DIAGNOSTIC_ID,
        ...(httpStatusCode === undefined ? {} : { httpStatusCode }),
      }),
    ]);
    expect(recorded.exceptions).toEqual([]);
  });

  it("reuses one attempt ID across stages, the failure funnel, and the sanitized exception", () => {
    const recorded = recorder();
    const attempt = createSetupAttempt({
      provider: "anthropic",
      method: "claude_credentials_file",
      recorder: recorded.value,
      randomUUID: () => DIAGNOSTIC_ID,
      now: () => 1_000,
    });
    attempt.stageCompleted("credential_source_selection");

    const raw = new Error("prompt=PRIVATE account=user@example.com /Users/private/credentials");
    const outcome = attempt.failed(raw, "credential_parse");

    expect(outcome).toEqual({ diagnosticId: DIAGNOSTIC_ID, unexpected: true });
    expect(recorded.failures).toEqual([
      expect.objectContaining({
        stage: "credential_parse",
        reason: "other",
        diagnosticId: DIAGNOSTIC_ID,
      }),
    ]);
    expect(recorded.exceptions).toEqual([{
      error: raw,
      context: {
        category: "setup",
        provider: "anthropic",
        setupStage: "credential_parse",
        reason: "other",
      },
      diagnosticId: DIAGNOSTIC_ID,
    }]);
    expect(recorded.stages.every(value => (value as { diagnosticId: string }).diagnosticId === DIAGNOSTIC_ID)).toBe(true);
  });

  it("captures unexpected persistence faults with the attempt ID and preserves the local cause", async () => {
    const recorded = recorder();
    const attempt = createSetupAttempt({
      provider: "openai",
      method: "manual_token",
      recorder: recorded.value,
      randomUUID: () => DIAGNOSTIC_ID,
      now: () => 1_000,
    });
    const cause = new Error("PRIVATE /Users/local/.cc-router/accounts.json");

    const thrown = await persistSetupAttempts([attempt], () => { throw cause; }).catch(error => error);

    expect(thrown).toBeInstanceOf(SetupDiagnosticError);
    expect(thrown.message).toContain("PRIVATE");
    expect(thrown.cause).toBe(cause);
    expect(thrown.classification).toEqual({
      stage: "persistence",
      reason: "persistence_failure",
      expected: false,
    });
    expect(recorded.failures).toEqual([
      expect.objectContaining({
        stage: "persistence",
        reason: "persistence_failure",
        diagnosticId: DIAGNOSTIC_ID,
      }),
    ]);
    expect(recorded.exceptions).toEqual([
      expect.objectContaining({ error: cause, diagnosticId: DIAGNOSTIC_ID }),
    ]);
  });

  it("records explicit cancellation without creating an exception", () => {
    const recorded = recorder();
    const attempt = createSetupAttempt({
      provider: "anthropic",
      method: "manual_token",
      recorder: recorded.value,
      randomUUID: () => DIAGNOSTIC_ID,
      now: () => 1_000,
    });

    attempt.cancelled();

    expect(recorded.results).toEqual([
      expect.objectContaining({ result: "cancelled", diagnosticId: DIAGNOSTIC_ID }),
    ]);
    expect(recorded.exceptions).toEqual([]);
  });

  it.each([
    ["cancelled", "cancelled"],
    ["succeeded", "succeeded"],
    ["failed", "failed"],
  ] as const)("emits exactly one %s terminal and ignores every later terminal", (_label, terminal) => {
    const recorded = recorder();
    const attempt = createSetupAttempt({
      provider: "anthropic",
      method: "manual_token",
      recorder: recorded.value,
      randomUUID: () => DIAGNOSTIC_ID,
      now: () => 1_000,
    });
    const failure = new SetupDiagnosticError("PRIVATE invalid token", {
      stage: "token_validation",
      reason: "invalid_token",
      expected: true,
    });

    if (terminal === "cancelled") attempt.cancelled();
    else if (terminal === "succeeded") attempt.succeeded();
    else attempt.failed(failure, "token_validation");

    attempt.cancelled();
    attempt.succeeded();
    attempt.failed(failure, "token_validation");
    attempt.stageCompleted("persistence");

    expect(recorded.results).toHaveLength(terminal === "failed" ? 0 : 1);
    expect(recorded.failures).toHaveLength(terminal === "failed" ? 1 : 0);
    expect(recorded.results.length + recorded.failures.length).toBe(1);
    expect(recorded.stages).toHaveLength(1);
  });

  it("keeps a recoverable stage failure nonterminal until the attempt succeeds", () => {
    const recorded = recorder();
    const attempt = createSetupAttempt({
      provider: "anthropic",
      method: "manual_token",
      recorder: recorded.value,
      randomUUID: () => DIAGNOSTIC_ID,
      now: () => 1_000,
    });
    const failure = new SetupDiagnosticError("PRIVATE invalid token", {
      stage: "token_validation",
      reason: "invalid_token",
      expected: true,
    });

    attempt.stageFailed(failure, "token_validation");
    attempt.stageCompleted("persistence");
    attempt.succeeded();

    expect(recorded.stageFailures).toEqual([
      expect.objectContaining({
        stage: "token_validation",
        reason: "invalid_token",
        diagnosticId: DIAGNOSTIC_ID,
      }),
    ]);
    expect(recorded.failures).toEqual([]);
    expect(recorded.results).toEqual([
      expect.objectContaining({ result: "succeeded", diagnosticId: DIAGNOSTIC_ID }),
    ]);
  });
});

describe("typed failure classification", () => {
  it.each([
    ["malformed_json", "malformed_credentials"],
    ["invalid_shape", "malformed_credentials"],
    ["permission_denied", "permission_denied"],
    ["read_failure", "other"],
  ] as const)("classifies typed account-state %s failures without local detail", (kind, reason) => {
    const error = classifyAccountStateReadFailure({
      kind,
      message: "PRIVATE /Users/local/.cc-router/accounts.json",
    });

    expect(error.classification).toEqual({
      stage: "persistence",
      reason,
      expected: false,
    });
    expect(JSON.stringify(error.classification)).not.toContain("PRIVATE");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [418, "upstream_4xx"],
    [503, "upstream_5xx"],
  ] as const)("classifies HTTP %i without retaining a response body", (status, reason) => {
    const error = classifyHttpSetupFailure("token_exchange", status, "local raw body: PRIVATE");

    expect(error.message).toContain("PRIVATE");
    expect(error.classification).toEqual({
      stage: "token_exchange",
      reason,
      expected: true,
      httpStatusCode: status,
    });
    expect(JSON.stringify(error.classification)).not.toContain("PRIVATE");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [418, "upstream_4xx"],
    [503, "upstream_5xx"],
  ] as const)("returns a typed Anthropic validation failure for HTTP %i", async (status, reason) => {
    const result = await validateToken("PRIVATE-token", {
      fetchImpl: vi.fn(async () => new Response("PRIVATE body", { status })),
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostic.classification).toEqual({
        stage: "token_validation",
        reason,
        expected: true,
        httpStatusCode: status,
      });
      expect(JSON.stringify(result.diagnostic.classification)).not.toContain("PRIVATE");
    }
  });

  it("keeps an unknown Anthropic validation exception local and marks it unexpected", async () => {
    const result = await validateToken("PRIVATE-token", {
      fetchImpl: vi.fn(async () => { throw new Error("PRIVATE novel transport failure"); }),
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("PRIVATE");
      expect(result.diagnostic.classification).toEqual({
        stage: "token_validation",
        reason: "other",
        expected: false,
      });
    }
  });

  it("classifies timeouts and known network codes without parsing Error.message", () => {
    const timeout = Object.assign(new Error("PRIVATE timeout message"), { name: "TimeoutError" });
    const network = Object.assign(new Error("PRIVATE network message"), { code: "ECONNRESET" });
    const unknown = new Error("PRIVATE totally novel failure");

    expect(classifyNetworkSetupFailure("device_code_request", timeout).classification.reason).toBe("timeout");
    expect(classifyNetworkSetupFailure("device_code_request", network).classification.reason).toBe("network_failure");
    expect(classifyNetworkSetupFailure("device_code_request", unknown).classification).toEqual({
      stage: "device_code_request",
      reason: "other",
      expected: false,
    });
  });

  it.each([
    [new DOMException("PRIVATE aborted request", "AbortError"), "timeout"],
    [new DOMException("PRIVATE timed out request", "TimeoutError"), "timeout"],
  ] as const)("classifies inherited built-in %s names without exporting their messages", (error, reason) => {
    expect(Object.hasOwn(error, "name")).toBe(false);

    const classified = classifyNetworkSetupFailure("device_code_request", error);

    expect(classified.classification).toEqual({
      stage: "device_code_request",
      reason,
      expected: true,
    });
    expect(JSON.stringify(classified.classification)).not.toContain("PRIVATE");
  });

  it("finds an allowlisted system code through a bounded own cause chain", () => {
    const deepest = Object.assign(new Error("PRIVATE socket detail"), { code: "ECONNREFUSED" });
    const nested = Object.assign(new TypeError("PRIVATE fetch failed"), {
      cause: Object.assign(new Error("PRIVATE wrapper"), { cause: deepest }),
    });

    expect(classifyNetworkSetupFailure("device_code_request", nested).classification).toEqual({
      stage: "device_code_request",
      reason: "network_failure",
      expected: true,
    });
  });

  it("does not traverse an unbounded cause chain or read cause accessors", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty(new Error("PRIVATE"), "cause", {
      get() {
        getterCalls += 1;
        return Object.assign(new Error("PRIVATE"), { code: "ECONNREFUSED" });
      },
    });
    const tooDeep = Object.assign(new Error("PRIVATE level 0"), {
      cause: Object.assign(new Error("PRIVATE level 1"), {
        cause: Object.assign(new Error("PRIVATE level 2"), {
          cause: Object.assign(new Error("PRIVATE level 3"), { code: "ECONNREFUSED" }),
        }),
      }),
    });

    expect(classifyNetworkSetupFailure("device_code_request", accessor).classification.reason).toBe("other");
    expect(getterCalls).toBe(0);
    expect(classifyNetworkSetupFailure("device_code_request", tooDeep).classification.reason).toBe("other");
  });
});

describe("diagnostic identity and command flushing", () => {
  it("passes a trusted attempt ID to the sanitizer while stable installation identity remains separate", () => {
    const identities: Array<{ installationId: string; diagnosticId?: string }> = [];
    const facade = createTelemetryFacade({
      getSnapshot: () => ({
        enabled: true,
        state: { enabled: true, installId: INSTALL_ID, firstRunAt: "2026-08-11T00:00:00.000Z" },
      }),
      getAnalytics: () => ({
        captureAnalytics: vi.fn(),
        captureAnalyticsImmediate: vi.fn(async () => undefined),
        captureException: vi.fn(),
        captureExceptionImmediate: vi.fn(async () => undefined),
        flushWithin: vi.fn(async () => undefined),
        shutdownWithin: vi.fn(async () => undefined),
        discardPending: vi.fn(),
      }),
      sanitizeException: (_error, _context, identity) => {
        identities.push(identity);
        return {
          error: new Error("other"),
          category: "setup",
          reason: "other",
          errorKind: "error",
          frames: [],
          fingerprint: "safe" as never,
          diagnosticId: identity.diagnosticId as never,
        };
      },
    });

    expect(facade.recordUnexpectedException(new Error("PRIVATE"), {
      category: "setup",
      provider: "anthropic",
      setupStage: "credential_parse",
      reason: "other",
    }, DIAGNOSTIC_ID)).toBe(DIAGNOSTIC_ID);
    expect(identities).toEqual([{ installationId: INSTALL_ID, diagnosticId: DIAGNOSTIC_ID }]);

    expect(facade.recordUnexpectedException(new Error("PRIVATE"), {
      category: "setup",
      provider: "anthropic",
      setupStage: "credential_parse",
      reason: "other",
    }, INSTALL_ID)).toBeUndefined();
    expect(identities).toHaveLength(1);
  });

  it("flushes in finally without replacing a command result or original error", async () => {
    const flush = vi.fn(async () => { throw new Error("flush failed"); });

    await expect(withSetupTelemetryFlush(async () => 7, flush)).resolves.toBe(7);
    const original = new Error("command failed");
    await expect(withSetupTelemetryFlush(async () => { throw original; }, flush)).rejects.toBe(original);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
