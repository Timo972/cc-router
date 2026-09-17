import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeAnthropicAccountsPreservingOtherProviders } from "../config/manager.js";
import { createAnthropicPersister } from "../proxy/server.js";
import { TokenPool } from "../proxy/token-pool.js";
import type { AccountRecord } from "../proxy/types.js";

/**
 * `cc-router start --accounts <path>` loads the pool from that file. Every
 * Anthropic write targeted the default `ACCOUNTS_PATH` regardless, so rotated
 * refresh tokens never reached the file they came from — they were lost on the
 * next restart — while the default file was overwritten with a pool it does not
 * describe. The OpenAI side already binds its persister to the selected path.
 */

let dir: string;
let customPath: string;

const anthropicRecord: AccountRecord = {
  id: "max-a",
  provider: "anthropic_subscription",
  accessToken: "sk-ant-oat01-old",
  refreshToken: "sk-ant-ort01-old",
  expiresAt: 1_000,
  scopes: ["user:inference", "user:profile"],
  enabled: true,
};

const openAIRecord: AccountRecord = {
  id: "openai-a",
  provider: "openai_subscription",
  accessToken: "openai-access",
  refreshToken: "openai-refresh",
  expiresAt: 2_000,
  scopes: ["openid"],
  enabled: true,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccr-accounts-path-"));
  customPath = join(dir, "custom-accounts.json");
  writeFileSync(customPath, JSON.stringify([anthropicRecord, openAIRecord], null, 2));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function readCustom(): AccountRecord[] {
  return JSON.parse(readFileSync(customPath, "utf-8")) as AccountRecord[];
}

describe("writeAnthropicAccountsPreservingOtherProviders with an explicit path", () => {
  it("writes the Anthropic records to the given file", () => {
    writeAnthropicAccountsPreservingOtherProviders(
      [{ ...anthropicRecord, refreshToken: "sk-ant-ort01-rotated" }],
      customPath,
    );

    const written = readCustom();
    expect(written.find(a => a.id === "max-a")?.refreshToken).toBe("sk-ant-ort01-rotated");
  });

  it("preserves other providers already in that file", () => {
    writeAnthropicAccountsPreservingOtherProviders(
      [{ ...anthropicRecord, refreshToken: "sk-ant-ort01-rotated" }],
      customPath,
    );

    expect(readCustom().find(a => a.id === "openai-a")).toMatchObject({
      provider: "openai_subscription",
      refreshToken: "openai-refresh",
    });
  });
});

describe("createAnthropicPersister", () => {
  it("persists the live pool to the selected accounts file", () => {
    const pool = new TokenPool([]);
    pool.addAccount({ ...anthropicRecord, refreshToken: "sk-ant-ort01-fresh" });

    createAnthropicPersister(customPath)(pool.getAll());

    expect(readCustom().find(a => a.id === "max-a")?.refreshToken).toBe("sk-ant-ort01-fresh");
  });

  it("does not write anywhere else when a path is selected", () => {
    const decoy = join(dir, "default-accounts.json");
    const pool = new TokenPool([]);
    pool.addAccount(anthropicRecord);

    createAnthropicPersister(customPath)(pool.getAll());

    expect(existsSync(decoy)).toBe(false);
  });
});
