import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import {
  addAccountRuntimeAware,
  buildStoredAccountsJson,
  removeAccountRuntimeAware,
  tryAddAccountToRunningProxy,
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

describe("runtime-aware account add", () => {
  const record: AccountRecord = {
    id: "openai-1",
    provider: "openai_subscription",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 1999999999000,
    scopes: ["openid"],
    enabled: true,
  };

  it("adds through the running proxy without writing storage a second time", async () => {
    const tryAddLive = vi.fn(async () => true);
    const addStored = vi.fn();

    await expect(addAccountRuntimeAware(record, { tryAddLive, addStored }))
      .resolves.toEqual({ mode: "live" });
    expect(tryAddLive).toHaveBeenCalledWith(record);
    expect(addStored).not.toHaveBeenCalled();
  });

  it("falls back to stored configuration only when no proxy is reachable", async () => {
    const addStored = vi.fn();

    await expect(addAccountRuntimeAware(record, {
      tryAddLive: async () => false,
      addStored,
    })).resolves.toEqual({ mode: "stored" });
    expect(addStored).toHaveBeenCalledWith(record);
  });

  it("does not write stored configuration when the running proxy rejects the add", async () => {
    const addStored = vi.fn();

    await expect(addAccountRuntimeAware(record, {
      tryAddLive: async () => { throw new Error("HTTP 409: Account \"openai-1\" already exists"); },
      addStored,
    })).rejects.toThrow("already exists");
    expect(addStored).not.toHaveBeenCalled();
  });

  it("sends an authenticated JSON POST of the record to the live account API", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ account: { id: "openai-1" } }), { status: 201 }));

    await expect(tryAddAccountToRunningProxy(record, {
      baseUrl: "http://router.local/",
      authToken: "secret",
      fetch,
    })).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledWith(
      "http://router.local/cc-router/accounts",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret",
          "content-type": "application/json",
        }),
        body: JSON.stringify(record),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("reports no reachable proxy when the POST connection fails", async () => {
    const refusal = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    const fetch = vi.fn(async () => { throw new TypeError("fetch failed", { cause: refusal }); });

    await expect(tryAddAccountToRunningProxy(record, { fetch })).resolves.toBe(false);
  });

  it("does not fall back to disk when the live POST commits before the connection resets", async () => {
    let committed = false;
    const server = createServer((request) => {
      request.resume();
      request.on("end", () => {
        committed = true;
        request.socket.destroy();
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("ambiguous-commit server did not bind");
    const addStored = vi.fn();

    try {
      await expect(addAccountRuntimeAware(record, {
        tryAddLive: candidate => tryAddAccountToRunningProxy(candidate, {
          baseUrl: `http://127.0.0.1:${address.port}`,
        }),
        addStored,
      })).rejects.toThrow("outcome is unknown");
      expect(committed).toBe(true);
      expect(addStored).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
    }
  });

  it("surfaces HTTP errors from the live account API instead of falling back", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "Account \"openai-1\" already exists" }), { status: 409 }));

    await expect(tryAddAccountToRunningProxy(record, { fetch }))
      .rejects.toThrow("HTTP 409: Account \"openai-1\" already exists");
  });
});
