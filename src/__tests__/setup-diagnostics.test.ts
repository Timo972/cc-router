import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({
  stages: [] as Array<Record<string, unknown>>,
  stageFailures: [] as Array<Record<string, unknown>>,
  results: [] as Array<Record<string, unknown>>,
  failures: [] as Array<Record<string, unknown>>,
  exceptions: [] as Array<{ error: unknown; context: Record<string, unknown>; diagnosticId?: string }>,
  flushes: [] as number[],
}));

vi.mock("../telemetry/facade.js", () => ({
  recordSetupStage: (input: Record<string, unknown>) => { recorded.stages.push(input); },
  recordSetupStageFailure: (input: Record<string, unknown>) => { recorded.stageFailures.push(input); },
  recordSetupResult: (input: Record<string, unknown>) => { recorded.results.push(input); },
  recordExpectedSetupFailure: (input: Record<string, unknown>) => { recorded.failures.push(input); },
  recordUnexpectedException: (
    error: unknown,
    context: Record<string, unknown>,
    diagnosticId?: string,
  ) => {
    recorded.exceptions.push({ error, context, diagnosticId });
    return diagnosticId;
  },
  flushTelemetryWithin: async (deadlineMs: number) => { recorded.flushes.push(deadlineMs); },
}));

const {
  SetupDiagnosticError,
  classifyHttpSetupFailure,
  classifyNetworkSetupFailure,
  createSetupAttempt,
  isPromptCancellation,
  withSetupTelemetryFlush,
} = await import("../telemetry/setup-diagnostics.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  recorded.stages = [];
  recorded.stageFailures = [];
  recorded.results = [];
  recorded.failures = [];
  recorded.exceptions = [];
  recorded.flushes = [];
});

describe("setup attempt funnel", () => {
  it.each([
    ["anthropic", "macos_keychain", ["credential_read", "credential_parse", "token_validation", "persistence"]],
    ["anthropic", "manual_token", ["credential_read", "credential_parse", "token_validation", "persistence"]],
    ["openai", "manual_token", ["credential_read", "credential_parse", "persistence"]],
    ["openai", "device_oauth", ["device_code_request", "authorization_polling", "token_exchange", "access_token_parse", "persistence"]],
  ] as const)("records the complete %s/%s success path", (provider, method, stages) => {
    const attempt = createSetupAttempt({ provider, method });

    attempt.stageCompleted("credential_source_selection");
    for (const stage of stages) attempt.stageCompleted(stage);
    attempt.succeeded();

    expect(attempt.diagnosticId).toMatch(UUID);
    expect(recorded.stages.map(stage => stage["stage"])).toEqual([
      "attempt_start",
      "credential_source_selection",
      ...stages,
    ]);
    expect(new Set(recorded.stages.map(stage => stage["diagnosticId"])))
      .toEqual(new Set([attempt.diagnosticId]));
    expect(recorded.stages[0]).toMatchObject({ provider, method, durationBucket: "under_1s" });
    expect(recorded.results).toEqual([
      expect.objectContaining({ provider, method, result: "succeeded" }),
    ]);
    expect(recorded.failures).toEqual([]);
    expect(recorded.exceptions).toEqual([]);
  });

  it.each([
    ["credential_read", "not_found", undefined],
    ["credential_parse", "malformed_credentials", undefined],
    ["token_validation", "unauthorized", 401],
    ["token_validation", "rate_limited", 429],
    ["token_exchange", "upstream_5xx", 503],
    ["authorization_polling", "timeout", undefined],
    ["access_token_parse", "unexpected_response_shape", undefined],
  ] as const)("keeps known %s/%s failures out of error tracking", (stage, reason, httpStatusCode) => {
    const attempt = createSetupAttempt({ provider: "openai", method: "device_oauth" });
    const error = new SetupDiagnosticError("local detail", {
      stage,
      reason,
      expected: true,
      ...(httpStatusCode === undefined ? {} : { httpStatusCode }),
    });

    const outcome = attempt.failed(error, stage);

    expect(outcome).toEqual({ diagnosticId: attempt.diagnosticId, unexpected: false });
    expect(recorded.failures).toEqual([expect.objectContaining({
      stage,
      reason,
      diagnosticId: attempt.diagnosticId,
      ...(httpStatusCode === undefined ? {} : { httpStatusCode }),
    })]);
    expect(recorded.exceptions).toEqual([]);
  });

  it("reports an unexpected failure once with the attempt id and the local cause", () => {
    const cause = new Error("PRIVATE_KEYCHAIN_DETAIL");
    const attempt = createSetupAttempt({ provider: "anthropic", method: "macos_keychain" });

    const outcome = attempt.failed(
      new SetupDiagnosticError("wrapper", {
        stage: "credential_read",
        reason: "other",
        expected: false,
      }, { cause }),
      "credential_read",
    );
    attempt.failed(new Error("ignored after the terminal outcome"), "persistence");

    expect(outcome.unexpected).toBe(true);
    expect(recorded.failures).toHaveLength(1);
    expect(recorded.exceptions).toEqual([{
      error: cause,
      context: {
        category: "setup",
        provider: "anthropic",
        setupStage: "credential_read",
        reason: "other",
      },
      diagnosticId: attempt.diagnosticId,
    }]);
  });

  it("keeps a recoverable stage failure nonterminal", () => {
    const attempt = createSetupAttempt({ provider: "anthropic", method: "claude_credentials_file" });

    const outcome = attempt.stageFailed(new SetupDiagnosticError("local", {
      stage: "credential_read",
      reason: "not_found",
      expected: true,
    }), "credential_read");
    attempt.stageCompleted("credential_read");
    attempt.succeeded();

    expect(outcome.unexpected).toBe(false);
    expect(recorded.stageFailures).toHaveLength(1);
    expect(recorded.failures).toEqual([]);
    expect(recorded.results).toEqual([expect.objectContaining({ result: "succeeded" })]);
  });

  it("records cancellation without creating an exception", () => {
    const attempt = createSetupAttempt({ provider: "openai", method: "device_oauth" });

    attempt.cancelled();
    attempt.succeeded();

    expect(recorded.results).toEqual([expect.objectContaining({ result: "cancelled" })]);
    expect(recorded.exceptions).toEqual([]);
  });
});

describe("typed failure classification", () => {
  it.each([
    [401, "unauthorized", true],
    [403, "forbidden", true],
    [429, "rate_limited", true],
    [418, "upstream_4xx", true],
    [503, "upstream_5xx", true],
    [200, "other", false],
  ] as const)("classifies HTTP %i as %s", (status, reason, expected) => {
    const error = classifyHttpSetupFailure("token_validation", status, "PRIVATE_BODY");

    expect(error.classification).toEqual({
      stage: "token_validation",
      reason,
      expected,
      httpStatusCode: status,
    });
    expect(error.message).toBe("PRIVATE_BODY");
  });

  it("classifies timeouts and known network codes without parsing the message", () => {
    const timeout = classifyNetworkSetupFailure(
      "authorization_polling",
      Object.assign(new Error("PRIVATE_TIMEOUT"), { code: "ETIMEDOUT" }),
    );
    const refused = classifyNetworkSetupFailure(
      "device_code_request",
      Object.assign(new Error("PRIVATE_REFUSED"), { code: "ECONNREFUSED" }),
    );
    const unknown = classifyNetworkSetupFailure("token_exchange", new TypeError("timed out"));

    expect(timeout.classification).toEqual({
      stage: "authorization_polling",
      reason: "timeout",
      expected: true,
    });
    expect(refused.classification.reason).toBe("network_failure");
    expect(unknown.classification).toEqual({
      stage: "token_exchange",
      reason: "other",
      expected: false,
    });
  });

  it("finds an allowlisted code through a bounded own cause chain only", () => {
    const nested = new TypeError("PRIVATE_FETCH_FAILURE");
    Object.defineProperty(nested, "cause", {
      value: Object.assign(new Error("PRIVATE_SOCKET"), { code: "ECONNRESET" }),
    });
    const tooDeep = new Error("level0");
    Object.defineProperty(tooDeep, "cause", {
      value: Object.assign(new Error("level1"), {
        cause: Object.assign(new Error("level2"), {
          cause: Object.assign(new Error("level3"), { code: "ECONNRESET" }),
        }),
      }),
    });
    const accessorOnly = new Error("accessor");
    Object.defineProperty(accessorOnly, "code", {
      get: () => { throw new Error("telemetry must not invoke foreign accessors"); },
    });

    expect(classifyNetworkSetupFailure("token_exchange", nested).classification.reason)
      .toBe("network_failure");
    expect(classifyNetworkSetupFailure("token_exchange", tooDeep).classification.reason)
      .toBe("other");
    expect(classifyNetworkSetupFailure("token_exchange", accessorOnly).classification.reason)
      .toBe("other");
  });

  it("detects prompt cancellation by its own name only", () => {
    expect(isPromptCancellation(Object.assign(new Error("x"), { name: "ExitPromptError" })))
      .toBe(true);
    expect(isPromptCancellation(new Error("ExitPromptError"))).toBe(false);
  });
});

describe("command flushing", () => {
  it("flushes in finally without replacing the command result", async () => {
    await expect(withSetupTelemetryFlush(async () => "result")).resolves.toBe("result");
    expect(recorded.flushes).toEqual([1_500]);
  });

  it("flushes in finally without replacing the original error", async () => {
    const failure = new Error("PRIVATE_COMMAND_FAILURE");
    await expect(withSetupTelemetryFlush(async () => { throw failure; })).rejects.toBe(failure);
    expect(recorded.flushes).toEqual([1_500]);
  });
});
