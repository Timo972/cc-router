import { describe, expect, it, vi } from "vitest";
import { applyCodexFailureRouting } from "../providers/openai/failure-routing.js";
import { applyCodexRateLimits, createOpenAIAccount } from "../providers/openai/account-state.js";
import { parseCodexRateLimits } from "../providers/openai/usage.js";

const NOW_MS = 1_754_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function makeAccount() {
  return createOpenAIAccount({
    id: "openai-a",
    provider: "openai_subscription",
    accessToken: "header.e30.sig",
    refreshToken: "rt",
    expiresAt: NOW_MS + 3_600_000,
    enabled: true,
  });
}

function makePool() {
  return {
    setGlobalCooldownForAccount: vi.fn(),
    setBucketCooldownForAccount: vi.fn(),
  };
}

function makeRouter() {
  return { invalidate: vi.fn().mockReturnValue(true) };
}

describe("applyCodexFailureRouting", () => {
  it("does nothing for success statuses", () => {
    const pool = makePool();
    const router = makeRouter();
    const result = applyCodexFailureRouting(200, {}, { account: makeAccount() }, undefined, router, pool, () => NOW_MS);
    expect(result).toEqual({});
    expect(router.invalidate).not.toHaveBeenCalled();
  });

  it("429 without x-codex-active-limit sets an account-global cooldown (default 60s) and invalidates the binding", () => {
    const account = makeAccount();
    const pool = makePool();
    const router = makeRouter();
    const result = applyCodexFailureRouting(
      429, {},
      { account, sessionId: "s1", bindingGeneration: 7 },
      "gpt-5.6-sol", router, pool, () => NOW_MS,
    );
    expect(router.invalidate).toHaveBeenCalledWith("s1", "openai-a", 7);
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 60_000);
    expect(result).toEqual({ cooldownSeconds: 60, limitingScope: "global" });
    expect(account.rateLimits.status).toBe("rate_limited");
  });

  it("429 with a named active limit sets a bucket cooldown and learns the model mapping", () => {
    const account = makeAccount();
    const pool = makePool();
    const result = applyCodexFailureRouting(
      429,
      { "x-codex-active-limit": "codex-bengalfox" },
      { account },
      "gpt-5.6-sol", makeRouter(), pool, () => NOW_MS,
    );
    expect(pool.setBucketCooldownForAccount).toHaveBeenCalledWith(account, "codex_bengalfox", 60_000);
    expect(pool.setGlobalCooldownForAccount).not.toHaveBeenCalled();
    expect(account.modelBuckets.get("gpt-5.6-sol")).toBe("codex_bengalfox");
    expect(result.limitingScope).toBe("bucket:codex_bengalfox");
    expect(account.rateLimits.status).toBe("ok"); // named-bucket 429 is not account-global
  });

  it("prefers Retry-After over a reset header for a window that isn't reported exhausted", () => {
    const account = makeAccount();
    const pool = makePool();
    applyCodexFailureRouting(
      429,
      {
        "retry-after": "120",
        "x-codex-primary-reset-at": String(NOW_SEC + 600),
      },
      { account }, undefined, makeRouter(), pool, () => NOW_MS,
    );
    // The primary-reset header carries no accompanying used-percent, so that
    // window isn't known to be exhausted — Retry-After is the only trusted
    // candidate, not the furthest-out reset merely because it was mentioned.
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 120_000);
  });

  it("waits out only the reset(s) of windows reported exhausted (used-percent >= 100)", () => {
    const account = makeAccount();
    const pool = makePool();
    applyCodexFailureRouting(
      429,
      {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-at": String(NOW_SEC + 18_000), // 5h window, exhausted
        "x-codex-secondary-reset-at": String(NOW_SEC + 604_800), // 7d window, not reported exhausted
      },
      { account }, undefined, makeRouter(), pool, () => NOW_MS,
    );
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 18_000_000);
  });

  it("waits out the later reset when both windows are reported exhausted", () => {
    const account = makeAccount();
    const pool = makePool();
    applyCodexFailureRouting(
      429,
      {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-at": String(NOW_SEC + 18_000), // 5h window, exhausted
        "x-codex-secondary-used-percent": "100",
        "x-codex-secondary-reset-at": String(NOW_SEC + 604_800), // 7d window, exhausted
      },
      { account }, undefined, makeRouter(), pool, () => NOW_MS,
    );
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 604_800_000);
  });

  it("falls back to the soonest known window reset when nothing is reported exhausted", () => {
    const account = makeAccount();
    const pool = makePool();
    applyCodexFailureRouting(
      429,
      {
        "x-codex-primary-reset-at": String(NOW_SEC + 18_000), // 5h window
        "x-codex-secondary-reset-at": String(NOW_SEC + 604_800), // 7d window
      },
      { account }, undefined, makeRouter(), pool, () => NOW_MS,
    );
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 18_000_000);
  });

  it("uses the snapshot bucket reset when headers carry none", () => {
    const account = makeAccount();
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(NOW_SEC + 300),
    }, NOW_MS), NOW_MS);
    const pool = makePool();
    applyCodexFailureRouting(429, {}, { account }, undefined, makeRouter(), pool, () => NOW_MS);
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 300_000);
  });

  it("rejects absurdly distant and negative evidence, falling back to the default", () => {
    const account = makeAccount();
    const pool = makePool();
    applyCodexFailureRouting(
      429,
      { "retry-after": "-5", "x-codex-primary-reset-at": String(NOW_SEC + 365 * 24 * 3600) },
      { account }, undefined, makeRouter(), pool, () => NOW_MS,
    );
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 60_000);
  });

  it("401 and overload (503/529) set short account-global cooldowns and invalidate the binding", () => {
    const account = makeAccount();
    const pool = makePool();
    const router = makeRouter();
    const route = { account, sessionId: "s1", bindingGeneration: 1 };
    expect(applyCodexFailureRouting(401, {}, route, undefined, router, pool, () => NOW_MS).cooldownSeconds).toBe(30);
    expect(applyCodexFailureRouting(503, {}, route, undefined, router, pool, () => NOW_MS).cooldownSeconds).toBe(30);
    expect(applyCodexFailureRouting(529, {}, route, undefined, router, pool, () => NOW_MS).cooldownSeconds).toBe(30);
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledTimes(3);
    expect(router.invalidate).toHaveBeenCalledTimes(3);
  });

  it("an isolated 5xx (e.g. 500) is a no-op: no cooldown, no binding invalidation", () => {
    const account = makeAccount();
    const pool = makePool();
    const router = makeRouter();
    const result = applyCodexFailureRouting(
      500, {}, { account, sessionId: "s1", bindingGeneration: 1 }, undefined, router, pool, () => NOW_MS,
    );
    expect(result).toEqual({});
    expect(pool.setGlobalCooldownForAccount).not.toHaveBeenCalled();
    expect(pool.setBucketCooldownForAccount).not.toHaveBeenCalled();
    expect(router.invalidate).not.toHaveBeenCalled();
  });
});
