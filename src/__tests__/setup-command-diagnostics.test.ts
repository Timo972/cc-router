import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({
  stages: [] as Array<Record<string, unknown>>,
  stageFailures: [] as Array<Record<string, unknown>>,
  results: [] as Array<Record<string, unknown>>,
  failures: [] as Array<Record<string, unknown>>,
  exceptions: [] as Array<{ context: Record<string, unknown>; diagnosticId?: string }>,
}));

const answers = vi.hoisted(() => ({
  selects: [] as unknown[],
  inputs: [] as string[],
  confirms: [] as boolean[],
  passwords: [] as string[],
}));

vi.mock("../telemetry/facade.js", () => ({
  recordSetupStage: (input: Record<string, unknown>) => { recorded.stages.push(input); },
  recordSetupStageFailure: (input: Record<string, unknown>) => { recorded.stageFailures.push(input); },
  recordSetupResult: (input: Record<string, unknown>) => { recorded.results.push(input); },
  recordExpectedSetupFailure: (input: Record<string, unknown>) => { recorded.failures.push(input); },
  recordUnexpectedException: (
    _error: unknown,
    context: Record<string, unknown>,
    diagnosticId?: string,
  ) => {
    recorded.exceptions.push({ context, diagnosticId });
    return diagnosticId;
  },
  flushTelemetryWithin: async () => undefined,
}));

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(async () => answers.selects.shift()),
  input: vi.fn(async () => answers.inputs.shift() ?? ""),
  confirm: vi.fn(async () => answers.confirms.shift() ?? false),
  password: vi.fn(async () => answers.passwords.shift() ?? ""),
  number: vi.fn(async () => 1),
}));

vi.mock("../config/manager.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../config/manager.js")>()),
  accountsFileExists: () => false,
  loadAccounts: () => [],
  readConfig: () => ({}),
  writeConfig: vi.fn(),
}));

vi.mock("../utils/claude-config.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../utils/claude-config.js")>()),
  readClaudeProxySettings: () => ({}),
  writeClaudeSettings: vi.fn(),
}));

const saveAccounts = vi.hoisted(() => vi.fn());
vi.mock("../proxy/token-refresher.js", () => ({ saveAccounts }));

const { runSetupWizard, setupSingleAccountWithAttempt } = await import("../cli/cmd-setup.js");

const PRIVATE_ACCESS = "sk-ant-oat01-PRIVATE-access";
const PRIVATE_REFRESH = "sk-ant-ort01-PRIVATE-refresh";
const PRIVATE_ACCOUNT = "PRIVATE-account-id";

/** The prompts a manual-token Anthropic setup asks, in order. */
function answerManualTokenSetup(): void {
  answers.selects = ["manual"];
  answers.passwords = [PRIVATE_ACCESS, PRIVATE_REFRESH];
  answers.inputs = [PRIVATE_ACCOUNT];
  // default expiry, then (wizard only) "configure Claude Code on this machine"
  answers.confirms = [true, false];
}

function stubValidation(response: { ok: boolean; status: number }): void {
  vi.stubGlobal("fetch", vi.fn(async () => response as Response));
}

function loggedLines(): string {
  return vi.mocked(console.log).mock.calls.map(call => call.join(" ")).join("\n");
}

beforeEach(() => {
  recorded.stages = [];
  recorded.stageFailures = [];
  recorded.results = [];
  recorded.failures = [];
  recorded.exceptions = [];
  saveAccounts.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("anthropic manual-token setup", () => {
  it("emits the full setup funnel through the facade", async () => {
    answerManualTokenSetup();
    stubValidation({ ok: true, status: 200 });

    await runSetupWizard({ addMode: true });

    expect(saveAccounts).toHaveBeenCalledTimes(1);
    expect(recorded.stages.map(stage => stage["stage"])).toEqual([
      "attempt_start",
      "credential_source_selection",
      "credential_read",
      "credential_parse",
      "token_validation",
      "persistence",
    ]);
    expect(recorded.stages[0]).toMatchObject({ provider: "anthropic", method: "manual_token" });
    const diagnosticIds = new Set(recorded.stages.map(stage => stage["diagnosticId"]));
    expect(diagnosticIds.size).toBe(1);
    expect(recorded.results).toEqual([expect.objectContaining({
      provider: "anthropic",
      method: "manual_token",
      result: "succeeded",
      diagnosticId: [...diagnosticIds][0],
    })]);
    expect(recorded.failures).toEqual([]);
    expect(recorded.stageFailures).toEqual([]);
    expect(recorded.exceptions).toEqual([]);

    const wire = JSON.stringify([recorded.stages, recorded.results]);
    expect(wire).not.toContain(PRIVATE_ACCESS);
    expect(wire).not.toContain(PRIVATE_REFRESH);
    expect(wire).not.toContain(PRIVATE_ACCOUNT);
  });

  it("keeps a rejected token out of the funnel and records the cancellation", async () => {
    answerManualTokenSetup();
    answers.confirms = [true, false]; // default expiry, then decline saving anyway
    stubValidation({ ok: false, status: 401 });

    const { account } = await setupSingleAccountWithAttempt(1);

    expect(account).toBeNull();
    expect(recorded.stages.map(stage => stage["stage"])).toEqual([
      "attempt_start",
      "credential_source_selection",
      "credential_read",
      "credential_parse",
    ]);
    expect(recorded.stageFailures).toEqual([expect.objectContaining({
      stage: "token_validation",
      reason: "unauthorized",
      httpStatusCode: 401,
    })]);
    // A 401 is an expected setup outcome: no error-tracking report, no ID printed.
    expect(recorded.exceptions).toEqual([]);
    expect(loggedLines()).not.toContain("Diagnostic ID");
    expect(recorded.results).toEqual([expect.objectContaining({ result: "cancelled" })]);
  });

  it("prints the diagnostic ID of an unexpected validation failure", async () => {
    answerManualTokenSetup();
    answers.confirms = [true, false];
    stubValidation({ ok: false, status: 302 });

    const { account, attempt } = await setupSingleAccountWithAttempt(1);

    expect(account).toBeNull();
    expect(recorded.stageFailures).toEqual([expect.objectContaining({
      stage: "token_validation",
      reason: "other",
      diagnosticId: attempt.diagnosticId,
    })]);
    expect(recorded.exceptions).toEqual([{
      context: {
        category: "setup",
        provider: "anthropic",
        setupStage: "token_validation",
        reason: "other",
      },
      diagnosticId: attempt.diagnosticId,
    }]);
    expect(loggedLines()).toContain(`Diagnostic ID: ${attempt.diagnosticId}`);
  });
});
