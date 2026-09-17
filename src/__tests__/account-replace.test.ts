import { describe, expect, it, vi } from "vitest";
import {
  AccountReplacementConflictError,
  replaceAnthropicAccountTransaction,
  replaceOpenAIAccountTransaction,
} from "../proxy/account-replace.js";
import { TokenPool } from "../proxy/token-pool.js";
import { createOpenAIAccount, type OpenAIAccount } from "../providers/openai/account-state.js";
import type { Account, AccountRecord } from "../proxy/types.js";

function anthropicRecord(id: string, suffix: string): AccountRecord {
  return {
    id,
    provider: "anthropic_subscription",
    accessToken: `sk-ant-oat01-${suffix}`,
    refreshToken: `sk-ant-ort01-${suffix}`,
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    scopes: ["user:inference", "user:profile"],
    enabled: true,
  };
}

function deadPool(id: string): { pool: TokenPool; dead: Account } {
  const pool = new TokenPool([]);
  const dead = pool.addAccount(anthropicRecord(id, "dead"));
  dead.authExpired = true;
  dead.healthy = false;
  return { pool, dead };
}

const noopRouter = { invalidateAccount: vi.fn() };

describe("replaceAnthropicAccountTransaction", () => {
  it("swaps in the new credentials under the same id", async () => {
    const { pool } = deadPool("max-a");

    const added = await replaceAnthropicAccountTransaction({
      record: anthropicRecord("max-a", "fresh"),
      pool,
      sessionRouter: { invalidateAccount: vi.fn() },
      persist: vi.fn(),
    });

    expect(added.tokens.refreshToken).toBe("sk-ant-ort01-fresh");
    expect(pool.getAll()).toHaveLength(1);
    expect(pool.findById("max-a")).toBe(added);
  });

  it("clears the terminal auth state so the account routes again", async () => {
    const { pool } = deadPool("max-b");

    const added = await replaceAnthropicAccountTransaction({
      record: anthropicRecord("max-b", "fresh"),
      pool,
      sessionRouter: { invalidateAccount: vi.fn() },
      persist: vi.fn(),
    });

    expect(added.authExpired).not.toBe(true);
    expect(added.healthy).toBe(true);
  });

  it("persists the pool with the replacement before returning", async () => {
    const { pool } = deadPool("max-c");
    const persist = vi.fn((accounts: Account[]) => {
      expect(accounts.map(a => a.tokens.refreshToken)).toEqual(["sk-ant-ort01-fresh"]);
    });

    await replaceAnthropicAccountTransaction({
      record: anthropicRecord("max-c", "fresh"),
      pool,
      sessionRouter: { invalidateAccount: vi.fn() },
      persist,
    });

    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("restores the previous account when persistence fails", async () => {
    const { pool, dead } = deadPool("max-d");

    await expect(replaceAnthropicAccountTransaction({
      record: anthropicRecord("max-d", "fresh"),
      pool,
      sessionRouter: { invalidateAccount: vi.fn() },
      persist: () => { throw new Error("disk full"); },
    })).rejects.toThrow("disk full");

    // The dead credentials are worthless, but leaving the pool disagreeing
    // with disk is worse: a later whole-pool write would persist a token the
    // operator never installed.
    expect(pool.getAll()).toEqual([dead]);
    expect(pool.findById("max-d")).toBe(dead);
  });

  it("restores the replaced account's cooldown when persistence fails", async () => {
    const { pool, dead } = deadPool("max-cooled");
    pool.setCooldown("max-cooled", 60_000);
    expect(pool.getStats()[0].coolingDown).toBe(true);

    await expect(replaceAnthropicAccountTransaction({
      record: anthropicRecord("max-cooled", "fresh"),
      pool,
      sessionRouter: { invalidateAccount: vi.fn() },
      persist: () => { throw new Error("disk full"); },
    })).rejects.toThrow("disk full");

    // A failed replacement must leave the account exactly as it was. Dropping
    // the cooldown would make a rate-limited account look idle and send it
    // traffic it is still benched for.
    expect(pool.getAll()).toEqual([dead]);
    expect(pool.getStats()[0].coolingDown).toBe(true);
  });

  it("restores the replaced account's in-flight count when persistence fails", async () => {
    // A healthy account, because only a routable one can hold an in-flight
    // request — and replacing a live account is exactly when losing its
    // in-flight count would let the pool over-commit it.
    const pool = new TokenPool([]);
    pool.addAccount(anthropicRecord("max-inflight", "live"));
    const lease = pool.acquireBest(new Map());
    expect(pool.getStats()[0].inFlightRequests).toBe(1);

    await expect(replaceAnthropicAccountTransaction({
      record: anthropicRecord("max-inflight", "fresh"),
      pool,
      sessionRouter: { invalidateAccount: vi.fn() },
      persist: () => { throw new Error("disk full"); },
    })).rejects.toThrow("disk full");

    expect(pool.getStats()[0].inFlightRequests).toBe(1);
    lease.release();
  });

  it("drops sticky sessions pinned to the replaced incarnation", async () => {
    const { pool } = deadPool("max-e");
    const sessionRouter = { invalidateAccount: vi.fn() };

    await replaceAnthropicAccountTransaction({
      record: anthropicRecord("max-e", "fresh"),
      pool,
      sessionRouter,
      persist: vi.fn(),
    });

    expect(sessionRouter.invalidateAccount).toHaveBeenCalledWith("max-e");
  });

  it("does not inherit the replaced account's cooldown", async () => {
    const { pool } = deadPool("max-f");
    pool.setCooldown("max-f", 60_000);

    await replaceAnthropicAccountTransaction({
      record: anthropicRecord("max-f", "fresh"),
      pool,
      sessionRouter: { invalidateAccount: vi.fn() },
      persist: vi.fn(),
    });

    expect(pool.getStats()[0].coolingDown).toBe(false);
  });

  it("rejects when the account is not in the pool", async () => {
    const { pool } = deadPool("max-g");

    await expect(replaceAnthropicAccountTransaction({
      record: anthropicRecord("max-absent", "fresh"),
      pool,
      sessionRouter: noopRouter,
      persist: vi.fn(),
    })).rejects.toThrow(/not found/);
  });

  it("reports a conflict when the account is swapped out mid-replacement", async () => {
    const { pool } = deadPool("max-h");

    await expect(replaceAnthropicAccountTransaction({
      record: anthropicRecord("max-h", "fresh"),
      pool,
      sessionRouter: noopRouter,
      persist: vi.fn(),
      // Stands in for a concurrent delete/replace landing while this one
      // waited for the in-flight refresh to settle.
      reserve: async () => {
        pool.removeAccount("max-h");
        return () => {};
      },
    })).rejects.toThrow(AccountReplacementConflictError);
  });
});

describe("replaceOpenAIAccountTransaction", () => {
  function makeOpenAI(id: string, suffix: string): OpenAIAccount {
    return createOpenAIAccount({
      id,
      provider: "openai_subscription",
      accessToken: `access-${suffix}`,
      refreshToken: `refresh-${suffix}`,
      expiresAt: Date.now() + 60_000,
      enabled: true,
    });
  }

  it("swaps the account in place, preserving pool order", () => {
    const first = makeOpenAI("openai-a", "a");
    const dead = makeOpenAI("openai-b", "dead");
    const last = makeOpenAI("openai-c", "c");
    const accounts = [first, dead, last];

    const added = replaceOpenAIAccountTransaction({
      record: {
        id: "openai-b",
        accessToken: "access-fresh",
        refreshToken: "refresh-fresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      },
      accounts,
      persist: vi.fn(),
    });

    expect(accounts).toEqual([first, added, last]);
    expect(added.refreshToken).toBe("refresh-fresh");
  });

  it("clears a persisted terminal rejection", () => {
    const dead = makeOpenAI("openai-dead", "dead");
    dead.authExpired = true;
    dead.authState = "quarantined";
    dead.authFailure = "permanent";
    const accounts = [dead];

    const added = replaceOpenAIAccountTransaction({
      record: {
        id: "openai-dead",
        accessToken: "access-fresh",
        refreshToken: "refresh-fresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      },
      accounts,
      persist: vi.fn(),
    });

    expect(added.authExpired).toBeUndefined();
    expect(added.authState).toBe("ok");
    expect(added.healthy).toBe(true);
  });

  it("restores the previous account when persistence fails", () => {
    const dead = makeOpenAI("openai-rollback", "dead");
    const accounts = [dead];

    expect(() => replaceOpenAIAccountTransaction({
      record: {
        id: "openai-rollback",
        accessToken: "access-fresh",
        refreshToken: "refresh-fresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      },
      accounts,
      persist: () => { throw new Error("disk full"); },
    })).toThrow("disk full");

    expect(accounts).toEqual([dead]);
  });

  it("forgets the replaced incarnation's routing state and sticky sessions", () => {
    const dead = makeOpenAI("openai-forget", "dead");
    const accounts = [dead];
    const forgetAccount = vi.fn();
    const invalidateAccount = vi.fn();

    replaceOpenAIAccountTransaction({
      record: {
        id: "openai-forget",
        accessToken: "access-fresh",
        refreshToken: "refresh-fresh",
        expiresAt: Date.now() + 60_000,
        enabled: true,
      },
      accounts,
      persist: vi.fn(),
      forgetAccount,
      invalidateAccount,
    });

    expect(forgetAccount).toHaveBeenCalledWith(dead);
    expect(invalidateAccount).toHaveBeenCalledWith("openai-forget");
  });
});
