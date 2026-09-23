import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { OpenAIUsageRefresher } from "../providers/openai/usage-fetch.js";
import { applyCodexRateLimits, learnModelBucket } from "../providers/openai/account-state.js";
import type { CodexRateLimitsUpdate } from "../providers/openai/usage.js";
import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageResetHandler } from "../proxy/account-usage-reset.js";
import { createOpenAIAccount } from "../providers/openai/account-state.js";
import { ResetNotSubmittedError } from "../proxy/reset-errors.js";

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(resolve => s.close(() => resolve())); });
const requestId = "12345678-1234-4234-8234-123456789abc";
const account = () => createOpenAIAccount({ id: "chatgpt-1", provider: "openai_subscription", enabled: true, accessToken: "secret", refreshToken: "refresh", expiresAt: Date.now() + 60_000 });

async function setup(overrides: Partial<Parameters<typeof createUsageResetHandler>[0]> = {}) {
  const a = account();
  a.rateLimits.resetCredits = { available: 2 };
  const consume = vi.fn().mockResolvedValue({ code: "reset" });
  const refresh = vi.fn().mockResolvedValue({ ok: true, update: { buckets: [] } });
  const app = express();
  app.use(express.json());
  app.post("/:id/reset-usage", createUsageResetHandler({
    provider: "openai", findAccount: id => id === a.id ? a : undefined, prepare: async () => true, consume, refresh, ...overrides,
  }));
  const server = createServer(app); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const post = (id = a.id, redeemRequestId: unknown = requestId) => fetch(`http://127.0.0.1:${address.port}/${id}/reset-usage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redeemRequestId }),
  });
  return { a, post, consume, refresh };
}

describe("account usage reset management route", () => {
  it("targets only the selected account and refreshes after redemption", async () => {
    const { a, post, consume, refresh } = await setup();
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reset: { provider: "openai", code: "reset", usageRefreshed: true, replay: false } });
    expect(consume).toHaveBeenCalledWith(a, requestId);
    expect(refresh).toHaveBeenCalledWith(a);
    expect(a.rateLimits.resetCredits?.available).toBe(2); // no guessed local decrement
  });
  it("marks a second post of the same request id as a replay", async () => {
    const { post, consume } = await setup();
    expect(await (await post()).json()).toMatchObject({ reset: { replay: false } });
    expect(await (await post()).json()).toEqual({ reset: { provider: "openai", code: "reset", usageRefreshed: true, replay: true } });
    expect(consume).toHaveBeenCalledTimes(2);
  });
  it("rejects unknown/non-ChatGPT accounts and invalid request IDs without redemption", async () => {
    const { post, consume } = await setup();
    expect((await post("claude-1")).status).toBe(404);
    expect((await post("chatgpt-1", "")).status).toBe(400);
    expect(consume).not.toHaveBeenCalled();
  });
  it("refuses overlapping redemption IDs for the same account", async () => {
    let release!: (v: { code: "reset" }) => void;
    const consume = vi.fn(() => new Promise<{ code: "reset" }>(resolve => { release = resolve; }));
    const { post } = await setup({ consume });
    const first = post();
    await vi.waitFor(() => expect(consume).toHaveBeenCalledTimes(1));
    expect((await post("chatgpt-1", "12345678-1234-4234-8234-123456789abd")).status).toBe(409);
    release({ code: "reset" });
    expect((await first).status).toBe(200);
    expect(consume).toHaveBeenCalledTimes(1);
  });
  it("keeps the redemption lock when the same account is renamed", async () => {
    const a = account();
    let release!: (v: { code: "reset" }) => void;
    const pending = new Promise<{ code: "reset" }>(resolve => { release = resolve; });
    const consume = vi.fn(() => pending);
    const { post } = await setup({ findAccount: id => a.id === id ? a : undefined, consume });
    const first = post();
    await vi.waitFor(() => expect(consume).toHaveBeenCalledTimes(1));
    a.id = "renamed";
    const second = post("renamed", "12345678-1234-4234-8234-123456789abd");
    // Release both attempts in the broken implementation so teardown cannot hang.
    const early = await Promise.race([second, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
    release({ code: "reset" });
    expect(early?.status).toBe(409);
    expect((await first).status).toBe(200);
    expect(consume).toHaveBeenCalledTimes(1);
  });
  it("does not redeem an account removed while token preparation runs", async () => {
    const a = account(); let present = true;
    const { post, consume } = await setup({ findAccount: () => present ? a : undefined, prepare: async () => { present = false; return true; } });
    expect((await post()).status).toBe(404);
    expect(consume).not.toHaveBeenCalled();
  });
  it("does not confuse a usage refresh failure with a failed redemption", async () => {
    const { post } = await setup({ refresh: async () => { throw new Error("network"); } });
    expect(await (await post()).json()).toEqual({ reset: { provider: "openai", code: "reset", usageRefreshed: false, replay: false } });
  });
  it("keeps limits unchanged and sanitizes errors on an uncertain outcome", async () => {
    const { post, a, refresh } = await setup({ consume: async () => { throw new Error("secret"); } });
    const response = await post();
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    expect(a.rateLimits.resetCredits?.available).toBe(2);
    expect(refresh).not.toHaveBeenCalled();
  });
  it("stops before redeeming when credentials cannot be prepared", async () => {
    const { post, consume } = await setup({ prepare: async () => false });
    expect((await post()).status).toBe(503);
    expect(consume).not.toHaveBeenCalled();
  });
  it("reports a provably unsent redemption with its own status, not as unknown", async () => {
    const { post, refresh } = await setup({ consume: async () => { throw new ResetNotSubmittedError(409, "No reset available for this account"); } });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "No reset available for this account" });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("confirmed reset routing recovery", () => {
  it.each(["global", "bucket", "overload", "new-global", "new-bucket", "unreported", "failed-refresh", "failed-consume"])("reconciles %s safely using the real pool and usage refresher", async kind => {
    let now = Date.now();
    const a = account();
    const pool = new OpenAITokenPool([a], { now: () => now });
    const limitId = kind.includes("bucket") ? "spark" : "codex";
    const context = { requestedModel: "gpt-spark" };
    if (limitId === "spark") learnModelBucket(a, context.requestedModel, "spark", now);
    const update: CodexRateLimitsUpdate = { buckets: [{ limitId, primary: { utilization: 0, resetAt: Math.floor(now / 1000) + 3600, windowMinutes: 300 } }] };
    applyCodexRateLimits(a, { buckets: [{ ...update.buckets[0], primary: { ...update.buckets[0].primary!, utilization: 1 } }] }, now);
    if (limitId === "spark") pool.setBucketCooldownForAccount(a, "spark", 3_600_000);
    else pool.setGlobalCooldownForAccount(a, 3_600_000, "rate_limit");
    if (kind === "overload") pool.setGlobalCooldownForAccount(a, 30_000, "unavailable");
    expect(pool.tryAcquire(a.id, context)).toBeNull();
    const refresher = new OpenAIUsageRefresher(pool, {
      now: () => now,
      fetchUsage: async () => kind === "failed-refresh" ? { ok: false, reason: "network" }
        : { ok: true, update: kind === "unreported" ? { buckets: [] } : update },
    });
    const { post } = await setup({
      findAccount: id => pool.findById(id) ?? undefined,
      captureReset: account => pool.captureUsageReset(account),
      consume: async () => {
        if (kind === "failed-consume") throw new Error("unknown");
        // Same-tick, equal-expiry evidence must still invalidate the snapshot.
        if (kind === "new-global") pool.setGlobalCooldownForAccount(a, 3_600_000, "rate_limit");
        if (kind === "new-bucket") pool.setBucketCooldownForAccount(a, "spark", 3_600_000);
        return { code: "reset" };
      },
      refresh: account => refresher.refreshAfterCurrent(account),
    });
    const response = await post();
    if (kind === "failed-consume") expect(response.status).toBe(502);
    else expect(response.status).toBe(200);
    const lease = pool.tryAcquire(a.id, context);
    if (kind === "global" || kind === "bucket") {
      expect(lease).not.toBeNull();
      lease?.release();
    } else {
      expect(lease).toBeNull();
    }
    if (kind === "overload") {
      expect(pool.getGlobalCooldownUntil(a.id)).toBe(now + 30_000);
      now += 31_000;
      const recovered = pool.tryAcquire(a.id, context);
      expect(recovered).not.toBeNull();
      recovered?.release();
    }
  });
});

describe("uncertain reset replay recovery", () => {
  it.each(["known", "newer-quota", "unknown"])("uses original evidence for %s replays", async kind => {
    const now = Date.now();
    const a = account();
    const pool = new OpenAITokenPool([a], { now: () => now });
    pool.setGlobalCooldownForAccount(a, 3_600_000, "rate_limit");
    const update: CodexRateLimitsUpdate = { buckets: [{ limitId: "codex", primary: { utilization: 0, resetAt: Math.floor(now / 1000) + 3600, windowMinutes: 300 } }] };
    const refresher = new OpenAIUsageRefresher(pool, { now: () => now, fetchUsage: async () => ({ ok: true, update }) });
    let calls = 0;
    const { post } = await setup({
      findAccount: id => pool.findById(id) ?? undefined,
      captureReset: account => pool.captureUsageReset(account),
      consume: async () => {
        if (++calls === 1 && kind !== "unknown") throw new Error("response lost after spending");
        return { code: "already_redeemed" };
      },
      refresh: account => refresher.refreshAfterCurrent(account),
    });
    if (kind !== "unknown") expect((await post()).status).toBe(502);
    if (kind === "newer-quota") pool.setGlobalCooldownForAccount(a, 3_600_000, "rate_limit");
    expect((await post()).status).toBe(200);
    // Losing the first downstream response must not promote an unknown
    // historical replay into trusted evidence on a second identical request.
    if (kind === "unknown") expect((await post()).status).toBe(200);
    const lease = pool.tryAcquire(a.id);
    if (kind === "known") expect(lease).not.toBeNull();
    else expect(lease).toBeNull();
    lease?.release();
  });
});
