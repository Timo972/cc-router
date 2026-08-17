import { describe, expect, it, vi } from "vitest";
import { applyCodexFailureRouting } from "../providers/openai/failure-routing.js";
import { applyCodexRateLimits, createOpenAIAccount } from "../providers/openai/account-state.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { NoEligibleAccountError } from "../proxy/account-pool.js";
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
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 60_000, "rate_limit");
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
    expect(account.modelBuckets.get("gpt-5.6-sol")?.limitId).toBe("codex_bengalfox");
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
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 120_000, "rate_limit");
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
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 18_000_000, "rate_limit");
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
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 604_800_000, "rate_limit");
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
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 18_000_000, "rate_limit");
  });

  it("uses the snapshot bucket reset when headers carry none", () => {
    const account = makeAccount();
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(NOW_SEC + 300),
    }, NOW_MS), NOW_MS);
    const pool = makePool();
    applyCodexFailureRouting(429, {}, { account }, undefined, makeRouter(), pool, () => NOW_MS);
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 300_000, "rate_limit");
  });

  it("rejects absurdly distant and negative evidence, falling back to the default", () => {
    const account = makeAccount();
    const pool = makePool();
    applyCodexFailureRouting(
      429,
      { "retry-after": "-5", "x-codex-primary-reset-at": String(NOW_SEC + 365 * 24 * 3600) },
      { account }, undefined, makeRouter(), pool, () => NOW_MS,
    );
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 60_000, "rate_limit");
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
    // None of these is a spent quota, so none may reach a client as a 429.
    for (const call of pool.setGlobalCooldownForAccount.mock.calls) {
      expect(call[2]).toBe("unavailable");
    }
  });

  it("uses a window's reset-at over its relative fallback when both are present", () => {
    const account = makeAccount();
    const pool = makePool();
    const router = makeRouter();

    // The absolute header is authoritative; the relative one is its fallback,
    // not a competing candidate. Taking the larger of the two would hold the
    // account out for an hour on a stale value after upstream said 60s.
    expect(applyCodexFailureRouting(429, {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(NOW_SEC + 60),
      "x-codex-primary-reset-after-seconds": "3600",
    }, { account }, undefined, router, pool, () => NOW_MS).cooldownSeconds).toBe(60);

    // The relative value still applies when the absolute one is unusable —
    // here already in the past — matching how the snapshot is parsed.
    expect(applyCodexFailureRouting(429, {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(NOW_SEC - 5),
      "x-codex-primary-reset-after-seconds": "120",
    }, { account: makeAccount() }, undefined, router, pool, () => NOW_MS).cooldownSeconds).toBe(120);
  });

  it("an overload honors a Retry-After longer than the 30s fallback", () => {
    const account = makeAccount();
    const pool = makePool();
    const router = makeRouter();
    const route = { account, sessionId: "s1", bindingGeneration: 1 };

    // Coming back after 30s to a service that asked for two minutes just
    // produces another 503.
    expect(applyCodexFailureRouting(
      503, { "retry-after": "120" }, route, undefined, router, pool, () => NOW_MS,
    ).cooldownSeconds).toBe(120);
    expect(applyCodexFailureRouting(
      529, { "retry-after": "120" }, route, undefined, router, pool, () => NOW_MS,
    ).cooldownSeconds).toBe(120);
  });

  it("an overload ignores a non-exhausted window's future reset", () => {
    const account = makeAccount();
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "40",
      "x-codex-primary-reset-at": String(NOW_SEC + 3 * 60 * 60),
    }, NOW_MS), NOW_MS);
    const pool = makePool();
    const router = makeRouter();

    // An overload is an availability event. A 5h quota window resetting three
    // hours from now says nothing about how long the blip lasts, and using it
    // would take a healthy account out for those three hours.
    expect(applyCodexFailureRouting(
      503, {}, { account, sessionId: "s1", bindingGeneration: 1 }, undefined, router, pool, () => NOW_MS,
    ).cooldownSeconds).toBe(30);
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

describe("applyCodexFailureRouting over a real pool", () => {
  it("recovers when the cooldown expires even though the 429 carried no reset header", () => {
    // The upstream says "100% used, come back in 120s" but never says when the
    // window itself resets. Left as resetAt 0 that exhausted window reads as an
    // indefinite blocker: it suppresses the retry time clients are given, and
    // it outlives the very cooldown it came with.
    let now = NOW_MS;
    const account = makeAccount();
    const pool = new OpenAITokenPool([account], { now: () => now });
    const router = { invalidate: vi.fn().mockReturnValue(true) };

    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
    }, now), now);

    applyCodexFailureRouting(
      429,
      { "retry-after": "120" },
      { account },
      undefined,
      router,
      pool,
      () => now,
    );

    // Blocked, and the client is told exactly when to retry.
    try {
      pool.acquireBest(new Map());
      expect.unreachable("account should be blocked while cooling");
    } catch (error) {
      expect(error).toBeInstanceOf(NoEligibleAccountError);
      expect((error as NoEligibleAccountError).retryAtMs).toBe(NOW_MS + 120_000);
    }

    // Once that advertised window passes the account routes again, rather than
    // waiting out the multi-hour staleness sweep.
    now += 121_000;
    expect(pool.acquireBest(new Map()).account.id).toBe("openai-a");
  });

  it("leaves a window that already carries a trustworthy reset alone", () => {
    const now = NOW_MS;
    const account = makeAccount();
    const pool = new OpenAITokenPool([account], { now: () => now });

    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(NOW_SEC + 3_600),
    }, now), now);

    applyCodexFailureRouting(
      429,
      { "retry-after": "120" },
      { account },
      undefined,
      { invalidate: vi.fn() },
      pool,
      () => now,
    );

    // The upstream's own reset still governs; it is not overwritten by the
    // shorter Retry-After-derived expiry.
    expect(account.rateLimits.buckets.get("codex")?.primary?.resetAt).toBe(NOW_SEC + 3_600);
  });
});
