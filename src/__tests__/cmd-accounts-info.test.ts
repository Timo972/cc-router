import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerAccounts } from "../cli/cmd-accounts.js";

vi.mock("../config/manager.js", async importOriginal => ({
  ...await importOriginal<typeof import("../config/manager.js")>(),
  readConfig: () => ({ proxySecret: "router-secret" }),
  accountsFileExists: () => true,
  loadAccounts: () => [],
  loadXaiAccounts: () => [],
  loadOpenAIAccounts: () => [{ id: "work", expiresAt: 1_900_000_000_000, enabled: true }],
}));
vi.mock("../providers/xai/overview.js", async importOriginal => ({
  ...await importOriginal<typeof import("../providers/xai/overview.js")>(),
  mergeGrokIntoHealth: (data: unknown) => data,
}));

afterEach(() => vi.restoreAllMocks());

describe("accounts list identity", () => {
  it.each([false, true])("reads private metadata through authenticated account listing (json=%s)", async json => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      accounts: [{
        id: "work", provider: "openai_subscription", healthy: true, busy: false,
        requestCount: 0, errorCount: 0, expiresInMs: 60_000,
        accountInfo: {
          email: "test@example.com", workspaceName: "Example", accountType: "workspace",
          plan: "business", fetchStatus: "fresh", fetchedAt: 123, accessToken: "secret-upstream",
        },
      }],
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerAccounts(program);
    await program.parseAsync(["accounts", "list", ...(json ? ["--json"] : [])], { from: "user" });
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/cc-router\/accounts$/), expect.objectContaining({
      headers: { authorization: "Bearer router-secret" },
    }));
    const output = log.mock.calls.map(args => args.join(" ")).join("\n");
    expect(output).toContain("test@example.com");
    expect(output).toContain("Example");
    expect(output).not.toContain("secret-upstream");
    if (json) expect(JSON.parse(output)[0].accountInfo.accountType).toBe("workspace");
  });
});
