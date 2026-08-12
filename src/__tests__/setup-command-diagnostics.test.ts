import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthTokens } from "../proxy/types.js";
import { AccountStateReadError } from "../config/manager.js";
import {
  SetupDiagnosticError,
  type SetupDiagnosticRecorder,
} from "../telemetry/setup-diagnostics.js";
import {
  parseManualTokenExpiry,
  runClientSetupFromWizard,
  runSetupCommand,
  setupSingleAccountDetailed,
  type SetupSingleAccountDependencies,
} from "../cli/cmd-setup.js";
import { runAddAccountFlow, type AddAccountFlowDependencies } from "../cli/cmd-status.js";
import {
  runOpenAIDeviceAccountSetup,
  runOpenAIManualAccountSetup,
  type OpenAIDeviceAccountSetupDependencies,
  type OpenAIManualAccountSetupDependencies,
} from "../cli/cmd-accounts.js";

const DIAGNOSTIC_ID = "22222222-2222-4222-8222-222222222222";
const PRIVATE_ACCESS = "sk-ant-oat01-PRIVATE-access";
const PRIVATE_REFRESH = "sk-ant-ort01-PRIVATE-refresh";
const PRIVATE_ACCOUNT = "PRIVATE-account-id";

function tokens(): OAuthTokens {
  return {
    accessToken: PRIVATE_ACCESS,
    refreshToken: PRIVATE_REFRESH,
    expiresAt: 1_999_999_999_000,
    scopes: ["PRIVATE-scope"],
  };
}

function recorder() {
  const safe: unknown[] = [];
  const stageFailures: unknown[] = [];
  const terminalFailures: unknown[] = [];
  const results: unknown[] = [];
  const exceptions: Array<{ context: unknown; diagnosticId?: string }> = [];
  const value: SetupDiagnosticRecorder = {
    recordSetupStage: input => { safe.push(input); },
    recordSetupStageFailure: input => { safe.push(input); stageFailures.push(input); },
    recordSetupResult: input => { safe.push(input); results.push(input); },
    recordExpectedSetupFailure: input => { safe.push(input); terminalFailures.push(input); },
    recordUnexpectedException: (_error, context, diagnosticId) => {
      exceptions.push({ context, diagnosticId });
      return diagnosticId as never;
    },
    flushTelemetryWithin: async () => undefined,
  };
  return { value, safe, stageFailures, terminalFailures, results, exceptions };
}

function dependencies(
  method: "keychain" | "credentials" | "manual",
  recorded: ReturnType<typeof recorder>,
): SetupSingleAccountDependencies {
  return {
    chooseMethod: async () => method,
    extractKeychain: async () => ({
      ok: true,
      tokens: tokens(),
      completedStages: ["credential_read", "credential_parse"],
    }),
    extractCredentials: () => ({
      ok: true,
      tokens: tokens(),
      completedStages: ["credential_read", "credential_parse"],
    }),
    promptManualTokens: async () => tokens(),
    promptAccountId: async () => PRIVATE_ACCOUNT,
    confirmRetry: async () => false,
    confirmSaveInvalid: async () => false,
    validateToken: async () => ({ valid: true }),
    readAccountState: () => ({ ok: true, records: [] }),
    createAttempt: input => (awaitImportAttempt())({
      ...input,
      recorder: recorded.value,
      randomUUID: () => DIAGNOSTIC_ID,
      now: () => 1_000,
    }),
  };
}

// Static import kept below the dependency factory to make the desired injected
// boundary explicit without module mocks.
import { createSetupAttempt } from "../telemetry/setup-diagnostics.js";
function awaitImportAttempt(): typeof createSetupAttempt {
  return createSetupAttempt;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async input => {
    const url = input instanceof Request ? input.url : String(input);
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (!hostname.startsWith("127.") && hostname !== "::1") {
      throw new Error(`Task 9 test blocked non-loopback fetch: ${hostname}`);
    }
    throw new Error("Task 9 test requires an injected loopback transport");
  }));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Anthropic account-add methods", () => {
  it.each([
    ["keychain", "macos_keychain"],
    ["credentials", "claude_credentials_file"],
    ["manual", "manual_token"],
  ] as const)("correlates the %s flow without emitting prompted values", async (selected, method) => {
    const recorded = recorder();
    const result = await setupSingleAccountDetailed(1, dependencies(selected, recorded));

    expect(result.account).toEqual(expect.objectContaining({ id: PRIVATE_ACCOUNT, tokens: tokens() }));
    expect(result.attempt).toEqual(expect.objectContaining({ method, diagnosticId: DIAGNOSTIC_ID }));
    expect(recorded.safe).toEqual([
      expect.objectContaining({ method, stage: "attempt_start", diagnosticId: DIAGNOSTIC_ID }),
      expect.objectContaining({ method, stage: "credential_source_selection", diagnosticId: DIAGNOSTIC_ID }),
      expect.objectContaining({ method, stage: "credential_read", diagnosticId: DIAGNOSTIC_ID }),
      expect.objectContaining({ method, stage: "credential_parse", diagnosticId: DIAGNOSTIC_ID }),
      expect.objectContaining({ method, stage: "token_validation", diagnosticId: DIAGNOSTIC_ID }),
    ]);
    const wire = JSON.stringify(recorded.safe);
    expect(wire).not.toContain(PRIVATE_ACCESS);
    expect(wire).not.toContain(PRIVATE_REFRESH);
    expect(wire).not.toContain(PRIVATE_ACCOUNT);
    expect(wire).not.toContain("PRIVATE-scope");
  });

  it("records a known extraction failure and explicit cancellation without Error Tracking", async () => {
    const recorded = recorder();
    const deps = dependencies("keychain", recorded);
    deps.extractKeychain = async () => ({
      ok: false,
      error: new SetupDiagnosticError("PRIVATE Keychain output", {
        stage: "credential_read",
        reason: "not_found",
        expected: true,
      }),
    });

    const result = await setupSingleAccountDetailed(1, deps);

    expect(result.account).toBeNull();
    expect(recorded.safe).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "credential_read", reason: "not_found", diagnosticId: DIAGNOSTIC_ID }),
      expect.objectContaining({ result: "cancelled", diagnosticId: DIAGNOSTIC_ID }),
    ]));
    expect(recorded.exceptions).toEqual([]);
    expect(recorded.stageFailures).toHaveLength(1);
    expect(recorded.terminalFailures).toEqual([]);
    expect(recorded.results).toEqual([
      expect.objectContaining({ result: "cancelled", diagnosticId: DIAGNOSTIC_ID }),
    ]);
    expect(JSON.stringify(recorded.safe)).not.toContain("PRIVATE");
  });

  it("closes a failed extraction attempt before retrying with a fresh attempt", async () => {
    const recorded = recorder();
    const deps = dependencies("keychain", recorded);
    const methods = ["keychain", "manual"] as const;
    const diagnosticIds = [
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    deps.chooseMethod = async () => methods.shift() ?? "manual";
    deps.extractKeychain = async () => ({
      ok: false,
      error: new SetupDiagnosticError("PRIVATE Keychain output", {
        stage: "credential_read",
        reason: "not_found",
        expected: true,
      }),
    });
    deps.confirmRetry = async () => true;
    deps.createAttempt = input => createSetupAttempt({
      ...input,
      recorder: recorded.value,
      randomUUID: () => diagnosticIds.shift() ?? DIAGNOSTIC_ID,
      now: () => 1_000,
    });

    const setup = await setupSingleAccountDetailed(1, deps);
    expect(setup.account).not.toBeNull();
    await import("../telemetry/setup-diagnostics.js").then(({ persistSetupAttempts }) =>
      persistSetupAttempts([setup.attempt], () => undefined));

    expect(recorded.stageFailures).toEqual([]);
    expect(recorded.terminalFailures).toEqual([
      expect.objectContaining({
        reason: "not_found",
        diagnosticId: "22222222-2222-4222-8222-222222222222",
      }),
    ]);
    expect(recorded.results).toEqual([
      expect.objectContaining({
        result: "succeeded",
        diagnosticId: "33333333-3333-4333-8333-333333333333",
      }),
    ]);
  });

  it.each([
    [false, "cancelled"],
    [true, "succeeded"],
  ] as const)("keeps invalid-token failure nonterminal when save-anyway is %s", async (keepAnyway, terminal) => {
    const recorded = recorder();
    const deps = dependencies("manual", recorded);
    deps.validateToken = async () => ({
      valid: false,
      reason: "PRIVATE rejected token",
      diagnostic: new SetupDiagnosticError("PRIVATE rejected token", {
        stage: "token_validation",
        reason: "invalid_token",
        expected: true,
      }),
    });
    deps.confirmSaveInvalid = async () => keepAnyway;

    const setup = await setupSingleAccountDetailed(1, deps);
    if (setup.account) {
      await import("../telemetry/setup-diagnostics.js").then(({ persistSetupAttempts }) =>
        persistSetupAttempts([setup.attempt], () => undefined));
    }

    expect(recorded.stageFailures).toEqual([
      expect.objectContaining({ stage: "token_validation", reason: "invalid_token" }),
    ]);
    expect(recorded.terminalFailures).toEqual([]);
    expect(recorded.results).toEqual([
      expect.objectContaining({ result: terminal }),
    ]);
  });

  it.each([
    ["2033-05-18", 1_999_987_200_000],
    ["2033-05-18T03:33:20.000Z", 2_000_000_000_000],
    ["2000000000000", 2_000_000_000_000],
  ])("parses explicit ISO and numeric-millisecond manual expiries", (input, expected) => {
    expect(parseManualTokenExpiry(input)).toBe(expected);
  });

  it.each(["", "0", "-1", "Infinity", "not-a-date", "2000000000000ms", "999999999999999999"])(
    "rejects invalid manual expiry %j before an account can be returned",
    async expiry => {
      expect(() => parseManualTokenExpiry(expiry)).toThrowError(SetupDiagnosticError);
      try {
        parseManualTokenExpiry(expiry);
      } catch (error) {
        expect((error as SetupDiagnosticError).classification).toEqual({
          stage: "credential_parse",
          reason: "malformed_credentials",
          expected: true,
        });
      }

      const recorded = recorder();
      const deps = dependencies("manual", recorded);
      deps.promptManualTokens = async () => {
        parseManualTokenExpiry(expiry);
        return tokens();
      };
      const promptAccountId = vi.fn(async () => PRIVATE_ACCOUNT);
      deps.promptAccountId = promptAccountId;

      await expect(setupSingleAccountDetailed(1, deps)).rejects.toBeInstanceOf(SetupDiagnosticError);
      expect(promptAccountId).not.toHaveBeenCalled();
      expect(recorded.terminalFailures).toEqual([
        expect.objectContaining({
          stage: "credential_parse",
          reason: "malformed_credentials",
        }),
      ]);
      expect(recorded.exceptions).toEqual([]);
      expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain("Unexpected setup failure");
    },
  );

  it("captures an unexpected validation fault and prints the same local correlation ID", async () => {
    const recorded = recorder();
    const deps = dependencies("manual", recorded);
    deps.validateToken = async () => ({
      valid: false,
      reason: "PRIVATE provider detail",
      diagnostic: new SetupDiagnosticError("PRIVATE provider detail", {
        stage: "token_validation",
        reason: "other",
        expected: false,
      }),
    });

    const result = await setupSingleAccountDetailed(1, deps);

    expect(result.account).toBeNull();
    expect(recorded.exceptions).toEqual([{
      context: {
        category: "setup",
        provider: "anthropic",
        setupStage: "token_validation",
        reason: "other",
      },
      diagnosticId: DIAGNOSTIC_ID,
    }]);
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain(DIAGNOSTIC_ID);
  });

  it("preserves an unexpected thrown failure after recording its correlation ID", async () => {
    const recorded = recorder();
    const deps = dependencies("manual", recorded);
    const failure = new Error("PRIVATE validator crashed");
    deps.validateToken = async () => { throw failure; };

    await expect(setupSingleAccountDetailed(1, deps)).rejects.toBe(failure);

    expect(recorded.exceptions).toEqual([
      expect.objectContaining({ diagnosticId: DIAGNOSTIC_ID }),
    ]);
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain(DIAGNOSTIC_ID);
  });
});

describe("setup command lifecycle", () => {
  it("flushes before preserving client connection exit 1 when flushing times out", async () => {
    vi.useFakeTimers();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const flush = vi.fn(() => new Promise<void>(() => undefined));
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("PRIVATE timed out", "TimeoutError");
    });

    try {
      const operation = runSetupCommand({ addMode: false }, {
        runWizard: async () => runClientSetupFromWizard({
          promptServerUrl: async () => "127.0.0.1:3456",
          promptSecret: async () => "PRIVATE-secret",
          fetchImpl,
        }),
        flush,
      });
      await vi.advanceTimersByTimeAsync(1_500);
      await operation;

      expect(fetchImpl).toHaveBeenCalledWith(
        "http://127.0.0.1:3456/cc-router/health",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(flush).toHaveBeenCalledOnce();
      expect(flush).toHaveBeenCalledWith(1_500);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      vi.useRealTimers();
    }
  });
});

describe("status dashboard account persistence", () => {
  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [422, "upstream_4xx"],
    [503, "upstream_5xx"],
  ] as const)("records safe HTTP %i persistence failure and always flushes", async (status, reason) => {
    const recorded = recorder();
    const deps = dependencies("manual", recorded);
    const setup = await setupSingleAccountDetailed(1, deps);
    const flush = vi.fn(async () => { throw new Error("flush failure"); });
    const flowDependencies: AddAccountFlowDependencies = {
      setupSingleAccount: async () => setup,
      fetchImpl: vi.fn(async () => new Response("PRIVATE raw server body", { status })),
      flush,
    };

    await expect(runAddAccountFlow({
      baseUrl: "https://PRIVATE-router.example",
      healthUrl: "https://PRIVATE-router.example/health",
      headers: { authorization: "Bearer PRIVATE-secret" },
      authToken: "PRIVATE-secret",
    }, flowDependencies)).resolves.toBeNull();

    expect(recorded.safe).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "persistence", reason, httpStatusCode: status, diagnosticId: DIAGNOSTIC_ID }),
    ]));
    expect(JSON.stringify(recorded.safe)).not.toContain("PRIVATE");
    expect(flush).toHaveBeenCalledOnce();
  });
});

describe("OpenAI account-add methods", () => {
  const record = {
    id: PRIVATE_ACCOUNT,
    provider: "openai_subscription" as const,
    accessToken: "PRIVATE-openai-access",
    refreshToken: "PRIVATE-openai-refresh",
    expiresAt: 1_999_999_999_000,
    scopes: ["PRIVATE-openai-scope"],
    enabled: true,
  };

  it("records the manual-token funnel and flushes without exporting prompt values", async () => {
    const recorded = recorder();
    const persist = vi.fn();
    const flush = vi.fn(async () => { throw new Error("flush failed"); });
    const deps: OpenAIManualAccountSetupDependencies = {
      collectInput: async () => ({
        id: PRIVATE_ACCOUNT,
        accessToken: record.accessToken,
        refreshToken: record.refreshToken,
        expiresAt: record.expiresAt,
        scopes: record.scopes,
      }),
      persist,
      readAccountState: () => ({ ok: true, records: [] }),
      createAttempt: input => createSetupAttempt({
        ...input,
        recorder: recorded.value,
        randomUUID: () => DIAGNOSTIC_ID,
        now: () => 1_000,
      }),
      flush,
    };

    await expect(runOpenAIManualAccountSetup(deps)).resolves.toEqual(record);

    expect(persist).toHaveBeenCalledWith(record);
    expect(recorded.safe).toEqual([
      expect.objectContaining({ stage: "attempt_start", method: "manual_token", diagnosticId: DIAGNOSTIC_ID }),
      expect.objectContaining({ stage: "credential_source_selection", diagnosticId: DIAGNOSTIC_ID }),
      expect.objectContaining({ stage: "credential_read", diagnosticId: DIAGNOSTIC_ID }),
      expect.objectContaining({ stage: "credential_parse", diagnosticId: DIAGNOSTIC_ID }),
      expect.objectContaining({ stage: "token_validation", diagnosticId: DIAGNOSTIC_ID }),
      expect.objectContaining({ stage: "persistence", diagnosticId: DIAGNOSTIC_ID }),
      expect.objectContaining({ result: "succeeded", diagnosticId: DIAGNOSTIC_ID }),
    ]);
    expect(JSON.stringify(recorded.safe)).not.toContain("PRIVATE");
    expect(flush).toHaveBeenCalledOnce();
  });

  it("records every successful device-OAuth stage with one attempt ID", async () => {
    const recorded = recorder();
    const flush = vi.fn(async () => undefined);
    const deps: OpenAIDeviceAccountSetupDependencies = {
      collectAccountId: async () => PRIVATE_ACCOUNT,
      login: async options => {
        options.onStageCompleted?.("device_code_request");
        options.onStageCompleted?.("authorization_polling");
        options.onStageCompleted?.("token_exchange");
        options.onStageCompleted?.("access_token_parse");
        return record;
      },
      onDeviceCode: () => undefined,
      persist: vi.fn(),
      readAccountState: () => ({ ok: true, records: [] }),
      createAttempt: input => createSetupAttempt({
        ...input,
        recorder: recorded.value,
        randomUUID: () => DIAGNOSTIC_ID,
        now: () => 1_000,
      }),
      flush,
    };

    await expect(runOpenAIDeviceAccountSetup(deps)).resolves.toEqual(record);

    expect(recorded.safe).toEqual([
      expect.objectContaining({ stage: "attempt_start", method: "device_oauth" }),
      expect.objectContaining({ stage: "credential_source_selection" }),
      expect.objectContaining({ stage: "device_code_request" }),
      expect.objectContaining({ stage: "authorization_polling" }),
      expect.objectContaining({ stage: "token_exchange" }),
      expect.objectContaining({ stage: "access_token_parse" }),
      expect.objectContaining({ stage: "persistence" }),
      expect.objectContaining({ result: "succeeded" }),
    ]);
    expect(recorded.safe.every(value => (value as { diagnosticId: string }).diagnosticId === DIAGNOSTIC_ID)).toBe(true);
  });

  it("keeps a known device OAuth failure out of Error Tracking and flushes", async () => {
    const recorded = recorder();
    const flush = vi.fn(async () => undefined);
    const failure = new SetupDiagnosticError("PRIVATE upstream response", {
      stage: "token_exchange",
      reason: "unauthorized",
      expected: true,
      httpStatusCode: 401,
    });
    const deps: OpenAIDeviceAccountSetupDependencies = {
      collectAccountId: async () => PRIVATE_ACCOUNT,
      login: async () => { throw failure; },
      onDeviceCode: () => undefined,
      persist: vi.fn(),
      readAccountState: () => ({ ok: true, records: [] }),
      createAttempt: input => createSetupAttempt({
        ...input,
        recorder: recorded.value,
        randomUUID: () => DIAGNOSTIC_ID,
        now: () => 1_000,
      }),
      flush,
    };

    await expect(runOpenAIDeviceAccountSetup(deps)).rejects.toBe(failure);
    expect(recorded.safe).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "token_exchange",
        reason: "unauthorized",
        httpStatusCode: 401,
        diagnosticId: DIAGNOSTIC_ID,
      }),
    ]));
    expect(recorded.exceptions).toEqual([]);
    expect(flush).toHaveBeenCalledOnce();
  });

  it.each(["anthropic", "openai_manual", "openai_device"] as const)(
    "correlates malformed stored state before the %s add path can prompt or persist",
    async flow => {
      const recorded = recorder();
      const stateError = new AccountStateReadError(
        "malformed_json",
        "/Users/PRIVATE/.cc-router/accounts.json",
        new SyntaxError("PRIVATE raw JSON fragment"),
      );
      const collect = vi.fn(async () => ({
        id: PRIVATE_ACCOUNT,
        accessToken: "PRIVATE-openai-access",
        refreshToken: "PRIVATE-openai-refresh",
        expiresAt: 2_000_000_000_000,
        scopes: ["PRIVATE-scope"],
      }));
      const persist = vi.fn();
      const createAttemptForTest = (input: Parameters<typeof createSetupAttempt>[0]) => createSetupAttempt({
        ...input,
        recorder: recorded.value,
        randomUUID: () => DIAGNOSTIC_ID,
        now: () => 1_000,
      });

      let operation: Promise<unknown>;
      if (flow === "anthropic") {
        const deps = dependencies("manual", recorded);
        deps.readAccountState = () => ({ ok: false, error: stateError });
        deps.promptManualTokens = collect as never;
        operation = setupSingleAccountDetailed(1, deps);
      } else if (flow === "openai_manual") {
        operation = runOpenAIManualAccountSetup({
          collectInput: collect,
          persist,
          readAccountState: () => ({ ok: false, error: stateError }),
          createAttempt: createAttemptForTest,
          flush: async () => undefined,
        });
      } else {
        operation = runOpenAIDeviceAccountSetup({
          collectAccountId: collect as never,
          login: vi.fn(),
          onDeviceCode: () => undefined,
          persist,
          readAccountState: () => ({ ok: false, error: stateError }),
          createAttempt: createAttemptForTest,
          flush: async () => undefined,
        });
      }

      const error = await operation.catch(value => value);
      expect(error).toBeInstanceOf(SetupDiagnosticError);
      expect((error as SetupDiagnosticError).cause).toBe(stateError);
      expect(collect).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(recorded.terminalFailures).toEqual([
        expect.objectContaining({
          stage: "persistence",
          reason: "malformed_credentials",
          diagnosticId: DIAGNOSTIC_ID,
        }),
      ]);
      expect(recorded.exceptions).toEqual([
        expect.objectContaining({ diagnosticId: DIAGNOSTIC_ID }),
      ]);
      expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain(DIAGNOSTIC_ID);
      expect(JSON.stringify(recorded.safe)).not.toContain("PRIVATE");
    },
  );
});
