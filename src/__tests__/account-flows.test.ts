import { beforeEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({ select: vi.fn(), input: vi.fn(), confirm: vi.fn(), password: vi.fn() }));
vi.mock("@inquirer/prompts", () => prompts);
const cli = vi.hoisted(() => ({ loginWithClaudeCli: vi.fn(), createLongLivedTokenWithClaudeCli: vi.fn(), LONG_LIVED_TOKEN_TTL_MS: 365 * 86_400_000 }));
vi.mock("../providers/anthropic/claude-cli.js", () => cli);
vi.mock("../utils/token-validator.js", () => ({ validateToken: async () => ({ valid: true }) }));
vi.mock("../telemetry/setup-diagnostics.js", async importOriginal => ({
  ...await importOriginal<typeof import("../telemetry/setup-diagnostics.js")>(),
  withSetupTelemetryFlush: (fn: () => Promise<unknown>) => fn(),
}));

import { collectClaudeAccount, collectReauthRecord } from "../cli/account-flows.js";

beforeEach(() => { vi.clearAllMocks(); });

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

  it("fixedId skips the id prompt", async () => {
    cli.loginWithClaudeCli.mockResolvedValue({ accessToken: "sk-ant-oat01-b", refreshToken: "sk-ant-ort01-b", expiresAt: 5, scopes: [] });
    const { account } = await collectClaudeAccount({ index: 1, method: "cli_login", fixedId: "max-dead" });
    expect(prompts.input).not.toHaveBeenCalled();
    expect(account?.id).toBe("max-dead");
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
});
