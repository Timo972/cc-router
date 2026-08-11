import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthTokens } from "../proxy/types.js";
import {
  SetupDiagnosticError,
  type SetupDiagnosticRecorder,
} from "../telemetry/setup-diagnostics.js";
import {
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
  const exceptions: Array<{ context: unknown; diagnosticId?: string }> = [];
  const value: SetupDiagnosticRecorder = {
    recordSetupStage: input => { safe.push(input); },
    recordSetupResult: input => { safe.push(input); },
    recordExpectedSetupFailure: input => { safe.push(input); },
    recordUnexpectedException: (_error, context, diagnosticId) => {
      exceptions.push({ context, diagnosticId });
      return diagnosticId as never;
    },
    flushTelemetryWithin: async () => undefined,
  };
  return { value, safe, exceptions };
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
    expect(JSON.stringify(recorded.safe)).not.toContain("PRIVATE");
  });

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
});
