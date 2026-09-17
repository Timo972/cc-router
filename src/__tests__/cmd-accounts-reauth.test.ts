import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerAccounts } from "../cli/cmd-accounts.js";
import type { Account } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";

/** Mutable so each test can decide what `accounts list` reads from disk. */
let storedAnthropic: Account[] = [];
let storedOpenAI: Array<{
  id: string; accessToken?: string; expiresAt: number; enabled: boolean; authExpired?: boolean;
}> = [];

vi.mock("../config/manager.js", async importOriginal => ({
  ...await importOriginal<typeof import("../config/manager.js")>(),
  readConfig: () => ({ proxySecret: "router-secret" }),
  accountsFileExists: () => true,
  loadAccounts: () => storedAnthropic,
  loadXaiAccounts: () => [],
  loadOpenAIAccounts: () => storedOpenAI,
}));
vi.mock("../providers/xai/overview.js", async importOriginal => ({
  ...await importOriginal<typeof import("../providers/xai/overview.js")>(),
  mergeGrokIntoHealth: (data: unknown) => data,
}));

function makeStoredAccount(id: string, authExpired: boolean): Account {
  return {
    id,
    tokens: {
      accessToken: `sk-ant-oat01-${id}`,
      refreshToken: `sk-ant-ort01-${id}`,
      expiresAt: Date.now() - 60_000,
      scopes: ["user:inference"],
    },
    healthy: !authExpired,
    busy: false,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
    ...(authExpired ? { authExpired: true } : {}),
    rateLimits: { ...DEFAULT_RATE_LIMITS },
    enabled: true,
    sessionLimitPercent: 100,
    weeklyLimitPercent: 100,
  };
}

async function runListJson(): Promise<Array<Record<string, unknown>>> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const program = new Command();
  registerAccounts(program);
  await program.parseAsync(["accounts", "list", "--json"], { from: "user" });
  return JSON.parse(log.mock.calls.map(args => args.join(" ")).join("\n")) as Array<Record<string, unknown>>;
}

async function runList(): Promise<string> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const program = new Command();
  registerAccounts(program);
  await program.parseAsync(["accounts", "list"], { from: "user" });
  return log.mock.calls.map(args => args.join(" ")).join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
  storedAnthropic = [];
  storedOpenAI = [];
});

describe("accounts list — accounts needing re-authentication", () => {
  it("flags a live Anthropic account whose refresh token was terminally rejected", async () => {
    storedAnthropic = [makeStoredAccount("max-dead", true)];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      accounts: [{
        id: "max-dead", provider: "anthropic_subscription", healthy: false, busy: false,
        requestCount: 0, errorCount: 0, expiresInMs: -1_000, authExpired: true,
      }],
    }));

    const output = await runList();

    expect(output).toContain("re-auth required");
    // Replacement by id works now, so the hint must not tell the operator to
    // delete first: removing a lone Claude account is refused outright by the
    // running proxy, and deleting is destructive where replacing is not.
    expect(output).toContain("cc-router accounts add");
    expect(output).not.toContain("accounts remove");
  });

  it("flags a live OpenAI account quarantined by a permanent auth failure", async () => {
    storedOpenAI = [{ id: "team-dead", expiresAt: Date.now() - 60_000, enabled: true }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      accounts: [{
        id: "team-dead", provider: "openai_subscription", healthy: false, busy: false,
        requestCount: 0, errorCount: 6, expiresInMs: -1_000,
        authState: "quarantined", authFailure: "permanent",
      }],
    }));

    const output = await runList();

    expect(output).toContain("re-auth required");
  });

  it("names the OpenAI sign-in command for a dead OpenAI account, not the Claude one", async () => {
    storedOpenAI = [{ id: "team-dead", expiresAt: Date.now() - 60_000, enabled: true }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      accounts: [{
        id: "team-dead", provider: "openai_subscription", healthy: false, busy: false,
        requestCount: 0, errorCount: 6, expiresInMs: -1_000,
        authState: "quarantined", authFailure: "permanent",
      }],
    }));

    const output = await runList();

    // `accounts add` runs the Claude Max flow. Pointing an OpenAI operator at
    // it would re-add the id under the wrong provider entirely.
    expect(output).toContain("cc-router accounts login-openai");
    expect(output).not.toMatch(/cc-router accounts add\b/);
  });

  it("names each provider's own command when both need re-auth", async () => {
    storedAnthropic = [makeStoredAccount("max-dead", true)];
    storedOpenAI = [{ id: "team-dead", expiresAt: Date.now() - 60_000, enabled: true }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      accounts: [
        {
          id: "max-dead", provider: "anthropic_subscription", healthy: false, busy: false,
          requestCount: 0, errorCount: 0, expiresInMs: -1_000, authExpired: true,
        },
        {
          id: "team-dead", provider: "openai_subscription", healthy: false, busy: false,
          requestCount: 0, errorCount: 6, expiresInMs: -1_000,
          authState: "quarantined", authFailure: "permanent",
        },
      ],
    }));

    const output = await runList();

    expect(output).toContain("cc-router accounts add");
    expect(output).toContain("cc-router accounts login-openai");
  });

  it("leaves a merely-stale live account reported as unhealthy, not as needing re-auth", async () => {
    storedAnthropic = [makeStoredAccount("max-stale", false)];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      accounts: [{
        id: "max-stale", provider: "anthropic_subscription", healthy: false, busy: false,
        requestCount: 0, errorCount: 0, expiresInMs: -1_000,
      }],
    }));

    const output = await runList();

    expect(output).toContain("unhealthy");
    expect(output).not.toContain("re-auth required");
  });

  it("flags a stored Anthropic account when the proxy is not running", async () => {
    storedAnthropic = [makeStoredAccount("max-dead", true)];
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const output = await runList();

    expect(output).toContain("re-auth required");
  });

  it("flags a stored OpenAI account whose terminal rejection was persisted", async () => {
    storedOpenAI = [{
      id: "team-dead", accessToken: "sk-openai-dead",
      expiresAt: Date.now() - 60_000, enabled: true, authExpired: true,
    }];
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const output = await runList();

    expect(output).toContain("re-auth required");
    expect(output).toContain("team-dead");
  });

  it("reports authExpired in --json for a stored Claude account when the proxy is down", async () => {
    storedAnthropic = [makeStoredAccount("max-dead", true), makeStoredAccount("max-stale", false)];
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const accounts = await runListJson();

    // Without this a JSON consumer sees two identically-expired accounts and
    // cannot tell which one will never recover on its own.
    expect(accounts.find(a => a.id === "max-dead")).toMatchObject({ authExpired: true });
    expect(accounts.find(a => a.id === "max-stale")).not.toHaveProperty("authExpired");
  });

  it("carries the terminal auth state through --json while the proxy is running", async () => {
    storedAnthropic = [makeStoredAccount("max-dead", true)];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      accounts: [{
        id: "max-dead", provider: "anthropic_subscription", healthy: false, busy: false,
        requestCount: 0, errorCount: 0, expiresInMs: -1_000, authExpired: true,
      }],
    }));

    const accounts = await runListJson();

    expect(accounts.find(a => a.id === "max-dead")).toMatchObject({ authExpired: true });
  });

  it("reports authExpired in --json for a stored OpenAI account when the proxy is down", async () => {
    storedOpenAI = [{
      id: "team-dead", accessToken: "sk-openai-dead",
      expiresAt: Date.now() - 60_000, enabled: true, authExpired: true,
    }];
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const accounts = await runListJson();

    expect(accounts.find(a => a.id === "team-dead")).toMatchObject({
      provider: "openai_subscription",
      authExpired: true,
    });
  });

  it("does not flag a stored account that only has an expired access token", async () => {
    storedAnthropic = [makeStoredAccount("max-stale", false)];
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const output = await runList();

    expect(output).not.toContain("re-auth required");
  });
});
