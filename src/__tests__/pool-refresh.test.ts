import { describe, expect, it, vi } from "vitest";
import { createRefreshAllRunner, describeRefreshAll, refreshAllAccounts, type RefreshablePoolSource, type RefreshAllSummary } from "../proxy/pool-refresh.js";

type Acc = { id: string };

function source(
  provider: string,
  accounts: Acc[],
  overrides: Partial<RefreshablePoolSource<Acc>> = {},
): RefreshablePoolSource<Acc> {
  return {
    provider,
    getAll: () => accounts,
    refreshTokens: vi.fn(async () => ({ failed: 0 })),
    refreshUsage: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe("refreshAllAccounts", () => {
  it("sweeps cooldowns, runs one token pass per provider and re-fetches usage for every account", async () => {
    const sweep = vi.fn();
    const anthropic = source("anthropic", [{ id: "a1" }, { id: "a2" }]);
    const openai = source("openai", [{ id: "o1" }]);
    let clock = 1_000;

    const summary = await refreshAllAccounts([anthropic, openai], {
      sweepCooldowns: sweep,
      now: () => (clock += 25),
    });

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(anthropic.refreshTokens).toHaveBeenCalledTimes(1);
    expect(openai.refreshTokens).toHaveBeenCalledTimes(1);
    expect(anthropic.refreshUsage).toHaveBeenCalledTimes(2);
    expect(openai.refreshUsage).toHaveBeenCalledWith({ id: "o1" });
    expect(summary).toMatchObject({ accounts: 3, usageRefreshed: 3, usageFailed: 0, tokenRefreshFailed: 0, durationMs: 25 });
    expect(summary.providers.map(p => p.provider)).toEqual(["anthropic", "openai"]);
  });

  it("isolates a failing provider: token errors and usage failures are counted, not thrown", async () => {
    const onError = vi.fn();
    const broken = source("openai", [{ id: "o1" }, { id: "o2" }], {
      refreshTokens: vi.fn(async () => { throw new Error("refresh exploded"); }),
      refreshUsage: vi.fn(async (account: Acc) =>
        account.id === "o1" ? { ok: false } : Promise.reject(new Error("usage down"))),
    });
    const healthy = source("anthropic", [{ id: "a1" }]);

    const summary = await refreshAllAccounts([broken, healthy], { onError });

    expect(summary).toMatchObject({ accounts: 3, usageRefreshed: 1, usageFailed: 2, tokenRefreshFailed: 2 });
    expect(summary.providers.find(p => p.provider === "openai")).toMatchObject({
      usageRefreshed: 0, usageFailed: 2, tokenRefreshFailed: 2,
    });
    expect(onError).toHaveBeenCalledWith("openai", expect.objectContaining({ message: "refresh exploded" }));
    expect(onError).toHaveBeenCalledWith("openai", expect.objectContaining({ message: "usage down" }));
    expect(healthy.refreshUsage).toHaveBeenCalledTimes(1);
  });

  it("counts expected token-pass rejections without treating them as a thrown pass", async () => {
    const src = source("openai", [{ id: "o1" }, { id: "o2" }, { id: "o3" }], {
      refreshTokens: vi.fn(async () => ({ failed: 1 })),
    });

    const summary = await refreshAllAccounts([src]);

    expect(summary.tokenRefreshFailed).toBe(1);
    expect(summary.usageRefreshed).toBe(3);
  });

  it("reads the account list only after the token pass so recovered accounts are refreshed", async () => {
    const accounts: Acc[] = [];
    const src = source("openai", accounts, {
      refreshTokens: vi.fn(async () => { accounts.push({ id: "late" }); return { failed: 0 }; }),
    });

    const summary = await refreshAllAccounts([src]);

    expect(src.refreshUsage).toHaveBeenCalledWith({ id: "late" });
    expect(summary.accounts).toBe(1);
  });

  it("keeps the summary consistent when the live pool array changes mid-flight", async () => {
    const accounts: Acc[] = [{ id: "a" }, { id: "b" }];
    const src = source("openai", accounts, {
      refreshUsage: vi.fn(async () => {
        // A concurrent delete/add mutates the array the pool handed out.
        accounts.splice(0, accounts.length, { id: "c" }, { id: "d" }, { id: "e" });
        return { ok: true };
      }),
    });

    const summary = await refreshAllAccounts([src]);

    expect(summary).toMatchObject({ accounts: 2, usageRefreshed: 2, usageFailed: 0 });
  });
});

describe("createRefreshAllRunner", () => {
  it("joins a running pass and starts a fresh one afterwards", async () => {
    let resolveFirst!: (summary: RefreshAllSummary) => void;
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise<RefreshAllSummary>(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => ({ accounts: 9 } as RefreshAllSummary));
    const runner = createRefreshAllRunner(run);

    const first = runner();
    const joined = runner();
    expect(run).toHaveBeenCalledTimes(1);
    expect(joined).toBe(first);

    resolveFirst({ accounts: 1 } as RefreshAllSummary);
    await expect(first).resolves.toMatchObject({ accounts: 1 });

    await expect(runner()).resolves.toMatchObject({ accounts: 9 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("releases the slot when the pass rejects", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ accounts: 2 } as RefreshAllSummary);
    const runner = createRefreshAllRunner(run);

    await expect(runner()).rejects.toThrow("boom");
    await expect(runner()).resolves.toMatchObject({ accounts: 2 });
  });
});

describe("describeRefreshAll", () => {
  it("formats the activity-log line with failures only when present", () => {
    expect(describeRefreshAll({
      accounts: 3, usageRefreshed: 3, usageFailed: 0, tokenRefreshFailed: 0, durationMs: 40,
      providers: [{ provider: "anthropic", accounts: 3, usageRefreshed: 3, usageFailed: 0, tokenRefreshFailed: 0 }],
    })).toBe("reloaded 3 accounts, usage fresh for 3 (40ms)");

    expect(describeRefreshAll({
      accounts: 1, usageRefreshed: 0, usageFailed: 1, tokenRefreshFailed: 1, durationMs: 5,
      providers: [{ provider: "openai", accounts: 1, usageRefreshed: 0, usageFailed: 1, tokenRefreshFailed: 1 }],
    })).toBe("reloaded 1 account, usage fresh for 0, 1 usage fetch failed, 1 token refresh failed (5ms)");
  });
});
