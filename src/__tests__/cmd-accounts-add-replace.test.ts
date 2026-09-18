import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerAccounts } from "../cli/cmd-accounts.js";
import type { Account } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";

/**
 * `accounts add claude` is the Claude import path — the one an operator
 * reaches for after a refresh token is rejected permanently. It has to ask the
 * running proxy to *replace* the existing id, or the proxy answers 409, the
 * CLI throws, and the refresh token the OAuth login just minted is discarded.
 */

const reauthed: Account = {
  id: "max-dead",
  tokens: {
    accessToken: "sk-ant-oat01-fresh",
    refreshToken: "sk-ant-ort01-fresh",
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    scopes: ["user:inference", "user:profile"],
  },
  healthy: true,
  busy: false,
  requestCount: 0,
  errorCount: 0,
  lastUsed: 0,
  lastRefresh: 0,
  consecutiveErrors: 0,
  rateLimits: { ...DEFAULT_RATE_LIMITS },
  enabled: true,
  sessionLimitPercent: 100,
  weeklyLimitPercent: 100,
};

vi.mock("../cli/account-flows.js", () => ({
  collectClaudeAccount: async () => ({
    account: reauthed,
    attempt: {
      stageCompleted: () => {},
      succeeded: () => {},
      failed: () => {},
    },
  }),
  accountToRecord: (a: Account) => ({
    id: a.id,
    provider: "anthropic_subscription" as const,
    accessToken: a.tokens.accessToken,
    refreshToken: a.tokens.refreshToken,
    expiresAt: a.tokens.expiresAt,
    scopes: a.tokens.scopes,
  }),
}));

vi.mock("../config/manager.js", async importOriginal => ({
  ...await importOriginal<typeof import("../config/manager.js")>(),
  readConfig: () => ({ proxySecret: "router-secret" }),
  accountsFileExists: () => true,
  loadAccounts: () => [reauthed],
  serialize: (accounts: Account[]) => accounts.map(a => ({
    id: a.id,
    provider: "anthropic_subscription" as const,
    accessToken: a.tokens.accessToken,
    refreshToken: a.tokens.refreshToken,
    expiresAt: a.tokens.expiresAt,
    scopes: a.tokens.scopes,
    enabled: a.enabled,
    sessionLimitPercent: a.sessionLimitPercent,
    weeklyLimitPercent: a.weeklyLimitPercent,
  })),
}));

afterEach(() => vi.restoreAllMocks());

describe("accounts add claude — re-authenticating an existing id", () => {
  it("asks the running proxy to replace the account rather than taking a 409", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ account: { id: "max-dead" } }, { status: 200 }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerAccounts(program);
    await program.parseAsync(["accounts", "add", "claude"], { from: "user" });

    const post = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/cc-router/accounts") && (init as RequestInit)?.method === "POST",
    );
    expect(post, "expected a POST to the live accounts endpoint").toBeDefined();
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(body).toMatchObject({ id: "max-dead", replace: true });
  });
});
