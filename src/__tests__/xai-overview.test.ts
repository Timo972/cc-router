import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import {
  loadGrokAccountSnapshots,
  loadGrokHealthSnapshotsWithSubscription,
} from "../providers/xai/overview.js";

function jwtWith(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf-8").toString("base64url");
  return `header.${payload}.sig`;
}

describe("loadGrokAccountSnapshots", () => {
  const now = () => Date.parse("2026-08-21T10:00:00Z");

  it("returns an empty list when grok is not logged in", () => {
    expect(loadGrokAccountSnapshots({
      grokHome: "/tmp/missing-grok-home",
      fileExists: () => false,
    })).toEqual([]);
  });

  it("reads identity and live sessions without leaking tokens", () => {
    const token = jwtWith({
      email: "user@example.com",
      tier: 1,
      exp: Math.floor(now() / 1000) + 3600,
    });
    const files: Record<string, string> = {
      "/tmp/grok-home/auth.json": JSON.stringify({
        "https://auth.x.ai::client": {
          key: token,
          auth_mode: "oidc",
          email: "user@example.com",
          expires_at: "2026-08-21T14:00:00Z",
          refresh_token: "secret-refresh",
        },
      }),
      "/tmp/grok-home/active_sessions.json": JSON.stringify([
        { session_id: "sess-live", pid: 111, opened_at: "2026-08-21T09:00:00Z" },
        { session_id: "sess-dead", pid: 222, opened_at: "2026-08-21T08:00:00Z" },
      ]),
    };

    const views = loadGrokAccountSnapshots({
      grokHome: "/tmp/grok-home",
      now,
      fileExists: path => path in files,
      readFile: path => files[path]!,
      isProcessAlive: pid => pid === 111,
    });

    expect(views).toEqual([{
      id: "grok",
      provider: "xai_subscription",
      enabled: true,
      healthy: true,
      busy: true,
      inFlightRequests: 0,
      activeSessions: 1,
      requestCount: 0,
      errorCount: 0,
      expiresInMs: Date.parse("2026-08-21T14:00:00Z") - now(),
      lastUsedMs: 0,
      lastRefreshMs: 0,
      tier: 1,
    }]);
    expect(JSON.stringify(views)).not.toContain("secret-refresh");
    expect(JSON.stringify(views)).not.toContain(token);
    expect(JSON.stringify(views)).not.toContain("user@example.com");
  });

  it("marks an expired Grok login unhealthy", () => {
    const views = loadGrokAccountSnapshots({
      grokHome: "/tmp/grok-home",
      now,
      fileExists: () => true,
      readFile: () => JSON.stringify({
        a: {
          key: jwtWith({ email: "user@example.com", exp: Math.floor(now() / 1000) - 10 }),
          auth_mode: "oidc",
          email: "user@example.com",
          expires_at: "2026-08-21T09:00:00Z",
        },
      }),
      isProcessAlive: () => false,
    });
    expect(views[0]).toMatchObject({ id: "grok", healthy: false, busy: false, activeSessions: 0 });
  });
});

describe("loadGrokHealthSnapshotsWithSubscription", () => {
  const now = () => Date.parse("2026-08-21T10:00:00Z");
  const expiresAt = Date.parse("2026-08-21T14:00:00Z");
  let tmpDir: string;
  let accountsPath: string;
  const prevAccountsPath = process.env["ACCOUNTS_PATH"];

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "cc-router-xai-"));
    accountsPath = path.join(tmpDir, "accounts.json");
    writeFileSync(accountsPath, JSON.stringify([{
      id: "grok",
      provider: "xai_subscription",
      accessToken: jwtWith({ tier: 1, exp: Math.floor(expiresAt / 1000) }),
      refreshToken: "r",
      expiresAt,
      enabled: true,
    }]));
    process.env["ACCOUNTS_PATH"] = accountsPath;
  });

  afterEach(() => {
    if (prevAccountsPath === undefined) delete process.env["ACCOUNTS_PATH"];
    else process.env["ACCOUNTS_PATH"] = prevAccountsPath;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enriches the stored account with the live plan and code-access flag", async () => {
    const snapshots = await loadGrokHealthSnapshotsWithSubscription({
      now,
      grokHome: "/tmp/missing-grok-home",
      fileExists: () => false,
      fetchSubscription: async () => ({ ok: true, subscriptionTier: "GrokPro", hasCodeAccess: true }),
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      id: "grok",
      tier: 1,
      subscriptionTier: "GrokPro",
      hasCodeAccess: true,
    });
  });

  it("keeps the access-token tier fallback when the live lookup fails", async () => {
    const snapshots = await loadGrokHealthSnapshotsWithSubscription({
      now,
      grokHome: "/tmp/missing-grok-home",
      fileExists: () => false,
      fetchSubscription: async () => ({ ok: false, reason: "network" }),
    });
    expect(snapshots[0]).toMatchObject({ id: "grok", tier: 1 });
    expect(snapshots[0]?.subscriptionTier).toBeUndefined();
    expect(snapshots[0]?.hasCodeAccess).toBeUndefined();
  });
});

describe("mergeGrokIntoHealth", () => {
  it("appends Grok when the proxy health payload has none", async () => {
    const { mergeGrokIntoHealth } = await import("../providers/xai/overview.js");
    const merged = mergeGrokIntoHealth({
      accounts: [{ provider: "anthropic_subscription" as const }],
      operational: {
        providers: {
          anthropic: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
          openai: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
        },
      },
    }, [{
      id: "grok",
      provider: "xai_subscription",
      enabled: true,
      healthy: true,
      busy: true,
      inFlightRequests: 0,
      activeSessions: 2,
      requestCount: 0,
      errorCount: 0,
      expiresInMs: 60_000,
      lastUsedMs: 0,
      lastRefreshMs: 0,
      tier: 1,
    }]);
    expect(merged.accounts).toHaveLength(2);
    expect(merged.accounts[1]).toMatchObject({
      provider: "xai_subscription",
      id: "grok",
      xai: { tier: 1 },
      activeSessions: 2,
    });
    expect(merged.operational?.providers.xai).toEqual({
      configured: true, accounts: 1, healthy: 1, enabled: 1,
    });
  });

  it("does not duplicate Grok when the proxy already sent it", async () => {
    const { mergeGrokIntoHealth } = await import("../providers/xai/overview.js");
    const health = {
      accounts: [{ provider: "xai_subscription" as const, id: "grok" }],
      operational: {
        providers: {
          anthropic: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
          openai: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
          xai: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
        },
      },
    };
    expect(mergeGrokIntoHealth(health, [])).toBe(health);
  });
});
