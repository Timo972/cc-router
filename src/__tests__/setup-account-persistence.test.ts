import { afterEach, describe, expect, it, vi } from "vitest";
import { persistSetupAccountsRuntimeAware } from "../cli/cmd-setup.js";
import { saveAccounts } from "../config/manager.js";
import type { Account } from "../proxy/types.js";

// Setup's default wiring reaches the real daemon and the real accounts file.
// Pin both: `saveAccounts` would otherwise write ~/.cc-router/accounts.json.
vi.mock("../config/manager.js", async importOriginal => ({
  ...await importOriginal<typeof import("../config/manager.js")>(),
  readConfig: () => ({ proxySecret: "router-secret" }),
  saveAccounts: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

function account(id: string): Account {
  return {
    id,
    tokens: {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 60_000,
      scopes: ["user:inference"],
    },
    healthy: true,
    busy: false,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
    rateLimits: {
      fiveHour: { utilization: 0, resetAt: 0 },
      sevenDay: { utilization: 0, resetAt: 0 },
      sevenDaySonnet: { utilization: 0, resetAt: 0 },
      sevenDayOpus: { utilization: 0, resetAt: 0 },
      sevenDayOAuthApps: { utilization: 0, resetAt: 0 },
      lastUpdated: 0,
    },
    enabled: true,
    sessionLimitPercent: 100,
    weeklyLimitPercent: 100,
  };
}

describe("setup account persistence", () => {
  it("adds every newly acquired account through the running daemon", async () => {
    const newAccounts = [account("one"), account("two")];
    const tryAddLive = vi.fn(async () => true);
    const saveStored = vi.fn();

    await expect(persistSetupAccountsRuntimeAware(
      { newAccounts, merged: newAccounts, replaceExisting: false },
      { isLive: async () => true, tryAddLive, saveStored },
    )).resolves.toBe("live");

    expect(tryAddLive.mock.calls.map(([record]) => record.id)).toEqual(["one", "two"]);
    expect(saveStored).not.toHaveBeenCalled();
  });

  it("publishes the complete merged inventory once when the daemon is stopped", async () => {
    const existing = account("existing");
    const newAccounts = [account("one"), account("two")];
    const merged = [existing, ...newAccounts];
    const tryAddLive = vi.fn(async () => false);
    const saveStored = vi.fn();

    await expect(persistSetupAccountsRuntimeAware(
      { newAccounts, merged, replaceExisting: false },
      { isLive: async () => false, tryAddLive, saveStored },
    )).resolves.toBe("stored");

    expect(tryAddLive).toHaveBeenCalledTimes(1);
    expect(saveStored).toHaveBeenCalledOnce();
    expect(saveStored).toHaveBeenCalledWith(merged);
  });

  it("requires the daemon to stop before replacing the complete inventory", async () => {
    const replacement = [account("replacement")];
    const tryAddLive = vi.fn();
    const saveStored = vi.fn();

    await expect(persistSetupAccountsRuntimeAware(
      { newAccounts: replacement, merged: replacement, replaceExisting: true },
      { isLive: async () => true, tryAddLive, saveStored },
    )).rejects.toThrow(/stop.*--keep-config/i);

    expect(tryAddLive).not.toHaveBeenCalled();
    expect(saveStored).not.toHaveBeenCalled();
  });

  it("replaces stored accounts while the daemon is stopped", async () => {
    const replacement = [account("replacement")];
    const saveStored = vi.fn();

    await expect(persistSetupAccountsRuntimeAware(
      { newAccounts: replacement, merged: replacement, replaceExisting: true },
      { isLive: async () => false, tryAddLive: vi.fn(), saveStored },
    )).resolves.toBe("stored");

    expect(saveStored).toHaveBeenCalledWith(replacement);
  });

  it("asks the running daemon to replace an existing id instead of taking a 409", async () => {
    // The wizard merges by id, so re-collecting credentials for an account that
    // is already configured must upsert live exactly as the stored path does.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ account: { id: "existing" } }, { status: 200 }),
    );
    const reauthenticated = account("existing");

    await expect(persistSetupAccountsRuntimeAware(
      { newAccounts: [reauthenticated], merged: [reauthenticated], replaceExisting: false },
    )).resolves.toBe("live");

    const post = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/cc-router/accounts") && (init as RequestInit)?.method === "POST",
    );
    expect(post, "expected a POST to the live accounts endpoint").toBeDefined();
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(body).toMatchObject({ id: "existing", replace: true });
    expect(saveAccounts).not.toHaveBeenCalled();
  });
});
