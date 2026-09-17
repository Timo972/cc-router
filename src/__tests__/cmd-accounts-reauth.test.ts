import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerAccounts } from "../cli/cmd-accounts.js";
import type { Account } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";

/** Mutable so each test can decide what `accounts list` reads from disk. */
let storedAnthropic: Account[] = [];
let storedOpenAI: Array<{ id: string; expiresAt: number; enabled: boolean }> = [];

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
    expect(output).toContain("cc-router accounts remove");
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

  it("does not flag a stored account that only has an expired access token", async () => {
    storedAnthropic = [makeStoredAccount("max-stale", false)];
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const output = await runList();

    expect(output).not.toContain("re-auth required");
  });
});
