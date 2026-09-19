import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Command } from "commander";

const upsertAccountRecord = vi.hoisted(() => vi.fn(() => {
  throw new Error("offline account writer must not run while daemon accepts the account");
}));
const imported = {
  id: "grok-imported",
  provider: "xai_subscription" as const,
  accessToken: "import-access",
  refreshToken: "import-refresh",
  expiresAt: 1_900_000_000_000,
  scopes: [],
};
const loggedIn = {
  ...imported,
  id: "grok-login",
  accessToken: "login-access",
  refreshToken: "login-refresh",
};

vi.mock("../config/manager.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../config/manager.js")>()),
  upsertAccountRecord,
  loadXaiAccounts: () => [],
  readConfig: () => ({ proxySecret: "router-secret" }),
}));
vi.mock("../providers/xai/import-auth.js", () => ({
  importGrokCliAuth: () => imported,
}));
vi.mock("../providers/xai/device-oauth.js", () => ({
  loginXaiWithDeviceCode: async () => loggedIn,
}));
vi.mock("@inquirer/prompts", async importOriginal => ({
  ...(await importOriginal<typeof import("@inquirer/prompts")>()),
  input: vi.fn(async (options: { default?: string }) => options.default ?? "grok"),
}));

const { registerAccounts } = await import("../cli/cmd-accounts.js");

beforeEach(() => {
  upsertAccountRecord.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["add grok", imported],
  ["login grok", loggedIn],
] as const)("%s sends the acquired account to the running daemon", async (command, record) => {
  const fetch = vi.fn(async () => Response.json({ account: { id: record.id } }, { status: 201 }));
  vi.stubGlobal("fetch", fetch);
  const program = new Command();
  registerAccounts(program);

  await program.parseAsync(["accounts", ...command.split(" ")], { from: "user" });

  expect(fetch).toHaveBeenCalledWith(
    "http://localhost:3456/cc-router/accounts",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer router-secret",
        "content-type": "application/json",
      }),
      body: JSON.stringify({ ...record, replace: true }),
    }),
  );
  expect(upsertAccountRecord).not.toHaveBeenCalled();
});
