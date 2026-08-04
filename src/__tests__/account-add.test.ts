import { describe, expect, it, vi } from "vitest";
import { addOpenAIAccountTransaction } from "../proxy/account-add.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

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
    const accounts: OpenAISubscriptionAccount[] = [];
    const persist = vi.fn((next: OpenAISubscriptionAccount[]) => {
      // persistence sees the same array reference the live picker/refresh loop hold
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
    const accounts: OpenAISubscriptionAccount[] = [];
    const { id, accessToken, refreshToken, expiresAt } = makeInput("openai-b");
    const added = addOpenAIAccountTransaction({
      record: { id, accessToken, refreshToken, expiresAt },
      accounts,
      persist: vi.fn(),
    });
    expect(added.enabled).toBe(true);
  });

  it("rolls the in-place append back out when persistence fails", () => {
    const existing: OpenAISubscriptionAccount = {
      id: "openai-existing",
      provider: "openai_subscription",
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    };
    const accounts: OpenAISubscriptionAccount[] = [existing];
    const persist = vi.fn(() => { throw new Error("disk full"); });

    expect(() => addOpenAIAccountTransaction({ record: makeInput("openai-a"), accounts, persist }))
      .toThrow("disk full");
    // the live array must be left exactly as it was before the failed add
    expect(accounts).toEqual([existing]);
  });
});
