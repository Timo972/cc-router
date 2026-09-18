import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeMethod } from "../cli/account-flows.js";
import type { SetupMethod } from "../telemetry/contracts.js";

const prompts = vi.hoisted(() => ({ select: vi.fn(), input: vi.fn(), confirm: vi.fn(), password: vi.fn() }));
vi.mock("@inquirer/prompts", () => prompts);
const cli = vi.hoisted(() => ({ loginWithClaudeCli: vi.fn(), createLongLivedTokenWithClaudeCli: vi.fn(), LONG_LIVED_TOKEN_TTL_MS: 365 * 86_400_000 }));
vi.mock("../providers/anthropic/claude-cli.js", () => cli);

/** Mutable so one test can make the token look rejected. */
const validation = vi.hoisted(() => ({ result: { valid: true } as unknown }));
vi.mock("../utils/token-validator.js", () => ({ validateToken: async () => validation.result }));

/**
 * The picker's import methods must not shell out to `security` or read the
 * developer's own ~/.claude/.credentials.json, and the Keychain choice has to
 * be present regardless of which machine runs the suite.
 */
const extraction = vi.hoisted(() => ({ keychain: vi.fn(), credentials: vi.fn() }));
vi.mock("../utils/token-extractor.js", async importOriginal => ({
  ...await importOriginal<typeof import("../utils/token-extractor.js")>(),
  extractFromKeychainDetailed: extraction.keychain,
  extractFromCredentialsFileDetailed: extraction.credentials,
}));
vi.mock("../utils/platform.js", async importOriginal => ({
  ...await importOriginal<typeof import("../utils/platform.js")>(),
  isMacos: () => true,
}));

const openai = vi.hoisted(() => ({ loginOpenAIWithDeviceCode: vi.fn() }));
vi.mock("../providers/openai/device-oauth.js", async importOriginal => ({
  ...await importOriginal<typeof import("../providers/openai/device-oauth.js")>(),
  loginOpenAIWithDeviceCode: openai.loginOpenAIWithDeviceCode,
}));

// The attempt itself stays real — only its construction is observed, so the
// method name that reaches telemetry is the one the flow actually chose.
const telemetry = vi.hoisted(() => ({ createSetupAttempt: vi.fn() }));
vi.mock("../telemetry/setup-diagnostics.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../telemetry/setup-diagnostics.js")>();
  return {
    ...actual,
    withSetupTelemetryFlush: (fn: () => Promise<unknown>) => fn(),
    createSetupAttempt: (input: Parameters<typeof actual.createSetupAttempt>[0]) => {
      telemetry.createSetupAttempt(input);
      return actual.createSetupAttempt(input);
    },
  };
});

import { collectClaudeAccount, collectReauthRecord } from "../cli/account-flows.js";
import { SetupDiagnosticError } from "../telemetry/setup-diagnostics.js";

const TOKENS = {
  accessToken: "sk-ant-oat01-extracted",
  refreshToken: "sk-ant-ort01-extracted",
  expiresAt: Date.now() + 3_600_000,
  scopes: ["user:inference", "user:profile"],
};

/** The `choices` the picker was offered, in the order it offered them. */
function offeredMethods(): ClaudeMethod[] {
  const call = prompts.select.mock.calls[0]?.[0] as { choices: Array<{ value: ClaudeMethod }> };
  return call.choices.map(choice => choice.value);
}

beforeEach(() => {
  vi.clearAllMocks();
  validation.result = { valid: true };
  extraction.keychain.mockResolvedValue({ ok: true, tokens: { ...TOKENS } });
  extraction.credentials.mockReturnValue({ ok: true, tokens: { ...TOKENS } });
});

describe("collectClaudeAccount", () => {
  it("cli_login passes the email through and keeps the returned refresh token", async () => {
    cli.loginWithClaudeCli.mockResolvedValue({ accessToken: "sk-ant-oat01-a", refreshToken: "sk-ant-ort01-a", expiresAt: 5, scopes: ["user:inference", "user:profile"] });
    prompts.input.mockResolvedValue("max-account-3");
    const { account } = await collectClaudeAccount({ index: 3, method: "cli_login", email: "me@example.com" });
    expect(cli.loginWithClaudeCli).toHaveBeenCalledWith({ email: "me@example.com" }, undefined);
    expect(account?.id).toBe("max-account-3");
    expect(account?.tokens.refreshToken).toBe("sk-ant-ort01-a");
  });

  it("setup_token stores an inference-only token with a one-year expiry and no refresh token", async () => {
    cli.createLongLivedTokenWithClaudeCli.mockResolvedValue({ accessToken: "sk-ant-oat01-long" });
    prompts.input.mockResolvedValue("long");
    prompts.confirm.mockResolvedValue(true); // keep default expiry
    const before = Date.now();
    const { account } = await collectClaudeAccount({ index: 1, method: "setup_token" });
    expect(account?.tokens).toMatchObject({ accessToken: "sk-ant-oat01-long", refreshToken: undefined, scopes: ["user:inference"] });
    expect(account!.tokens.expiresAt).toBeGreaterThanOrEqual(before + 365 * 86_400_000 - 1);
  });

  it("setup_token falls back to a paste prompt when nothing was captured", async () => {
    cli.createLongLivedTokenWithClaudeCli.mockResolvedValue(null);
    prompts.password.mockResolvedValue("sk-ant-oat01-pasted");
    prompts.input.mockResolvedValue("long");
    prompts.confirm.mockResolvedValue(true);
    const { account } = await collectClaudeAccount({ index: 1, method: "setup_token" });
    expect(account?.tokens.accessToken).toBe("sk-ant-oat01-pasted");
  });

  it("setup_token takes a typed expiry when the operator declines the one-year default", async () => {
    cli.createLongLivedTokenWithClaudeCli.mockResolvedValue({ accessToken: "sk-ant-oat01-long" });
    prompts.confirm.mockResolvedValue(false);
    prompts.input.mockResolvedValue("2027-01-02T03:04:05.000Z");
    const { account } = await collectClaudeAccount({ index: 1, method: "setup_token", fixedId: "long" });
    expect(account?.tokens.expiresAt).toBe(Date.parse("2027-01-02T03:04:05.000Z"));
  });

  it("fixedId skips the id prompt", async () => {
    cli.loginWithClaudeCli.mockResolvedValue({ accessToken: "sk-ant-oat01-b", refreshToken: "sk-ant-ort01-b", expiresAt: 5, scopes: [] });
    const { account } = await collectClaudeAccount({ index: 1, method: "cli_login", fixedId: "max-dead" });
    expect(prompts.input).not.toHaveBeenCalled();
    expect(account?.id).toBe("max-dead");
  });
});

/**
 * A cancelled browser sign-in is one account the operator chose not to add, not
 * a reason to lose the accounts collected before it — the wizard persists only
 * after its loop, so a throw here would take the whole run down with it.
 */
describe("collectClaudeAccount — an expected sign-in failure skips the account", () => {
  beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("cli_login: a cancelled login resolves to no account instead of throwing", async () => {
    cli.loginWithClaudeCli.mockRejectedValue(new SetupDiagnosticError(
      "claude auth login was cancelled or failed",
      { stage: "credential_read", reason: "user_cancelled", expected: true },
    ));

    const { account } = await collectClaudeAccount({ index: 1, method: "cli_login", fixedId: "max-1" });

    expect(account).toBeNull();
  });

  it("setup_token: a missing claude CLI resolves to no account instead of throwing", async () => {
    cli.createLongLivedTokenWithClaudeCli.mockRejectedValue(new SetupDiagnosticError(
      "Claude Code CLI not found on PATH.",
      { stage: "credential_read", reason: "not_found", expected: true },
    ));

    const { account } = await collectClaudeAccount({ index: 1, method: "setup_token", fixedId: "max-1" });

    expect(account).toBeNull();
  });

  it("prints the reason in the clear and never a diagnostic ID", async () => {
    cli.loginWithClaudeCli.mockRejectedValue(new SetupDiagnosticError(
      "claude auth login was cancelled or failed",
      { stage: "credential_read", reason: "user_cancelled", expected: true },
    ));

    await collectClaudeAccount({ index: 1, method: "cli_login", fixedId: "max-1" });

    const printed = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(call => String(call[0]))
      .join("\n");
    expect(printed).toContain("claude auth login was cancelled or failed");
    expect(printed).not.toContain("Diagnostic ID");
  });

  it("an unexpected failure still propagates", async () => {
    cli.loginWithClaudeCli.mockRejectedValue(new Error("socket hang up"));

    await expect(collectClaudeAccount({ index: 1, method: "cli_login", fixedId: "max-1" }))
      .rejects.toThrow("socket hang up");
  });
});

describe("collectClaudeAccount — which methods the picker offers", () => {
  it('offer "login" lists only the two browser methods, sign-in first', async () => {
    prompts.select.mockResolvedValue("cli_login");
    cli.loginWithClaudeCli.mockResolvedValue({ ...TOKENS });
    await collectClaudeAccount({ index: 1, fixedId: "x", offer: "login" });
    expect(offeredMethods()).toEqual(["cli_login", "setup_token"]);
  });

  it('offer "import" lists only the three ways to reuse an existing login', async () => {
    prompts.select.mockResolvedValue("manual");
    prompts.password.mockResolvedValue("sk-ant-oat01-pasted");
    prompts.confirm.mockResolvedValue(true);
    await collectClaudeAccount({ index: 1, fixedId: "x", offer: "import" });
    expect(offeredMethods()).toEqual(["keychain", "credentials", "manual"]);
  });

  it("the default picker leads with the login methods and follows with the imports", async () => {
    prompts.select.mockResolvedValue("cli_login");
    cli.loginWithClaudeCli.mockResolvedValue({ ...TOKENS });
    await collectClaudeAccount({ index: 1, fixedId: "x" });
    expect(offeredMethods()).toEqual(["cli_login", "setup_token", "keychain", "credentials", "manual"]);
  });
});

describe("collectClaudeAccount — telemetry method names", () => {
  const MAPPING: Array<[ClaudeMethod, SetupMethod]> = [
    ["cli_login", "claude_cli_login"],
    ["setup_token", "claude_setup_token"],
    ["keychain", "macos_keychain"],
    ["credentials", "claude_credentials_file"],
    ["manual", "manual_token"],
  ];

  it.each(MAPPING)("reports %s as %s", async (method, expected) => {
    cli.loginWithClaudeCli.mockResolvedValue({ ...TOKENS });
    cli.createLongLivedTokenWithClaudeCli.mockResolvedValue({ accessToken: "sk-ant-oat01-long" });
    prompts.password.mockResolvedValue("sk-ant-oat01-pasted");
    prompts.confirm.mockResolvedValue(true);

    const { account } = await collectClaudeAccount({ index: 1, method, fixedId: "mapped" });

    expect(account).not.toBeNull();
    expect(telemetry.createSetupAttempt).toHaveBeenCalledWith({ provider: "anthropic", method: expected });
  });
});

describe("collectReauthRecord", () => {
  it("re-signs a Claude account under the same id with the email prefilled", async () => {
    prompts.select.mockResolvedValue("cli_login");
    cli.loginWithClaudeCli.mockResolvedValue({ accessToken: "sk-ant-oat01-c", refreshToken: "sk-ant-ort01-c", expiresAt: 5, scopes: [] });
    const result = await collectReauthRecord({ id: "max-dead", provider: "anthropic_subscription", email: "me@example.com" });
    expect(result?.record).toMatchObject({ id: "max-dead", provider: "anthropic_subscription", accessToken: "sk-ant-oat01-c" });
    expect(cli.loginWithClaudeCli).toHaveBeenCalledWith({ email: "me@example.com" }, undefined);
  });

  it("longLived pins the setup-token method, so no browser login runs and no refresh token is stored", async () => {
    cli.createLongLivedTokenWithClaudeCli.mockResolvedValue({ accessToken: "sk-ant-oat01-long" });
    prompts.confirm.mockResolvedValue(true);

    const result = await collectReauthRecord(
      { id: "max-dead", provider: "anthropic_subscription" },
      { longLived: true },
    );

    expect(cli.createLongLivedTokenWithClaudeCli).toHaveBeenCalledTimes(1);
    expect(cli.loginWithClaudeCli).not.toHaveBeenCalled();
    expect(prompts.select).not.toHaveBeenCalled();
    expect(result?.record).toMatchObject({ id: "max-dead", accessToken: "sk-ant-oat01-long", scopes: ["user:inference"] });
    expect(result?.record.refreshToken).toBeUndefined();
  });

  it("an openai target signs in through the device flow with the id fixed and the email as the login hint", async () => {
    openai.loginOpenAIWithDeviceCode.mockResolvedValue({
      id: "codex-dead",
      provider: "openai_subscription",
      accessToken: "oai-access",
      refreshToken: "oai-refresh",
      expiresAt: 42,
      scopes: ["openid"],
      enabled: true,
    });

    const result = await collectReauthRecord({
      id: "codex-dead",
      provider: "openai_subscription",
      email: "me@example.com",
    });

    expect(prompts.input).not.toHaveBeenCalled();
    expect(openai.loginOpenAIWithDeviceCode).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "codex-dead",
      loginHint: "me@example.com",
    }));
    expect(result?.record).toMatchObject({ id: "codex-dead", provider: "openai_subscription", accessToken: "oai-access" });
  });

  it("returns null when the operator declines to keep an account whose token was rejected", async () => {
    prompts.select.mockResolvedValue("cli_login");
    cli.loginWithClaudeCli.mockResolvedValue({ ...TOKENS });
    validation.result = {
      valid: false,
      reason: "unauthorized",
      diagnostic: new SetupDiagnosticError("rejected", {
        stage: "token_validation",
        reason: "unauthorized",
        expected: true,
        httpStatusCode: 401,
      }),
    };
    prompts.confirm.mockResolvedValue(false); // "Save this account anyway?"

    const result = await collectReauthRecord({ id: "max-dead", provider: "anthropic_subscription" });

    expect(result).toBeNull();
  });
});
