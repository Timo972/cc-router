import { describe, expect, it, vi } from "vitest";
import {
  accountDrift,
  addAccountRuntimeAware,
  buildStoredAccountsJson,
  isAccountApiReachable,
  mergeAccountInventory,
  removeAccountRuntimeAware,
  renameAccountRuntimeAware,
  tryAddAccountToRunningProxy,
  tryRemoveAccountFromRunningProxy,
  tryRenameAccountOnRunningProxy,
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
    } as Account, {
      // `claude setup-token` mints an access token with no refresh token. A
      // consumer cannot infer that from the metadata otherwise, and the
      // account is deliberately never refreshed.
      id: "max-long-lived",
      tokens: {
        accessToken: "ant-long-lived",
        expiresAt: 1999999996000,
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

    const json = buildStoredAccountsJson(anthropic, openAI, [{
      id: "grok",
      expiresAt: 1999999997000,
      enabled: true,
    }]);

    expect(json).toEqual([
      {
        id: "max-account-1",
        provider: "anthropic_subscription",
        enabled: true,
        expiresAt: 1999999999000,
        scopes: ["user:inference"],
      },
      {
        id: "max-long-lived",
        provider: "anthropic_subscription",
        enabled: true,
        expiresAt: 1999999996000,
        scopes: ["user:inference"],
        tokenOnly: true,
      },
      {
        id: "openai-primary",
        provider: "openai_subscription",
        enabled: false,
        expiresAt: 1999999998000,
      },
      {
        id: "grok",
        provider: "xai_subscription",
        enabled: true,
        expiresAt: 1999999997000,
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

  it("asks the proxy to replace an existing id when re-authenticating", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ account: { id: "openai-1" } }), { status: 200 }));

    await expect(tryAddAccountToRunningProxy(record, { fetch, replace: true })).resolves.toBe(true);

    const body = JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ ...record, replace: true });
  });

  it("does not ask for replacement unless the caller opts in", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ account: { id: "openai-1" } }), { status: 201 }));

    await tryAddAccountToRunningProxy(record, { fetch });

    const body = JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).not.toHaveProperty("replace");
  });

  it("re-authenticates an existing account through the running proxy instead of losing the token", async () => {
    // The live add used to reject a known id, and the CLI rethrew before it
    // wrote anything — discarding the refresh token the OAuth login had just
    // minted. Replacement has to be requested for that to be recoverable.
    const tryAddLive = vi.fn(async () => true);
    const addStored = vi.fn();

    await expect(addAccountRuntimeAware(record, { tryAddLive, addStored }))
      .resolves.toEqual({ mode: "live" });

    expect(addStored).not.toHaveBeenCalled();
  });

  it("reports no reachable proxy when the POST connection fails", async () => {
    const fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); });

    await expect(tryAddAccountToRunningProxy(record, { fetch })).resolves.toBe(false);
  });

  it("surfaces HTTP errors from the live account API instead of falling back", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "Account \"openai-1\" already exists" }), { status: 409 }));

    await expect(tryAddAccountToRunningProxy(record, { fetch }))
      .rejects.toThrow("HTTP 409: Account \"openai-1\" already exists");
  });

  it("probes the authenticated account API without mutating it", async () => {
    const fetch = vi.fn(async () => Response.json({ accounts: [] }));

    await expect(isAccountApiReachable({
      baseUrl: "http://router.local/",
      authToken: "secret",
      fetch,
    })).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledWith(
      "http://router.local/cc-router/accounts",
      expect.objectContaining({
        headers: { authorization: "Bearer secret" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("method", "POST");
  });
});

describe("mergeAccountInventory", () => {
  it("includes accounts the running proxy has but disk does not", () => {
    // What a file rewritten after the proxy started looks like: the proxy is
    // still routing to max-live, but accounts.json no longer mentions it.
    const inventory = mergeAccountInventory(
      ["max-on-disk"],
      ["plus-on-disk"],
      [{ id: "max-live", provider: "anthropic_subscription" }, { id: "max-on-disk", provider: "anthropic_subscription" }],
    );

    // Removal prefers the live proxy, so an id it knows must not be rejected.
    expect(inventory.ids).toContain("max-live");
    expect(inventory.ids).toEqual(["max-on-disk", "plus-on-disk", "max-live"]);
  });

  it("recognizes a live-only OpenAI account as OpenAI", () => {
    const inventory = mergeAccountInventory([], [], [{ id: "plus-live", provider: "openai_subscription" }]);
    expect(inventory.openAIIds.has("plus-live")).toBe(true);
  });

  it("falls back to disk alone when no proxy is reachable", () => {
    const inventory = mergeAccountInventory(["max-a"], ["plus-a"], null);
    expect(inventory.ids).toEqual(["max-a", "plus-a"]);
    expect(inventory.openAIIds.has("plus-a")).toBe(true);
  });
});

describe("accountDrift", () => {
  it("separates accounts missing from disk from accounts the proxy has not loaded", () => {
    const drift = accountDrift(
      ["max-live-only", "shared"],
      ["shared", "max-disk-only"],
    );

    // The first is a credential-loss risk; the second is only staleness.
    expect(drift.unpersisted).toEqual(["max-live-only"]);
    expect(drift.unloaded).toEqual(["max-disk-only"]);
  });

  it("reports no drift when both sources agree", () => {
    const drift = accountDrift(["a", "b"], ["b", "a"]);
    expect(drift.unpersisted).toEqual([]);
    expect(drift.unloaded).toEqual([]);
  });
});

describe("runtime-aware account rename", () => {
  it("renames through the running proxy without editing storage a second time", async () => {
    const tryRenameLive = vi.fn(async () => true);
    const renameStored = vi.fn();

    await expect(renameAccountRuntimeAware("max-1", "max-eu", { tryRenameLive, renameStored }))
      .resolves.toEqual({ mode: "live" });
    expect(tryRenameLive).toHaveBeenCalledWith("max-1", "max-eu");
    expect(renameStored).not.toHaveBeenCalled();
  });

  it("falls back to stored configuration only when no proxy is reachable", async () => {
    const record: AccountRecord = {
      id: "max-eu",
      provider: "anthropic_subscription",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1,
      scopes: [],
    };
    const renameStored = vi.fn(() => record);

    await expect(renameAccountRuntimeAware("max-1", "max-eu", {
      tryRenameLive: async () => false,
      renameStored,
    })).resolves.toEqual({ mode: "stored", renamed: record });
    expect(renameStored).toHaveBeenCalledWith("max-1", "max-eu");
  });

  it("does not edit stored configuration when the running proxy rejects the rename", async () => {
    const renameStored = vi.fn();

    await expect(renameAccountRuntimeAware("max-1", "taken", {
      tryRenameLive: async () => { throw new Error("HTTP 409: already exists"); },
      renameStored,
    })).rejects.toThrow("HTTP 409: already exists");
    expect(renameStored).not.toHaveBeenCalled();
  });
});

describe("tryRenameAccountOnRunningProxy", () => {
  it("sends an authenticated encoded PATCH and confirms the returned id", async () => {
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({ account: { id: "max-eu" } }),
      { status: 200 },
    ));

    await expect(tryRenameAccountOnRunningProxy("max/1", "max-eu", {
      baseUrl: "http://router.local/",
      authToken: "secret",
      fetch,
    })).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledWith(
      "http://router.local/cc-router/accounts/max%2F1",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
        body: JSON.stringify({ id: "max-eu" }),
      }),
    );
  });

  it("resolves false when no proxy answers", async () => {
    await expect(tryRenameAccountOnRunningProxy("a", "b", {
      fetch: vi.fn(async () => { throw new Error("ECONNREFUSED"); }),
    })).resolves.toBe(false);
  });

  it("throws on an HTTP error with the server's detail", async () => {
    await expect(tryRenameAccountOnRunningProxy("a", "b", {
      fetch: vi.fn(async () => new Response(
        JSON.stringify({ error: 'An account named "b" already exists' }),
        { status: 409 },
      )),
    })).rejects.toThrow('HTTP 409: An account named "b" already exists');
  });

  it("throws when the proxy answers 200 but silently kept the old id", async () => {
    // A daemon from before rename support validates unknown fields away and
    // reports success without doing anything — that must not be reported as
    // a completed rename.
    await expect(tryRenameAccountOnRunningProxy("a", "b", {
      fetch: vi.fn(async () => new Response(
        JSON.stringify({ account: { id: "a" } }),
        { status: 200 },
      )),
    })).rejects.toThrow(/does not support rename/);
  });
});
