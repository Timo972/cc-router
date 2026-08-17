import { describe, expect, it, vi } from "vitest";
import { addOpenAIAccountTransaction } from "../proxy/account-add.js";
import { createOpenAIAccount, type OpenAIAccount } from "../providers/openai/account-state.js";

function makeInput(id: string) {
  return {
    id,
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 60_000,
    enabled: true,
  };
}

describe("addOpenAIAccountTransaction", () => {
  it("appends the account in place and persists the mutated live array", () => {
    const accounts: OpenAIAccount[] = [];
    const persist = vi.fn((next: OpenAIAccount[]) => {
      // persistence sees the same array reference the live pool/router/refresh loop hold
      expect(next).toBe(accounts);
      expect(next.map(a => a.id)).toEqual(["openai-a"]);
    });

    const added = addOpenAIAccountTransaction({ record: makeInput("openai-a"), accounts, persist });

    expect(added).toMatchObject({
      id: "openai-a",
      provider: "openai_subscription",
      accessToken: "access-openai-a",
      refreshToken: "refresh-openai-a",
      enabled: true,
    });
    expect(accounts).toContain(added);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("defaults enabled to true when omitted", () => {
    const accounts: OpenAIAccount[] = [];
    const { id, accessToken, refreshToken, expiresAt } = makeInput("openai-b");
    const added = addOpenAIAccountTransaction({
      record: { id, accessToken, refreshToken, expiresAt },
      accounts,
      persist: vi.fn(),
    });
    expect(added.enabled).toBe(true);
  });

  it("passes session/weekly caps through to the created account", () => {
    const accounts: OpenAIAccount[] = [];
    const persist = vi.fn((next: OpenAIAccount[]) => {
      expect(next[0].sessionLimitPercent).toBe(40);
      expect(next[0].weeklyLimitPercent).toBe(60);
    });

    const added = addOpenAIAccountTransaction({
      record: { ...makeInput("openai-caps"), sessionLimitPercent: 40, weeklyLimitPercent: 60 },
      accounts,
      persist,
    });

    expect(added.sessionLimitPercent).toBe(40);
    expect(added.weeklyLimitPercent).toBe(60);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("defaults caps to 100 when omitted", () => {
    const accounts: OpenAIAccount[] = [];
    const added = addOpenAIAccountTransaction({ record: makeInput("openai-nocaps"), accounts, persist: vi.fn() });
    expect(added.sessionLimitPercent).toBe(100);
    expect(added.weeklyLimitPercent).toBe(100);
  });

  it("rolls the in-place append back out when persistence fails", () => {
    const existing: OpenAIAccount = createOpenAIAccount({
      id: "openai-existing",
      provider: "openai_subscription",
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    });
    const accounts: OpenAIAccount[] = [existing];
    const persist = vi.fn(() => { throw new Error("disk full"); });

    expect(() => addOpenAIAccountTransaction({ record: makeInput("openai-a"), accounts, persist }))
      .toThrow("disk full");
    // the live array must be left exactly as it was before the failed add
    expect(accounts).toEqual([existing]);
  });
});
