import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const MOCK_DIR = vi.hoisted(() => {
  const tmp = process.env["TMPDIR"] ?? process.env["TEMP"] ?? "/tmp";
  return `${tmp}/cc-router-mgr-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
});

vi.mock("../config/paths.js", () => ({
  CONFIG_DIR: MOCK_DIR,
  ACCOUNTS_PATH: `${MOCK_DIR}/accounts.json`,
  CONFIG_PATH: `${MOCK_DIR}/config.json`,
  CLAUDE_SETTINGS_PATH: `${MOCK_DIR}/settings.json`,
  PROXY_PORT: 3456,
  LITELLM_PORT: 4000,
  LITELLM_URL: undefined,
}));

import {
  ensureConfigDir,
  accountsFileExists,
  AccountStateReadError,
  readAccountStateDetailed,
  writeAccountsAtomic,
  writeAnthropicAccountsPreservingOtherProviders,
  upsertAccountRecord,
  removeAccountRecordById,
  saveOpenAIAccounts,
  saveOpenAIAccountsToPath,
  migrateLegacyAccountProviders,
  setProviderAccountsEnabled,
  serialize,
  loadAccounts,
  loadOpenAIAccounts,
  readAccountsFromPath,
  writeConfig,
  getProxyRequestTimeoutMs,
} from "../config/manager.js";

const accountsPath = () => `${MOCK_DIR}/accounts.json`;

const sampleRecord = {
  id: "max-account-1",
  accessToken: "sk-ant-oat01-abc",
  refreshToken: "sk-ant-ort01-xyz",
  expiresAt: 1999999999000,
  scopes: ["user:inference", "user:profile"],
};

beforeEach(() => {
  fs.mkdirSync(MOCK_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(MOCK_DIR, { recursive: true, force: true });
});

describe("ensureConfigDir", () => {
  it("creates the config directory if it doesn't exist", () => {
    fs.rmSync(MOCK_DIR, { recursive: true, force: true });
    ensureConfigDir();
    expect(fs.existsSync(MOCK_DIR)).toBe(true);
  });

  it("does not throw when directory already exists", () => {
    expect(() => ensureConfigDir()).not.toThrow();
  });
});

describe("accountsFileExists", () => {
  it("returns false when file does not exist", () => {
    expect(accountsFileExists()).toBe(false);
  });

  it("returns true after writing accounts", () => {
    writeAccountsAtomic([sampleRecord]);
    expect(accountsFileExists()).toBe(true);
  });

  it("accepts a custom path override", () => {
    const customPath = `${MOCK_DIR}/custom.json`;
    expect(accountsFileExists(customPath)).toBe(false);
    fs.writeFileSync(customPath, "[]");
    expect(accountsFileExists(customPath)).toBe(true);
  });
});

describe("detailed account-state reads", () => {
  it("distinguishes malformed JSON and propagates the typed read failure", () => {
    fs.writeFileSync(accountsPath(), "{PRIVATE malformed json");

    const result = readAccountStateDetailed();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AccountStateReadError);
      expect(result.error.kind).toBe("malformed_json");
      expect(result.error.cause).toBeInstanceOf(SyntaxError);
    }
    expect(() => loadAccounts()).toThrowError(AccountStateReadError);
  });

  it("distinguishes a non-array account-state shape", () => {
    fs.writeFileSync(accountsPath(), JSON.stringify({ PRIVATE: "not-an-array" }));

    const result = readAccountStateDetailed();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_shape");
  });

  it("distinguishes malformed entries inside an account-state array", () => {
    fs.writeFileSync(accountsPath(), JSON.stringify([sampleRecord, {}]));

    const result = readAccountStateDetailed();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_shape");
    expect(() => loadAccounts()).toThrowError(AccountStateReadError);
  });

  it("does not overwrite malformed state during account upsert", () => {
    const corrupted = "{PRIVATE malformed json";
    fs.writeFileSync(accountsPath(), corrupted);

    expect(() => upsertAccountRecord({
      ...sampleRecord,
      provider: "anthropic_subscription",
    })).toThrowError(AccountStateReadError);
    expect(fs.readFileSync(accountsPath(), "utf-8")).toBe(corrupted);
  });

  it("returns a typed unreadable-state failure", () => {
    fs.rmSync(accountsPath(), { force: true });
    fs.mkdirSync(accountsPath());

    const result = readAccountStateDetailed();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("read_failure");
  });
});

describe("writeAccountsAtomic", () => {
  it("writes valid JSON to the accounts file", () => {
    writeAccountsAtomic([sampleRecord]);
    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("max-account-1");
  });

  it("does not leave a .tmp file after successful write", () => {
    writeAccountsAtomic([sampleRecord]);
    expect(fs.existsSync(`${accountsPath()}.tmp`)).toBe(false);
  });

  it("overwrites existing content on second write", () => {
    writeAccountsAtomic([sampleRecord]);
    writeAccountsAtomic([{ ...sampleRecord, id: "updated" }]);
    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed[0].id).toBe("updated");
  });

  it("writes an empty array without error", () => {
    expect(() => writeAccountsAtomic([])).not.toThrow();
    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed).toEqual([]);
  });

  it("writes multiple records correctly", () => {
    const records = [
      { ...sampleRecord, id: "account-1" },
      { ...sampleRecord, id: "account-2" },
      { ...sampleRecord, id: "account-3" },
    ];
    writeAccountsAtomic(records);
    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed).toHaveLength(3);
    expect(parsed.map((r: { id: string }) => r.id)).toEqual(["account-1", "account-2", "account-3"]);
  });
});

describe("migrateLegacyAccountProviders", () => {
  it("tags legacy providerless records as Anthropic subscription accounts", () => {
    writeAccountsAtomic([
      sampleRecord,
      {
        id: "openai-primary",
        provider: "openai_subscription",
        accessToken: "openai-access",
        refreshToken: "openai-refresh",
        expiresAt: 1999999999000,
        scopes: ["openid"],
      },
    ]);

    const migrated = migrateLegacyAccountProviders();

    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(migrated).toBe(true);
    expect(parsed[0]).toMatchObject({
      id: "max-account-1",
      provider: "anthropic_subscription",
    });
    expect(parsed[1].provider).toBe("openai_subscription");
  });

  it("does not rewrite already tagged accounts", () => {
    writeAccountsAtomic([{ ...sampleRecord, provider: "anthropic_subscription" }]);
    const before = fs.readFileSync(accountsPath(), "utf-8");

    const migrated = migrateLegacyAccountProviders();

    expect(migrated).toBe(false);
    expect(fs.readFileSync(accountsPath(), "utf-8")).toBe(before);
  });
});

describe("setProviderAccountsEnabled", () => {
  it("updates all accounts for the selected provider while preserving the other provider", () => {
    writeAccountsAtomic([
      sampleRecord,
      { ...sampleRecord, id: "max-account-2", provider: "anthropic_subscription", enabled: true },
      {
        id: "openai-primary",
        provider: "openai_subscription",
        accessToken: "openai-access",
        refreshToken: "openai-refresh",
        expiresAt: 1999999999000,
        scopes: ["openid"],
        enabled: true,
      },
    ]);

    const changed = setProviderAccountsEnabled("anthropic_subscription", false);

    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(changed).toBe(2);
    expect(parsed.map((record: { id: string; enabled?: boolean }) => [record.id, record.enabled])).toEqual([
      ["max-account-1", false],
      ["max-account-2", false],
      ["openai-primary", true],
    ]);
  });

  it("treats providerless legacy accounts as Anthropic when updating provider state", () => {
    writeAccountsAtomic([sampleRecord]);

    const changed = setProviderAccountsEnabled("anthropic_subscription", false);

    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(changed).toBe(1);
    expect(parsed[0]).toMatchObject({
      provider: "anthropic_subscription",
      enabled: false,
    });
  });
});

describe("writeAnthropicAccountsPreservingOtherProviders", () => {
  it("replaces Anthropic records while preserving OpenAI subscription records", () => {
    writeAccountsAtomic([
      sampleRecord,
      {
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "openai-access",
        refreshToken: "openai-refresh",
        expiresAt: 1999999999000,
        scopes: ["openid", "profile", "email", "offline_access"],
      },
    ]);

    writeAnthropicAccountsPreservingOtherProviders([
      {
        ...sampleRecord,
        id: "max-account-updated",
        accessToken: "sk-ant-oat01-updated",
      },
    ]);

    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed.map((record: { id: string }) => record.id)).toEqual([
      "max-account-updated",
      "openai-victor",
    ]);
    expect(parsed[1].provider).toBe("openai_subscription");
  });

  it("rejects an Anthropic ID already owned by OpenAI without overwriting storage", () => {
    writeAccountsAtomic([{
      id: "shared-account",
      provider: "openai_subscription",
      accessToken: "openai-access",
      refreshToken: "openai-refresh",
      expiresAt: 1999999999000,
      scopes: ["openid"],
    }]);
    const before = fs.readFileSync(accountsPath(), "utf-8");

    expect(() => writeAnthropicAccountsPreservingOtherProviders([{
      ...sampleRecord,
      id: "shared-account",
      provider: "anthropic_subscription",
    }])).toThrow("Account IDs must be unique across providers");
    expect(fs.readFileSync(accountsPath(), "utf-8")).toBe(before);
  });
});

describe("upsertAccountRecord", () => {
  it("adds or replaces a provider-tagged OpenAI record without changing Anthropic records", () => {
    writeAccountsAtomic([sampleRecord]);

    upsertAccountRecord({
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "openai-access",
      refreshToken: "openai-refresh",
      expiresAt: 1999999999000,
      scopes: ["openid"],
      enabled: true,
    });

    upsertAccountRecord({
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "openai-access-updated",
      refreshToken: "openai-refresh",
      expiresAt: 1999999999000,
      scopes: ["openid"],
      enabled: true,
    });

    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("max-account-1");
    expect(parsed[1].accessToken).toBe("openai-access-updated");
  });

  it("rejects an OpenAI ID already owned by a legacy Anthropic record without overwriting storage", () => {
    writeAccountsAtomic([{ ...sampleRecord, id: "shared-account" }]);
    const before = fs.readFileSync(accountsPath(), "utf-8");

    expect(() => upsertAccountRecord({
      id: "shared-account",
      provider: "openai_subscription",
      accessToken: "openai-access",
      refreshToken: "openai-refresh",
      expiresAt: 1999999999000,
      scopes: ["openid"],
      enabled: true,
    })).toThrow("Account IDs must be unique across providers");
    expect(fs.readFileSync(accountsPath(), "utf-8")).toBe(before);
  });
});

describe("removeAccountRecordById", () => {
  it("removes an OpenAI subscription record while preserving Anthropic accounts", () => {
    writeAccountsAtomic([
      sampleRecord,
      {
        id: "openai-primary",
        provider: "openai_subscription",
        accessToken: "openai-access",
        refreshToken: "openai-refresh",
        expiresAt: 1999999999000,
        scopes: ["openid"],
        enabled: true,
      },
    ]);

    const removed = removeAccountRecordById("openai-primary");

    expect(removed?.provider).toBe("openai_subscription");
    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed).toEqual([sampleRecord]);
  });

  it("removes an Anthropic account while preserving OpenAI subscription records", () => {
    const openAIRecord = {
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "openai-access",
      refreshToken: "openai-refresh",
      expiresAt: 1999999999000,
      scopes: ["openid"],
      enabled: true,
    };
    writeAccountsAtomic([sampleRecord, openAIRecord]);

    const removed = removeAccountRecordById("max-account-1");

    expect(removed?.id).toBe("max-account-1");
    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed).toEqual([openAIRecord]);
  });

  it("returns null and leaves the file unchanged when the account is not found", () => {
    writeAccountsAtomic([sampleRecord]);
    const before = fs.readFileSync(accountsPath(), "utf-8");

    const removed = removeAccountRecordById("missing-account");

    expect(removed).toBeNull();
    expect(fs.readFileSync(accountsPath(), "utf-8")).toBe(before);
  });
});

describe("saveOpenAIAccounts", () => {
  it("replaces OpenAI subscription records while preserving Anthropic accounts", () => {
    writeAccountsAtomic([
      sampleRecord,
      {
        id: "openai-primary",
        provider: "openai_subscription",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 1000,
        scopes: ["openid"],
        enabled: true,
      },
    ]);

    saveOpenAIAccounts([
      {
        id: "openai-primary",
        provider: "openai_subscription",
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: 1999999999000,
        enabled: false,
      },
    ]);

    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed).toEqual([
      sampleRecord,
      {
        id: "openai-primary",
        provider: "openai_subscription",
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: 1999999999000,
        scopes: ["openid", "profile", "email", "offline_access"],
        enabled: false,
      },
    ]);
  });
});

describe("saveOpenAIAccountsToPath", () => {
  it("writes only the given custom path and leaves the default accounts file untouched", () => {
    // Baseline: something already exists at the default ACCOUNTS_PATH.
    writeAccountsAtomic([sampleRecord]);
    const before = fs.readFileSync(accountsPath(), "utf-8");

    const customPath = `${MOCK_DIR}/custom-accounts.json`;
    saveOpenAIAccountsToPath(
      [
        {
          id: "openai-custom",
          provider: "openai_subscription",
          accessToken: "custom-access",
          refreshToken: "custom-refresh",
          expiresAt: 1999999999000,
          enabled: true,
        },
      ],
      customPath,
    );

    const custom = JSON.parse(fs.readFileSync(customPath, "utf-8"));
    expect(custom).toEqual([
      {
        id: "openai-custom",
        provider: "openai_subscription",
        accessToken: "custom-access",
        refreshToken: "custom-refresh",
        expiresAt: 1999999999000,
        scopes: ["openid", "profile", "email", "offline_access"],
        enabled: true,
      },
    ]);

    // The default accounts.json must be byte-identical to before the call —
    // a custom-path save must never fall through to the default file.
    expect(fs.readFileSync(accountsPath(), "utf-8")).toBe(before);
  });

  it("preserves non-OpenAI records already present at the custom path", () => {
    const customPath = `${MOCK_DIR}/custom-accounts.json`;
    fs.writeFileSync(customPath, JSON.stringify([sampleRecord]));

    saveOpenAIAccountsToPath(
      [
        {
          id: "openai-custom",
          provider: "openai_subscription",
          accessToken: "custom-access",
          refreshToken: "custom-refresh",
          expiresAt: 1999999999000,
          enabled: true,
        },
      ],
      customPath,
    );

    const parsed = JSON.parse(fs.readFileSync(customPath, "utf-8"));
    expect(parsed).toEqual([
      sampleRecord,
      {
        id: "openai-custom",
        provider: "openai_subscription",
        accessToken: "custom-access",
        refreshToken: "custom-refresh",
        expiresAt: 1999999999000,
        scopes: ["openid", "profile", "email", "offline_access"],
        enabled: true,
      },
    ]);
    // The default accounts.json was never created by a custom-path save.
    expect(fs.existsSync(accountsPath())).toBe(false);
  });
});

describe("loadAccounts", () => {
  it("returns empty array when file does not exist", () => {
    expect(loadAccounts()).toEqual([]);
  });

  it("deserializes AccountRecord[] into Account[] with runtime defaults", () => {
    writeAccountsAtomic([sampleRecord]);
    const accounts = loadAccounts();

    expect(accounts).toHaveLength(1);
    const a = accounts[0];
    expect(a.id).toBe("max-account-1");
    expect(a.tokens.accessToken).toBe("sk-ant-oat01-abc");
    expect(a.tokens.refreshToken).toBe("sk-ant-ort01-xyz");
    expect(a.tokens.expiresAt).toBe(1999999999000);
    expect(a.tokens.scopes).toEqual(["user:inference", "user:profile"]);
    // Runtime defaults
    expect(a.healthy).toBe(true);
    expect(a.busy).toBe(false);
    expect(a.requestCount).toBe(0);
    expect(a.errorCount).toBe(0);
    expect(a.consecutiveErrors).toBe(0);
    expect(a.lastUsed).toBe(0);
    expect(a.lastRefresh).toBe(0);
  });

  it("defaults scopes to user:inference user:profile when missing", () => {
    const noScopes = { ...sampleRecord } as Record<string, unknown>;
    delete noScopes["scopes"];
    writeAccountsAtomic([noScopes]);
    const accounts = loadAccounts();
    expect(accounts[0].tokens.scopes).toEqual(["user:inference", "user:profile"]);
  });

  it("does not include OpenAI subscription records in the Anthropic token pool", () => {
    writeAccountsAtomic([
      sampleRecord,
      {
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "openai-access",
        refreshToken: "openai-refresh",
        expiresAt: 1999999999000,
        scopes: ["openid", "profile", "email", "offline_access"],
      },
    ]);

    expect(loadAccounts().map(a => a.id)).toEqual(["max-account-1"]);
  });

  it("restores an authExpired account as unhealthy so the pool does not route to it", () => {
    // An account whose refresh token the server rejected as terminally expired,
    // then persisted and read back by a restarted process. `authExpired` keeps
    // it out of the refresh loop, so the startup refresh that used to mark it
    // unhealthy never runs — `healthy` must therefore come from disk state, or
    // TokenPool.hardBlock() (which gates only on `enabled && healthy`) routes
    // live traffic to an account whose access token is long dead.
    writeAccountsAtomic([{ ...sampleRecord, authExpired: true }]);

    const [account] = loadAccounts();

    expect(account.authExpired).toBe(true);
    expect(account.healthy).toBe(false);
  });
});

describe("serialize", () => {
  it("persists Anthropic provider tags so legacy accounts stay migrated after save", () => {
    writeAccountsAtomic([sampleRecord]);
    const [account] = loadAccounts();

    writeAnthropicAccountsPreservingOtherProviders(serialize([account]));

    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed[0].provider).toBe("anthropic_subscription");
  });

  it("persists the terminal authExpired flag so a dead account is not retried after a restart", () => {
    writeAccountsAtomic([sampleRecord]);
    const [account] = loadAccounts();
    account.authExpired = true;

    writeAnthropicAccountsPreservingOtherProviders(serialize([account]));

    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed[0].authExpired).toBe(true);
    // And it survives the read back — the restarted process starts with the
    // account already marked expired.
    expect(readAccountsFromPath(accountsPath())[0].authExpired).toBe(true);
  });

  it("leaves authExpired unset for a healthy account and for legacy records", () => {
    writeAccountsAtomic([sampleRecord]);
    const [account] = loadAccounts();

    writeAnthropicAccountsPreservingOtherProviders(serialize([account]));

    const parsed = JSON.parse(fs.readFileSync(accountsPath(), "utf-8"));
    expect(parsed[0].authExpired).toBeUndefined();
    expect(readAccountsFromPath(accountsPath())[0].authExpired).toBe(false);
  });
});

describe("loadOpenAIAccounts", () => {
  it("loads OpenAI subscription records separately from Anthropic accounts", () => {
    writeAccountsAtomic([
      sampleRecord,
      {
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "openai-access",
        refreshToken: "openai-refresh",
        expiresAt: 1999999999000,
        scopes: ["openid", "profile", "email", "offline_access"],
        enabled: true,
      },
    ]);

    expect(loadOpenAIAccounts()).toEqual([
      {
        id: "openai-victor",
        provider: "openai_subscription",
        accessToken: "openai-access",
        refreshToken: "openai-refresh",
        expiresAt: 1999999999000,
        scopes: ["openid", "profile", "email", "offline_access"],
        enabled: true,
      },
    ]);
  });

  it("round-trips scopes and user caps through load and save", () => {
    writeAccountsAtomic([
      {
        id: "openai-a",
        provider: "openai_subscription",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 1234,
        scopes: ["openid", "profile"],
        enabled: true,
        sessionLimitPercent: 80,
        weeklyLimitPercent: 90,
      },
    ]);

    const loaded = loadOpenAIAccounts(accountsPath());
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.scopes).toEqual(["openid", "profile"]);
    expect(loaded[0]?.sessionLimitPercent).toBe(80);
    expect(loaded[0]?.weeklyLimitPercent).toBe(90);
  });
});

describe("readAccountsFromPath", () => {
  it("reads from an explicit path", () => {
    const customPath = `${MOCK_DIR}/custom-accounts.json`;
    fs.writeFileSync(customPath, JSON.stringify([sampleRecord]));
    const accounts = readAccountsFromPath(customPath);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("max-account-1");
  });

  it("returns empty array for a non-existent path", () => {
    const missing = `${MOCK_DIR}/does-not-exist.json`;
    expect(readAccountsFromPath(missing)).toEqual([]);
  });
});

describe("getProxyRequestTimeoutMs", () => {
  it("reads proxyRequestTimeoutMs from config.json", () => {
    writeConfig({ proxyRequestTimeoutMs: 120_000 });

    expect(getProxyRequestTimeoutMs()).toBe(120_000);
  });

  it("defaults to five minutes when config.json does not define a timeout", () => {
    expect(getProxyRequestTimeoutMs()).toBe(300_000);
  });

  it("accepts proxyRequesTime as a backward-compatible alias", () => {
    writeConfig({ proxyRequesTime: 180_000 });

    expect(getProxyRequestTimeoutMs()).toBe(180_000);
  });

  it("writes proxyRequestTimeoutMs when creating config.json", () => {
    writeConfig({ proxySecret: "secret" });

    const parsed = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
    expect(parsed.proxySecret).toBe("secret");
    expect(parsed.proxyRequestTimeoutMs).toBe(300_000);
    expect(parsed.proxyRequesTime).toBeUndefined();
  });

  it("migrates proxyRequesTime to proxyRequestTimeoutMs when writing config.json", () => {
    writeConfig({ proxyRequesTime: 180_000 });

    const parsed = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
    expect(parsed.proxyRequestTimeoutMs).toBe(180_000);
    expect(parsed.proxyRequesTime).toBeUndefined();
  });

  it("persists model routing defaults and aliases", () => {
    writeConfig({
      modelRouting: {
        anthropicDefaultModel: "claude-sonnet-4-6",
        openAIDefaultModel: "gpt-5-codex",
        anthropicAliases: { "claude/sonnet": "claude-sonnet-4-6" },
        openAIAliases: { codex: "gpt-5-codex" },
      },
    });

    const parsed = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
    expect(parsed.modelRouting).toEqual({
      anthropicDefaultModel: "claude-sonnet-4-6",
      openAIDefaultModel: "gpt-5-codex",
      anthropicAliases: { "claude/sonnet": "claude-sonnet-4-6" },
      openAIAliases: { codex: "gpt-5-codex" },
    });
  });
});
