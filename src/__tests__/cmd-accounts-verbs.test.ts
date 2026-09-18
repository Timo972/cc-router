import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const flows = vi.hoisted(() => ({
  collectClaudeAccount: vi.fn(), loginOpenAIAccount: vi.fn(), importOpenAIAccount: vi.fn(),
  loginGrokAccount: vi.fn(), importGrokAccount: vi.fn(), collectReauthRecord: vi.fn(),
  accountToRecord: (a: any) => ({ id: a.id, provider: "anthropic_subscription", accessToken: a.tokens.accessToken, refreshToken: a.tokens.refreshToken, expiresAt: a.tokens.expiresAt, scopes: a.tokens.scopes }),
}));
vi.mock("../cli/account-flows.js", () => flows);
const prompts = vi.hoisted(() => ({ select: vi.fn(), input: vi.fn(), confirm: vi.fn(), password: vi.fn() }));
vi.mock("@inquirer/prompts", () => prompts);
/** Mutable so a test can decide what the commands read from disk. */
const stored = vi.hoisted(() => ({ anthropic: [] as any[], openai: [] as any[], xai: [] as any[] }));
vi.mock("../config/manager.js", async importOriginal => ({
  ...await importOriginal<typeof import("../config/manager.js")>(),
  readConfig: () => ({}),
  accountsFileExists: () => true,
  loadAccounts: () => stored.anthropic,
  loadOpenAIAccounts: () => stored.openai,
  loadXaiAccounts: () => stored.xai,
  upsertAccountRecord: vi.fn(),
}));
// `saveAccounts` writes ~/.cc-router/accounts.json for real: the Claude add
// path reaches it whenever no proxy answers, which is exactly this file's
// situation. Stubbed so the suite cannot overwrite the developer's accounts.
vi.mock("../proxy/token-refresher.js", async importOriginal => ({
  ...await importOriginal<typeof import("../proxy/token-refresher.js")>(),
  saveAccounts: vi.fn(),
}));
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no proxy"); }));

import { registerAccounts, resolveReauthTarget, parseProviderArg } from "../cli/cmd-accounts.js";

const attempt = { stageCompleted: vi.fn(), succeeded: vi.fn(), failed: vi.fn(), cancelled: vi.fn() };
function program() { const p = new Command(); p.exitOverride(); registerAccounts(p); return p; }

beforeEach(() => {
  vi.clearAllMocks();
  stored.anthropic = [];
  stored.openai = [];
  stored.xai = [];
});
afterEach(() => { vi.restoreAllMocks(); });

describe("accounts login", () => {
  it("claude: runs the login picker with the id fixed by --id", async () => {
    flows.collectClaudeAccount.mockResolvedValue({ account: { id: "x", tokens: { accessToken: "a", expiresAt: 1, scopes: [] } }, attempt });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program().parseAsync(["accounts", "login", "claude", "--id", "x", "--email", "me@example.com"], { from: "user" });
    expect(flows.collectClaudeAccount).toHaveBeenCalledWith(expect.objectContaining({ fixedId: "x", email: "me@example.com", offer: "login" }));
  });
  it("claude --long-lived pins the setup-token method", async () => {
    flows.collectClaudeAccount.mockResolvedValue({ account: null, attempt });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program().parseAsync(["accounts", "login", "claude", "--long-lived"], { from: "user" });
    expect(flows.collectClaudeAccount).toHaveBeenCalledWith(expect.objectContaining({ method: "setup_token" }));
  });
  it("openai: forwards --id and --email to the device login", async () => {
    flows.loginOpenAIAccount.mockResolvedValue({ record: { id: "o", provider: "openai_subscription", accessToken: "a", refreshToken: "r", expiresAt: 1, scopes: [] }, attempt });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program().parseAsync(["accounts", "login", "openai", "--id", "o", "--email", "me@example.com"], { from: "user" });
    expect(flows.loginOpenAIAccount).toHaveBeenCalledWith({ accountId: "o", email: "me@example.com" });
  });
  it("prompts for the provider when omitted", async () => {
    prompts.select.mockResolvedValue("grok");
    flows.loginGrokAccount.mockResolvedValue({ id: "grok", provider: "xai_subscription", accessToken: "a", refreshToken: "r", expiresAt: 1, scopes: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program().parseAsync(["accounts", "login"], { from: "user" });
    expect(flows.loginGrokAccount).toHaveBeenCalled();
  });
  it("rejects an unknown provider", () => {
    expect(() => parseProviderArg("bing")).toThrow(/claude, openai or grok/);
  });
});

describe("accounts add", () => {
  it("claude: offers import methods only", async () => {
    flows.collectClaudeAccount.mockResolvedValue({ account: null, attempt });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program().parseAsync(["accounts", "add", "claude"], { from: "user" });
    expect(flows.collectClaudeAccount).toHaveBeenCalledWith(expect.objectContaining({ offer: "import" }));
  });
  it("openai: imports pasted credentials rather than signing in", async () => {
    flows.importOpenAIAccount.mockResolvedValue({ record: { id: "o", provider: "openai_subscription", accessToken: "a", refreshToken: "r", expiresAt: 1, scopes: [] }, attempt });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program().parseAsync(["accounts", "add", "openai", "--id", "o"], { from: "user" });
    expect(flows.importOpenAIAccount).toHaveBeenCalledWith({ accountId: "o" });
    expect(flows.loginOpenAIAccount).not.toHaveBeenCalled();
  });
});

describe("accounts reauth", () => {
  /** `process.exit` is a `never`, so the spy throws to stop the action there. */
  function stubExit() {
    return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  }

  it("re-signs a stored Claude account in under its own id", async () => {
    stored.anthropic = [{ id: "max-dead" }];
    flows.collectReauthRecord.mockResolvedValue({
      record: { id: "max-dead", provider: "anthropic_subscription", accessToken: "a", refreshToken: "r", expiresAt: 1, scopes: [] },
      attempt,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await program().parseAsync(["accounts", "reauth", "max-dead"], { from: "user" });

    expect(flows.collectReauthRecord).toHaveBeenCalledWith(
      { id: "max-dead", provider: "anthropic_subscription" },
      expect.objectContaining({ longLived: undefined }),
    );
  });

  it("points a Grok id at grok login instead of re-authenticating it", async () => {
    stored.xai = [{ id: "grok" }];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = stubExit();

    await expect(program().parseAsync(["accounts", "reauth", "grok"], { from: "user" }))
      .rejects.toThrow("exit:1");

    const output = log.mock.calls.map(args => args.join(" ")).join("\n");
    expect(output).toContain("grok login");
    expect(output).toContain("cc-router accounts add grok");
    expect(exit).toHaveBeenCalledWith(1);
    expect(flows.collectReauthRecord).not.toHaveBeenCalled();
  });

  it("lists the available ids when the id is unknown", async () => {
    stored.anthropic = [{ id: "max-1" }];
    stored.openai = [{ id: "plus-1" }];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = stubExit();

    await expect(program().parseAsync(["accounts", "reauth", "nope"], { from: "user" }))
      .rejects.toThrow("exit:1");

    const output = log.mock.calls.map(args => args.join(" ")).join("\n");
    expect(output).toContain('"nope" not found');
    expect(output).toContain("max-1");
    expect(output).toContain("plus-1");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("resolveReauthTarget", () => {
  it("prefers the live pool and carries the cached email", () => {
    const target = resolveReauthTarget("dead", [{ id: "dead", provider: "openai_subscription", accountInfo: { email: "me@example.com" } }], { anthropic: [], openai: [], xai: [] });
    expect(target).toEqual({ id: "dead", provider: "openai_subscription", email: "me@example.com" });
  });
  it("falls back to stored records without an email", () => {
    const target = resolveReauthTarget("stored", null, { anthropic: [{ id: "stored" } as any], openai: [], xai: [] });
    expect(target).toEqual({ id: "stored", provider: "anthropic_subscription" });
  });
  it("marks grok accounts", () => {
    expect(resolveReauthTarget("g", null, { anthropic: [], openai: [], xai: [{ id: "g" } as any] })).toEqual({ grok: true });
  });
  it("returns null for unknown ids", () => {
    expect(resolveReauthTarget("nope", null, { anthropic: [], openai: [], xai: [] })).toBeNull();
  });
});
