import { describe, expect, it, vi } from "vitest";
import {
  buildStoredAccountsJson,
  removeAccountRuntimeAware,
  tryRemoveAccountFromRunningProxy,
} from "../cli/cmd-accounts.js";
import type { AccountRecord } from "../proxy/types.js";
import type { Account } from "../proxy/types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

describe("buildStoredAccountsJson", () => {
  it("returns provider-tagged account metadata without tokens", () => {
    const anthropic = [{
      id: "max-account-1",
      tokens: {
        accessToken: "ant-access",
        refreshToken: "ant-refresh",
        expiresAt: 1999999999000,
        scopes: ["user:inference"],
      },
      enabled: true,
    } as Account];
    const openAI: OpenAISubscriptionAccount[] = [{
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "openai-access",
      refreshToken: "openai-refresh",
      expiresAt: 1999999998000,
      enabled: false,
    }];

    const json = buildStoredAccountsJson(anthropic, openAI);

    expect(json).toEqual([
      {
        id: "max-account-1",
        provider: "anthropic_subscription",
        enabled: true,
        expiresAt: 1999999999000,
        scopes: ["user:inference"],
      },
      {
        id: "openai-primary",
        provider: "openai_subscription",
        enabled: false,
        expiresAt: 1999999998000,
      },
    ]);
    expect(JSON.stringify(json)).not.toContain("access");
    expect(JSON.stringify(json)).not.toContain("refresh");
  });
});

describe("runtime-aware account removal", () => {
  it("removes through the running proxy without editing storage a second time", async () => {
    const tryRemoveLive = vi.fn(async () => true);
    const removeStored = vi.fn();

    await expect(removeAccountRuntimeAware("max-1", { tryRemoveLive, removeStored }))
      .resolves.toEqual({ mode: "live" });
    expect(tryRemoveLive).toHaveBeenCalledWith("max-1");
    expect(removeStored).not.toHaveBeenCalled();
  });

  it("falls back to stored configuration only when no proxy is reachable", async () => {
    const record: AccountRecord = {
      id: "max-1",
      provider: "anthropic_subscription",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1,
      scopes: [],
    };
    const removeStored = vi.fn(() => record);

    await expect(removeAccountRuntimeAware("max-1", {
      tryRemoveLive: async () => false,
      removeStored,
    })).resolves.toEqual({ mode: "stored", removed: record });
    expect(removeStored).toHaveBeenCalledWith("max-1");
  });

  it("does not edit stored configuration when the running proxy rejects deletion", async () => {
    const removeStored = vi.fn();

    await expect(removeAccountRuntimeAware("only-account", {
      tryRemoveLive: async () => { throw new Error("HTTP 409: last account"); },
      removeStored,
    })).rejects.toThrow("HTTP 409: last account");
    expect(removeStored).not.toHaveBeenCalled();
  });

  it("sends an authenticated encoded DELETE request to the live account API", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(tryRemoveAccountFromRunningProxy("max/account", {
      baseUrl: "http://router.local/",
      authToken: "secret",
      fetch,
    })).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledWith(
      "http://router.local/cc-router/accounts/max%2Faccount",
      expect.objectContaining({
        method: "DELETE",
        headers: { authorization: "Bearer secret" },
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
