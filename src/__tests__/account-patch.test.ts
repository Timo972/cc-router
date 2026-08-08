import { describe, expect, it, vi } from "vitest";
import { applyOpenAIAccountPatch, validateAccountPatchBody } from "../proxy/account-patch.js";
import { createOpenAIAccount, type OpenAIAccount } from "../providers/openai/account-state.js";

function makeAccount(id: string, overrides: Partial<OpenAIAccount> = {}): OpenAIAccount {
  return {
    ...createOpenAIAccount({
      id,
      provider: "openai_subscription",
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 60_000,
      enabled: true,
    }),
    ...overrides,
  };
}

describe("validateAccountPatchBody", () => {
  it("accepts an empty body", () => {
    expect(validateAccountPatchBody({})).toEqual({ ok: true, patch: {} });
  });

  it("accepts enabled + caps within range", () => {
    expect(validateAccountPatchBody({
      enabled: false,
      sessionLimitPercent: 40,
      weeklyLimitPercent: 0,
    })).toEqual({
      ok: true,
      patch: { enabled: false, sessionLimitPercent: 40, weeklyLimitPercent: 0 },
    });
  });

  it("rejects a non-boolean enabled", () => {
    const result = validateAccountPatchBody({ enabled: "yes" });
    expect(result).toEqual({ ok: false, error: "enabled must be boolean" });
  });

  it("rejects an out-of-range sessionLimitPercent", () => {
    expect(validateAccountPatchBody({ sessionLimitPercent: 101 }))
      .toEqual({ ok: false, error: "sessionLimitPercent must be a number between 0 and 100" });
    expect(validateAccountPatchBody({ sessionLimitPercent: -1 }))
      .toEqual({ ok: false, error: "sessionLimitPercent must be a number between 0 and 100" });
  });

  it("rejects a non-numeric or non-finite weeklyLimitPercent", () => {
    expect(validateAccountPatchBody({ weeklyLimitPercent: "50" }))
      .toEqual({ ok: false, error: "weeklyLimitPercent must be a number between 0 and 100" });
    expect(validateAccountPatchBody({ weeklyLimitPercent: Number.NaN }))
      .toEqual({ ok: false, error: "weeklyLimitPercent must be a number between 0 and 100" });
  });
});

describe("applyOpenAIAccountPatch", () => {
  it("applies enabled and clamped caps to the matching account and persists", () => {
    const account = makeAccount("openai-a", { sessionLimitPercent: 100, weeklyLimitPercent: 100 });
    const accounts = [account];
    const persist = vi.fn();

    const updated = applyOpenAIAccountPatch({
      id: "openai-a",
      patch: { enabled: false, sessionLimitPercent: 40 },
      accounts,
      persist,
    });

    expect(updated).toBe(account);
    expect(updated?.enabled).toBe(false);
    expect(updated?.sessionLimitPercent).toBe(40);
    expect(updated?.weeklyLimitPercent).toBe(100); // untouched field is unchanged
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(accounts);
  });

  it("clamps out-of-range numeric caps defensively even though validation should have caught them", () => {
    const account = makeAccount("openai-b");
    const updated = applyOpenAIAccountPatch({
      id: "openai-b",
      patch: { weeklyLimitPercent: 999 },
      accounts: [account],
      persist: vi.fn(),
    });
    expect(updated?.weeklyLimitPercent).toBe(100);
  });

  it("returns undefined without mutating or persisting when the id is not found", () => {
    const account = makeAccount("openai-c");
    const persist = vi.fn();
    const updated = applyOpenAIAccountPatch({
      id: "does-not-exist",
      patch: { enabled: false },
      accounts: [account],
      persist,
    });
    expect(updated).toBeUndefined();
    expect(account.enabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("rolls back the mutation and rethrows when persistence fails", () => {
    const account = makeAccount("openai-d", { sessionLimitPercent: 100, weeklyLimitPercent: 100 });
    const persist = vi.fn(() => { throw new Error("disk full"); });

    expect(() => applyOpenAIAccountPatch({
      id: "openai-d",
      patch: { enabled: false, sessionLimitPercent: 40, weeklyLimitPercent: 60 },
      accounts: [account],
      persist,
    })).toThrow("disk full");

    expect(account.enabled).toBe(true);
    expect(account.sessionLimitPercent).toBe(100);
    expect(account.weeklyLimitPercent).toBe(100);
  });
});
