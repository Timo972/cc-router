import { describe, expect, it, vi } from "vitest";
import { createAccountRefreshRunner, type AccountRefreshHooks } from "../proxy/account-refresh.js";
import { DEFAULT_RATE_LIMITS, type Account } from "../proxy/types.js";

const anthropic: Account = {
  id: "a", tokens: { accessToken: "x", refreshToken: "r", expiresAt: 10, scopes: ["user:inference", "user:profile"] },
  healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0, consecutiveErrors: 0,
  rateLimits: { ...DEFAULT_RATE_LIMITS }, enabled: true, sessionLimitPercent: 100, weeklyLimitPercent: 100,
};

function hooks(over: Partial<AccountRefreshHooks> = {}): AccountRefreshHooks {
  return {
    findAnthropic: id => (id === "a" ? anthropic : null),
    findOpenAI: () => undefined,
    anthropicTokenDue: () => false,
    refreshAnthropicToken: vi.fn(async () => true),
    refreshAnthropicUsage: vi.fn(async () => ({ ok: true })),
    openAITokenDue: () => false,
    refreshOpenAIToken: vi.fn(async () => true),
    refreshOpenAIUsage: vi.fn(async () => ({ ok: true })),
    refreshIdentity: vi.fn(async () => {}),
    now: () => 0,
    ...over,
  };
}

describe("createAccountRefreshRunner", () => {
  it("returns null for an unknown id", async () => {
    await expect(createAccountRefreshRunner(hooks())("nope")).resolves.toBeNull();
  });

  it("refreshes usage and identity, and reports tokenRefreshed null when no refresh was due", async () => {
    const h = hooks();
    const result = await createAccountRefreshRunner(h)("a");
    expect(result).toEqual({ id: "a", tokenRefreshed: null, usageRefreshed: true, durationMs: 0 });
    expect(h.refreshAnthropicToken).not.toHaveBeenCalled();
    expect(h.refreshIdentity).toHaveBeenCalledTimes(1);
  });

  it("refreshes the token first when due", async () => {
    const h = hooks({ anthropicTokenDue: () => true });
    const result = await createAccountRefreshRunner(h)("a");
    expect(result?.tokenRefreshed).toBe(true);
    expect(h.refreshAnthropicToken).toHaveBeenCalledWith(anthropic);
  });

  it("reports tokenRefreshed false when a due token cannot be refreshed", async () => {
    // How a token-only (setup-token) account reads once it has passed its
    // expiry: the step marks it re-auth required and reports no refresh.
    const h = hooks({ anthropicTokenDue: () => true, refreshAnthropicToken: vi.fn(async () => false) });
    const result = await createAccountRefreshRunner(h)("a");
    expect(result).toMatchObject({ tokenRefreshed: false, usageRefreshed: true });
  });

  it("does not fail the whole refresh when usage fails", async () => {
    const h = hooks({ refreshAnthropicUsage: vi.fn(async () => { throw new Error("boom"); }) });
    await expect(createAccountRefreshRunner(h)("a")).resolves.toMatchObject({ usageRefreshed: false });
  });

  it("does not fail the whole refresh when the token step throws", async () => {
    const h = hooks({
      anthropicTokenDue: () => true,
      refreshAnthropicToken: vi.fn(async () => { throw new Error("boom"); }),
    });
    await expect(createAccountRefreshRunner(h)("a")).resolves.toMatchObject({ tokenRefreshed: false, usageRefreshed: true });
  });

  it("does not fail the whole refresh when the identity step throws", async () => {
    const h = hooks({ refreshIdentity: vi.fn(async () => { throw new Error("boom"); }) });
    await expect(createAccountRefreshRunner(h)("a")).resolves.toMatchObject({ usageRefreshed: true });
  });

  it("refreshes an OpenAI account through the OpenAI hooks", async () => {
    const openai = { id: "o" } as never;
    const h = hooks({
      findAnthropic: () => null,
      findOpenAI: id => (id === "o" ? openai : undefined),
      openAITokenDue: () => true,
    });
    const result = await createAccountRefreshRunner(h)("o");
    expect(result).toMatchObject({ id: "o", tokenRefreshed: true, usageRefreshed: true });
    expect(h.refreshOpenAIToken).toHaveBeenCalledWith(openai);
    expect(h.refreshAnthropicUsage).not.toHaveBeenCalled();
  });

  it("single-flights concurrent refreshes of one id", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const h = hooks({ refreshAnthropicUsage: vi.fn(async () => { await gate; return { ok: true }; }) });
    const run = createAccountRefreshRunner(h);
    const first = run("a"); const second = run("a");
    release();
    await Promise.all([first, second]);
    expect(h.refreshAnthropicUsage).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh pass once the previous one settled", async () => {
    const h = hooks();
    const run = createAccountRefreshRunner(h);
    await run("a");
    await run("a");
    expect(h.refreshAnthropicUsage).toHaveBeenCalledTimes(2);
  });
});
