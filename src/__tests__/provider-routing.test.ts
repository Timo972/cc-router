import { describe, expect, it, vi } from "vitest";
import { persistProviderEnabledState } from "../proxy/provider-routing.js";

describe("persistProviderEnabledState", () => {
  it("does not invalidate Anthropic affinity when persistence fails", () => {
    const persist = vi.fn(() => { throw new Error("disk full"); });
    const invalidateAccount = vi.fn();

    expect(() => persistProviderEnabledState({
      provider: "anthropic_subscription",
      enabled: false,
      accountIds: ["account-a", "account-b"],
      persist,
      invalidateAccount,
    })).toThrow("disk full");

    expect(invalidateAccount).not.toHaveBeenCalled();
  });

  it("invalidates every Anthropic binding only after a successful disable", () => {
    const order: string[] = [];
    const persist = vi.fn(() => {
      order.push("persist");
      return 2;
    });
    const invalidateAccount = vi.fn((accountId: string) => {
      order.push(`invalidate:${accountId}`);
    });

    expect(persistProviderEnabledState({
      provider: "anthropic_subscription",
      enabled: false,
      accountIds: ["account-a", "account-b"],
      persist,
      invalidateAccount,
    })).toBe(2);

    expect(order).toEqual(["persist", "invalidate:account-a", "invalidate:account-b"]);
  });

  it.each([
    ["anthropic_subscription", true],
    ["openai_subscription", true],
  ] as const)("does not invalidate for provider %s with enabled=%s", (provider, enabled) => {
    const invalidateAccount = vi.fn();

    persistProviderEnabledState({
      provider,
      enabled,
      accountIds: ["account-a"],
      persist: () => 1,
      invalidateAccount,
    });

    expect(invalidateAccount).not.toHaveBeenCalled();
  });

  // Both providers now own a SessionRouter, so disabling either must drop that
  // provider's sticky bindings; the caller supplies the matching account ids
  // and invalidator.
  it("invalidates OpenAI bindings after a successful disable", () => {
    const invalidateAccount = vi.fn();

    persistProviderEnabledState({
      provider: "openai_subscription",
      enabled: false,
      accountIds: ["openai-a", "openai-b"],
      persist: () => 1,
      invalidateAccount,
    });

    expect(invalidateAccount.mock.calls).toEqual([["openai-a"], ["openai-b"]]);
  });

  it("does not invalidate OpenAI bindings when persistence fails", () => {
    const invalidateAccount = vi.fn();

    expect(() => persistProviderEnabledState({
      provider: "openai_subscription",
      enabled: false,
      accountIds: ["openai-a"],
      persist: () => { throw new Error("disk full"); },
      invalidateAccount,
    })).toThrow("disk full");

    expect(invalidateAccount).not.toHaveBeenCalled();
  });
});
