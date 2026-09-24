import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenPool } from "../proxy/token-pool.js";
import { AnthropicUsageRefresher } from "../providers/anthropic/usage-refresher.js";
import { parseAnthropicUsage } from "../providers/anthropic/usage.js";
import { createUsageResetHandler } from "../proxy/account-usage-reset.js";
import { createClaudeResetConsumer } from "../proxy/claude-usage-reset.js";
import { DEFAULT_RATE_LIMITS, type Account } from "../proxy/types.js";

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())); });
const ORG = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f";
const USER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const REQ = "12345678-1234-4234-8234-123456789abc";
const START = 1_000_000_000_000;
const block = { eligible: true, grants: [{ id: "grant-a", resets_left: 1, clears: ["five_hour", "seven_day"], usable_now: true, use_requires_limit: false }], next_grant_id: "grant-a" };

function makeAccount(): Account {
  return {
    id: "claude-1",
    tokens: { accessToken: "sk-ant-oat01-claude-1", refreshToken: "sk-ant-ort01-claude-1", expiresAt: Date.now() + 3_600_000, scopes: ["user:inference", "user:profile"] },
    healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0, consecutiveErrors: 0,
    rateLimits: { ...DEFAULT_RATE_LIMITS, status: "allowed" },
    enabled: true, sessionLimitPercent: 100, weeklyLimitPercent: 100,
  };
}

async function run(kind: "quota" | "overload") {
  const clock = { now: START, seq: 0 };
  const a = makeAccount();
  const pool = new TokenPool([a], { now: () => clock.now, nextSequence: () => ++clock.seq });
  a.rateLimits.usage = parseAnthropicUsage({ five_hour: { utilization: 100 }, cedar_ember: block }, clock.now, ++clock.seq)!;
  pool.setGlobalCooldownForAccount(a, 3_600_000, "five_hour");
  if (kind === "overload") pool.setGlobalCooldownForAccount(a, 30_000); // unscoped overload hold
  expect(pool.tryAcquire(a.id)).toBeNull();
  const refresher = new AnthropicUsageRefresher(pool, {
    now: () => clock.now,
    fetchUsage: async () => ({ ok: true, snapshot: parseAnthropicUsage({ five_hour: { utilization: 0 }, seven_day: { utilization: 0 }, cedar_ember: { ...block, grants: [] } }, clock.now, ++clock.seq)! }),
  });
  const consume = vi.fn().mockResolvedValue({ code: "reset", resetsLeft: 0 });
  const app = express(); app.use(express.json());
  app.post("/:id/reset-usage", createUsageResetHandler({
    provider: "anthropic",
    findAccount: id => pool.findById(id) ?? undefined,
    prepare: async () => true,
    consume: createClaudeResetConsumer({ identity: async () => ({ org: ORG, principal: USER }), consume }),
    refresh: account => refresher.refreshAfterCurrent(account),
  }));
  const server = createServer(app); servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${port}/${a.id}/reset-usage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redeemRequestId: REQ, offer: { useBy: 0, clears: ["five_hour", "seven_day"], clearsOther: false } }),
  });
  return { a, pool, clock, response, consume };
}

describe("confirmed Claude reset routing recovery", () => {
  it("releases a five-hour quota cooldown once fresh usage shows headroom", async () => {
    const { a, pool, response, consume } = await run("quota");
    expect(await response.json()).toEqual({ reset: { provider: "anthropic", code: "reset", resetsLeft: 0, usageRefreshed: true, replay: false } });
    expect(consume).toHaveBeenCalledWith(a, ORG, "grant-a", REQ);
    const lease = pool.tryAcquire(a.id);
    expect(lease).not.toBeNull();
    lease?.release();
  });
  it("keeps an unrelated overload hold", async () => {
    const { a, pool, clock } = await run("overload");
    expect(pool.tryAcquire(a.id)).toBeNull();
    clock.now += 31_000;
    const lease = pool.tryAcquire(a.id);
    expect(lease).not.toBeNull();
    lease?.release();
  });
});
