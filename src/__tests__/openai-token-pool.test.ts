import { describe, expect, it, vi } from "vitest";
import { EmptyPoolError, NoEligibleAccountError } from "../proxy/account-pool.js";
import { createOpenAIAccount, applyCodexRateLimits, learnModelBucket } from "../providers/openai/account-state.js";
import type { OpenAIAccount } from "../providers/openai/account-state.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { parseCodexRateLimits } from "../providers/openai/usage.js";

const NOW_MS = 1_754_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function makeAccount(id: string, overrides: Partial<OpenAIAccount> = {}): OpenAIAccount {
  return {
    ...createOpenAIAccount({
      id,
      provider: "openai_subscription",
      accessToken: "header.e30.sig",
      refreshToken: "rt",
      expiresAt: NOW_MS + 3_600_000,
      enabled: true,
    }),
    ...overrides,
  };
}

function applyHeaders(account: OpenAIAccount, headers: Record<string, string>, nowMs = NOW_MS): void {
  applyCodexRateLimits(account, parseCodexRateLimits(headers, nowMs), nowMs);
}

describe("OpenAITokenPool eligibility", () => {
  it("throws EmptyPoolError for an empty pool", () => {
    const pool = new OpenAITokenPool([], { now: () => NOW_MS });
    expect(() => pool.acquireBest(new Map())).toThrow(EmptyPoolError);
  });

  it("excludes an account whose default primary window is exhausted", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    applyHeaders(a, {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(NOW_SEC + 600),
    });
    const pool = new OpenAITokenPool([a, b], { now: () => NOW_MS });
    expect(pool.acquireBest(new Map()).account.id).toBe("b");
  });

  it("excludes an account whose default secondary window is exhausted", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    applyHeaders(a, { "x-codex-secondary-used-percent": "100" });
    const pool = new OpenAITokenPool([a, b], { now: () => NOW_MS });
    expect(pool.acquireBest(new Map()).account.id).toBe("b");
  });

  it("throws NoEligibleAccountError with reason and retryAtMs when all are exhausted", () => {
    const a = makeAccount("a");
    applyHeaders(a, {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(NOW_SEC + 600),
    });
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    try {
      pool.acquireBest(new Map());
      expect.unreachable("acquireBest should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NoEligibleAccountError);
      const typed = error as NoEligibleAccountError;
      expect(typed.reason).toBe("rate_limited");
      expect(typed.retryAtMs).toBe((NOW_SEC + 600) * 1000);
    }
  });

  it("a model-mapped named bucket at 100% blocks only that model", () => {
    const a = makeAccount("a");
    applyHeaders(a, {
      "x-codex-primary-used-percent": "10",
      "x-codex-bengalfox-primary-used-percent": "100",
      "x-codex-bengalfox-primary-reset-at": String(NOW_SEC + 600),
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    });
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });

    expect(() => pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-sol" }))
      .toThrow(NoEligibleAccountError);
    expect(pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-luna" }).account.id).toBe("a");
    expect(pool.acquireBest(new Map()).account.id).toBe("a");
  });
});

describe("OpenAITokenPool cooldowns", () => {
  it("global cooldown excludes the account and expires", () => {
    let now = NOW_MS;
    const a = makeAccount("a");
    const pool = new OpenAITokenPool([a], { now: () => now });
    pool.setGlobalCooldownForAccount(a, 60_000);
    expect(() => pool.acquireBest(new Map())).toThrow(NoEligibleAccountError);
    now += 61_000;
    expect(pool.acquireBest(new Map()).account.id).toBe("a");
  });

  it("bucket cooldown excludes only requests for the mapped model", () => {
    const a = makeAccount("a");
    applyHeaders(a, {
      "x-codex-bengalfox-primary-used-percent": "50",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    });
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    pool.setBucketCooldownForAccount(a, "codex_bengalfox", 60_000);

    expect(() => pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-sol" }))
      .toThrow(NoEligibleAccountError);
    expect(pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-luna" }).account.id).toBe("a");
    const view = pool.getCooldownView("a");
    expect(view.globalUntilMs).toBe(0);
    expect(view.bucketCooldowns).toEqual([{ limitId: "codex_bengalfox", untilMs: NOW_MS + 60_000 }]);
  });

  it("enforces a header-only 429's cooldown while the model's old bucket is still live", () => {
    let now = NOW_MS;
    const a = makeAccount("a");
    // Healthy and still being reported by upstream, so nothing reaps it.
    applyHeaders(a, {
      "x-codex-bengalfox-primary-used-percent": "50",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    });
    const pool = new OpenAITokenPool([a], { now: () => now });
    expect(pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-sol" }).account.id).toBe("a");

    // Upstream moves the model to a new limit id and says so with a 429 that
    // carries no rate-limit snapshot — only the active limit and Retry-After.
    now += 1000;
    learnModelBucket(a, "gpt-5.6-sol", "codex_newfox", now);
    pool.setBucketCooldownForAccount(a, "codex_newfox", 60_000);

    expect(() => pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-sol" }))
      .toThrow(NoEligibleAccountError);
    // Scoped to the model that was limited, not the whole account.
    expect(pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-luna" }).account.id).toBe("a");
  });

  it("enforces a 429's cooldown when its mapping ties with the snapshot it arrived with", () => {
    const a = makeAccount("a");
    // One 429 carrying rate-limit headers and an active limit: the snapshot it
    // refreshes and the mapping it learns are stamped from the same `now`.
    applyHeaders(a, {
      "x-codex-bengalfox-primary-used-percent": "50",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    });
    learnModelBucket(a, "gpt-5.6-sol", "codex_newfox", NOW_MS);
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    pool.setBucketCooldownForAccount(a, "codex_newfox", 60_000);

    expect(() => pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-sol" }))
      .toThrow(NoEligibleAccountError);
  });

  it("enforces the active-limit bucket cooldown when two buckets tie on last-seen", () => {
    const a = makeAccount("a");
    // Both buckets name the model and arrive in the same response, so they
    // share a `lastSeenAt`.
    applyHeaders(a, {
      "x-codex-bengalfox-primary-used-percent": "50",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
      "x-codex-newfox-primary-used-percent": "50",
      "x-codex-newfox-limit-name": "gpt-5.6-sol",
    });
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });

    // The 429 named codex_newfox active, so that is the bucket holding the
    // cooldown — resolving the model to its tied sibling would lose it.
    learnModelBucket(a, "gpt-5.6-sol", "codex_newfox", NOW_MS);
    pool.setBucketCooldownForAccount(a, "codex_newfox", 60_000);

    expect(() => pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-sol" }))
      .toThrow(NoEligibleAccountError);
  });

  it("enforces a new bucket's cooldown after the model's old bucket was retained and reaped", () => {
    let now = NOW_MS;
    const a = makeAccount("a");
    applyHeaders(a, {
      "x-codex-bengalfox-primary-used-percent": "100",
      "x-codex-bengalfox-primary-reset-at": String(NOW_SEC + 60),
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    });
    const pool = new OpenAITokenPool([a], { now: () => now });
    // A cooldown that outlives the window it came from.
    pool.setBucketCooldownForAccount(a, "codex_bengalfox", 10 * 60_000);

    // The window resets first; the bucket is held back by the live cooldown.
    now += 2 * 60_000;
    expect(() => pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-sol" }))
      .toThrow(NoEligibleAccountError);

    // The cooldown lapses, and upstream has since moved the model to a
    // different limit id — reported by a header-only 429, so the new bucket
    // has a cooldown and a mapping but no snapshot of its own.
    now += 9 * 60_000;
    learnModelBucket(a, "gpt-5.6-sol", "codex_newfox", now);
    pool.setBucketCooldownForAccount(a, "codex_newfox", 60_000);

    // The old bucket is a zeroed corpse upstream has stopped mentioning. If
    // it survives, it outranks the new mapping in bucketIdForModel and the
    // account is handed out for a model upstream just rate-limited.
    expect(() => pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-sol" }))
      .toThrow(NoEligibleAccountError);
    expect(a.rateLimits.buckets.has("codex_bengalfox")).toBe(false);

    // Once that cooldown lapses too, the model routes again.
    now += 61_000;
    expect(pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-sol" }).account.id).toBe("a");
  });

  it("makes room for a new bucket cooldown by dropping expired entries, not live ones", () => {
    let now = NOW_MS;
    const a = makeAccount("a");
    learnModelBucket(a, "model-live", "codex_live_0", NOW_MS);
    const pool = new OpenAITokenPool([a], { now: () => now });

    // One short cooldown that lapses, then fill the cap with long ones. The
    // lapsed entry is what should make room for the 17th — a live cooldown
    // must not be sacrificed while an expired one is still sitting there.
    pool.setBucketCooldownForAccount(a, "codex_expired", 1_000);
    for (let i = 0; i < 15; i++) {
      pool.setBucketCooldownForAccount(a, `codex_live_${i}`, 60 * 60_000);
    }
    now += 2_000;
    pool.setBucketCooldownForAccount(a, "codex_new", 60 * 60_000);

    // Enforcement, not the display view (which caps its own list length).
    expect(() => pool.acquireBest(new Map(), { requestedModel: "model-live" }))
      .toThrow(NoEligibleAccountError);
  });

  it("evicts the soonest-to-expire bucket cooldown when every entry is still live", () => {
    const a = makeAccount("a");
    learnModelBucket(a, "model-soonest", "codex_soonest", NOW_MS);
    learnModelBucket(a, "model-longest", "codex_live_0", NOW_MS);
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });

    // 16 live entries with codex_soonest the shortest, so it has the least
    // protection left to lose and is dropped to make room for the 17th.
    pool.setBucketCooldownForAccount(a, "codex_soonest", 60_000);
    for (let i = 0; i < 15; i++) {
      pool.setBucketCooldownForAccount(a, `codex_live_${i}`, 60 * 60_000);
    }
    pool.setBucketCooldownForAccount(a, "codex_new", 60 * 60_000);

    // The evicted bucket no longer blocks its model; a retained one still does.
    expect(pool.acquireBest(new Map(), { requestedModel: "model-soonest" }).account.id).toBe("a");
    expect(() => pool.acquireBest(new Map(), { requestedModel: "model-longest" }))
      .toThrow(NoEligibleAccountError);
  });

  it("enforces a bucket cooldown learned from a header-only 429 with no bucket snapshot", () => {
    const a = makeAccount("a");
    // Mirrors what applyCodexFailureRouting does for a 429 whose headers name
    // an active limit but carry no rate-limit snapshot for it: the model is
    // mapped to a limitId, and a cooldown is set on that limitId, without any
    // entry ever landing in account.rateLimits.buckets.
    learnModelBucket(a, "gpt-5.6-sol", "codex_bengalfox", NOW_MS);
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    pool.setBucketCooldownForAccount(a, "codex_bengalfox", 60_000);

    expect(() => pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-sol" }))
      .toThrow(NoEligibleAccountError);
    expect(pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-luna" }).account.id).toBe("a");
  });

  it("keeps a named bucket's snapshot and mapping alive via an active cooldown even after its windows fully clear", () => {
    let now = NOW_MS;
    const a = makeAccount("a");
    applyHeaders(a, {
      "x-codex-bengalfox-primary-used-percent": "100",
      "x-codex-bengalfox-primary-reset-at": String(NOW_SEC + 60),
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    });
    const pool = new OpenAITokenPool([a], { now: () => now });
    pool.setBucketCooldownForAccount(a, "codex_bengalfox", 10 * 60_000); // 10 minutes, set at NOW_MS

    // Advance past the window's own 60s reset. A bare sweep would clear the
    // window, but the pool-level cooldown on this limitId is still active for
    // several more minutes, so the sweep must retain both the snapshot and
    // the model mapping — and the model must stay blocked via the cooldown.
    now = NOW_MS + 61_000;
    expect(() => pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-sol" }))
      .toThrow(NoEligibleAccountError);
    expect(pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-luna" }).account.id).toBe("a");
    expect(a.rateLimits.buckets.has("codex_bengalfox")).toBe(true);
    expect(a.modelBuckets.get("gpt-5.6-sol")?.limitId).toBe("codex_bengalfox");
  });

  it("getGlobalCooldownUntil/isCoolingDown reflect only the global scope, not a shorter bucket cooldown", () => {
    const a = makeAccount("a");
    applyHeaders(a, {
      "x-codex-bengalfox-primary-used-percent": "50",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    });
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    pool.setGlobalCooldownForAccount(a, 60 * 60_000); // 1h global
    pool.setBucketCooldownForAccount(a, "codex_bengalfox", 60_000); // 60s bucket, expires sooner

    expect(pool.getGlobalCooldownUntil("a")).toBe(NOW_MS + 60 * 60_000);
    expect(pool.isCoolingDown("a")).toBe(true);
  });

  it("a bucket-only cooldown does not mark the account as globally cooling down", () => {
    const a = makeAccount("a");
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    pool.setBucketCooldownForAccount(a, "codex_bengalfox", 60_000);

    expect(pool.getGlobalCooldownUntil("a")).toBe(0);
    expect(pool.isCoolingDown("a")).toBe(false);
  });
});

describe("OpenAITokenPool selection and caps", () => {
  it("prefers the account with fewer in-flight requests, then sessions, then headroom", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    applyHeaders(a, { "x-codex-primary-used-percent": "80" });
    applyHeaders(b, { "x-codex-primary-used-percent": "10" });
    const pool = new OpenAITokenPool([a, b], { now: () => NOW_MS });
    expect(pool.acquireBest(new Map()).account.id).toBe("b");

    const leaseB = pool.tryAcquire("b");
    expect(leaseB).not.toBeNull(); // b now has 1 in flight
    expect(pool.acquireBest(new Map()).account.id).toBe("a");
  });

  it("marks a cap-bypass lease as fallback and fires onCapBypass", () => {
    const a = makeAccount("a", { sessionLimitPercent: 50 });
    applyHeaders(a, { "x-codex-primary-used-percent": "60" });
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    const onCapBypass = vi.fn();
    pool.onCapBypass = onCapBypass;

    const lease = pool.acquireBest(new Map());
    expect(lease.fallback).toBe(true);
    expect(onCapBypass).toHaveBeenCalledWith(a);
  });

  it("a zero cap makes the account a cap-bypass candidate, never within caps", () => {
    const a = makeAccount("a", { sessionLimitPercent: 0 });
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    expect(pool.acquireBest(new Map()).fallback).toBe(true);
  });
});

describe("OpenAITokenPool leases", () => {
  it("release is idempotent and never negative", () => {
    const a = makeAccount("a");
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    const lease = pool.acquireBest(new Map());
    expect(pool.getInFlight("a")).toBe(1);
    lease.release();
    lease.release();
    expect(pool.getInFlight("a")).toBe(0);
  });

  it("tryAcquire returns null for disabled, unhealthy, cooling, or capped accounts", () => {
    const a = makeAccount("a");
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    pool.setGlobalCooldownForAccount(a, 60_000);
    expect(pool.tryAcquire("a")).toBeNull();
  });

  it("forgetAccount clears in-flight state so a re-added id starts clean", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    const accounts = [a, b];
    const pool = new OpenAITokenPool(accounts, { now: () => NOW_MS });

    const lease = pool.acquireBest(new Map());
    expect(pool.getInFlight(lease.account.id)).toBe(1);

    // Delete mid-flight, exactly as deleteOpenAIAccountTransaction does.
    accounts.splice(accounts.indexOf(lease.account), 1);
    pool.forgetAccount(lease.account);
    // The lease's own release() no-ops now that the account is gone, so the
    // counter must already have been cleared by forgetAccount.
    lease.release();

    expect(pool.getInFlight(lease.account.id)).toBe(0);
  });

  it("forgetAccount drops the removed account's cooldown state", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    const accounts = [a, b];
    const pool = new OpenAITokenPool(accounts, { now: () => NOW_MS });

    pool.setGlobalCooldownForAccount(a, 60_000);
    expect(pool.getGlobalCooldownUntil("a")).toBeGreaterThan(0);

    accounts.splice(0, 1);
    pool.forgetAccount(a);

    expect(pool.getGlobalCooldownUntil("a")).toBe(0);
    expect(pool.getCooldownView("a")).toEqual({ globalUntilMs: 0, bucketCooldowns: [] });
  });
});
