import { describe, expect, it, vi } from "vitest";
import { persistSetupAccountsRuntimeAware } from "../cli/cmd-setup.js";
import type { Account } from "../proxy/types.js";

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
});
