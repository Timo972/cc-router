import { describe, it, expect, beforeEach } from "vitest";
import {
  TokenPool,
  EmptyPoolError,
  NoEligibleAccountError,
} from "../proxy/token-pool.js";
import type { Account, AccountRecord } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";

function makeAccount(id: string, healthy = true, busy = false): Account {
  return {
    id,
    tokens: {
      accessToken: `sk-ant-oat01-${id}`,
      refreshToken: `sk-ant-ort01-${id}`,
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference", "user:profile"],
    },
    healthy,
    busy,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
    rateLimits: { ...DEFAULT_RATE_LIMITS },
    enabled: true,
    sessionLimitPercent: 100,
    weeklyLimitPercent: 100,
  };
}

const SONNET_CONTEXT = {
  requestedModel: "claude-sonnet-4-20250514",
  modelFamily: "sonnet",
} as const;

const OPUS_CONTEXT = {
  requestedModel: "claude-opus-4-20250514",
  modelFamily: "opus",
} as const;

function addModelLimit(
  account: Account,
  modelFamily: string,
  utilization: number,
  resetAt: number,
): void {
  account.rateLimits.usage = {
    modelLimits: [{
      kind: "weekly_scoped",
      group: "weekly",
      modelFamily,
      displayName: modelFamily,
      utilization,
      resetAt,
      active: true,
      severity: "",
    }],
    fetchedAt: 1,
    fetchStatus: "fresh",
  };
}

describe("TokenPool — round-robin", () => {
  it("cycles through all healthy accounts in order", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b"), makeAccount("c")]);
    const ids = Array.from({ length: 4 }, () => pool.getNext().id);
    expect(ids).toEqual(["a", "b", "c", "a"]);
  });

  it("wraps back to first account after the last", () => {
    const pool = new TokenPool([makeAccount("x"), makeAccount("y")]);
    expect(pool.getNext().id).toBe("x");
    expect(pool.getNext().id).toBe("y");
    expect(pool.getNext().id).toBe("x");
  });

  it("increments requestCount on every getNext()", () => {
    const pool = new TokenPool([makeAccount("a")]);
    pool.getNext();
    pool.getNext();
    pool.getNext();
    expect(pool.getAll()[0].requestCount).toBe(3);
  });

  it("updates lastUsed timestamp on every getNext()", () => {
    const before = Date.now();
    const pool = new TokenPool([makeAccount("a")]);
    pool.getNext();
    expect(pool.getAll()[0].lastUsed).toBeGreaterThanOrEqual(before);
  });
});

describe("TokenPool — request leases", () => {
  it("tracks a request until its lease is released exactly once", () => {
    const pool = new TokenPool([makeAccount("a")]);
    const lease = pool.acquireBest(new Map());

    expect(lease.account.id).toBe("a");
    expect(pool.getInFlight("a")).toBe(1);

    lease.release();
    lease.release();
    expect(pool.getInFlight("a")).toBe(0);
  });

  it("prefers the account with fewer in-flight requests", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    const first = pool.tryAcquire("a");
    expect(first).not.toBeNull();

    const next = pool.acquireBest(new Map());
    expect(next.account.id).toBe("b");

    first!.release();
    next.release();
  });

  it("uses active session count after in-flight load ties", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    const lease = pool.acquireBest(new Map([["a", 2], ["b", 1]]));
    expect(lease.account.id).toBe("b");
    lease.release();
  });

  it("uses relative rate-limit headroom after load and binding ties", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    a.sessionLimitPercent = 80;
    a.rateLimits.fiveHourUtil = 0.6;
    b.sessionLimitPercent = 80;
    b.rateLimits.fiveHourUtil = 0.2;
    const pool = new TokenPool([a, b]);

    const lease = pool.acquireBest(new Map([["a", 1], ["b", 1]]));
    expect(lease.account.id).toBe("b");
    lease.release();
  });

  it("uses the worse of five-hour and seven-day headroom ratios", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    a.rateLimits.fiveHourUtil = 0.1;
    a.rateLimits.sevenDayUtil = 0.7;
    b.rateLimits.fiveHourUtil = 0.5;
    b.rateLimits.sevenDayUtil = 0.2;
    const pool = new TokenPool([a, b]);

    const lease = pool.acquireBest(new Map());
    expect(lease.account.id).toBe("b");
    lease.release();
  });

  it("rotates exact ties only after selection", () => {
    const pool = new TokenPool([
      makeAccount("a"),
      makeAccount("b"),
      makeAccount("c"),
    ]);

    const ids = Array.from({ length: 4 }, () => {
      const lease = pool.acquireBest(new Map());
      lease.release();
      return lease.account.id;
    });

    expect(ids).toEqual(["a", "b", "c", "a"]);
  });

  it("allows a valid sticky acquisition despite existing in-flight work", () => {
    let now = 2_000;
    const pool = new TokenPool([makeAccount("a")], { now: () => now });
    const first = pool.tryAcquire("a");
    now = 2_500;
    const second = pool.tryAcquire("a");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(pool.getInFlight("a")).toBe(2);
    expect(pool.getAll()[0].requestCount).toBe(2);
    expect(pool.getAll()[0].lastUsed).toBe(2_500);

    first!.release();
    second!.release();
  });

  it("chooses the lowest in-flight account for a user-cap bypass", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    const pool = new TokenPool([a, b]);
    const first = pool.tryAcquire("a");
    a.sessionLimitPercent = 0;
    b.sessionLimitPercent = 0;

    const fallback = pool.acquireBest(new Map());
    expect(fallback.account.id).toBe("b");
    expect(fallback.fallback).toBe(true);

    first!.release();
    fallback.release();
  });

  it("does not let an old lease release a replacement account incarnation", () => {
    const pool = new TokenPool([makeAccount("a")]);
    const oldLease = pool.tryAcquire("a");
    expect(oldLease).not.toBeNull();

    pool.removeAccount("a");
    pool.addAccount({
      id: "a",
      accessToken: "sk-ant-oat01-replacement",
      refreshToken: "sk-ant-ort01-replacement",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference"],
    });
    const replacementLease = pool.tryAcquire("a");
    expect(replacementLease).not.toBeNull();
    expect(pool.getInFlight("a")).toBe(1);

    oldLease!.release();
    expect(pool.getInFlight("a")).toBe(1);

    replacementLease!.release();
    expect(pool.getInFlight("a")).toBe(0);
  });
});

describe("TokenPool — timestamp cooldown", () => {
  it("keeps an account unavailable until its timestamp cooldown expires", () => {
    let now = 1_000;
    const pool = new TokenPool(
      [makeAccount("a"), makeAccount("b")],
      { now: () => now },
    );
    pool.setCooldown("a", 500);
    expect(pool.isEligible("a")).toBe(false);
    expect(pool.isCoolingDown("a")).toBe(true);

    now = 1_500;
    expect(pool.isEligible("a")).toBe(true);
    expect(pool.isCoolingDown("a")).toBe(false);
  });

  it("treats zero-percent caps as ineligible", () => {
    const a = makeAccount("a");
    a.sessionLimitPercent = 0;
    const pool = new TokenPool([a, makeAccount("b")]);

    expect(pool.isEligible("a")).toBe(false);
    expect(pool.tryAcquire("a")).toBeNull();
  });

  it("does not shorten an existing cooldown with a later shorter cooldown", () => {
    let now = 1_000;
    const pool = new TokenPool([makeAccount("a")], { now: () => now });
    pool.setCooldown("a", 60_000);
    pool.setCooldown("a", 30_000);

    now = 32_000;
    expect(pool.isCoolingDown("a")).toBe(true);

    now = 61_000;
    expect(pool.isCoolingDown("a")).toBe(false);
  });

  it("does not let an old account incarnation cool down a replacement with the same ID", () => {
    const oldAccount = makeAccount("a");
    const pool = new TokenPool([oldAccount]);
    pool.removeAccount("a");
    const replacement = pool.addAccount({
      id: "a",
      accessToken: "sk-ant-oat01-replacement",
      refreshToken: "sk-ant-ort01-replacement",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference"],
    });

    pool.setCooldownForAccount(oldAccount, 60_000);

    expect(pool.findById("a")).toBe(replacement);
    expect(pool.isCoolingDown("a")).toBe(false);
  });

  it("applies global cooldowns to every requested model", () => {
    const account = makeAccount("a");
    const pool = new TokenPool([account], { now: () => 1_000 });

    pool.setGlobalCooldownForAccount(account, 60_000);

    expect(pool.isEligible("a", SONNET_CONTEXT)).toBe(false);
    expect(pool.isEligible("a", OPUS_CONTEXT)).toBe(false);
  });

  it("normalizes model cooldowns and applies them only to the matching family", () => {
    const account = makeAccount("a");
    const pool = new TokenPool([account], { now: () => 1_000 });

    pool.setModelCooldownForAccount(account, "Claude Sonnet 4", 60_000);

    expect(pool.isEligible("a", SONNET_CONTEXT)).toBe(false);
    expect(pool.isEligible("a", OPUS_CONTEXT)).toBe(true);
  });

  it("does not turn a named model claim into an account-global status block", () => {
    const account = makeAccount("a");
    account.rateLimits.status = "rate_limited";
    account.rateLimits.claim = "seven_day_sonnet";
    const pool = new TokenPool([account], { now: () => 1_000 });
    pool.setModelCooldownForAccount(account, "sonnet", 60_000);

    expect(pool.isEligible("a", SONNET_CONTEXT)).toBe(false);
    expect(pool.isEligible("a", OPUS_CONTEXT)).toBe(true);
  });

  it("extends but never shortens global and model cooldown expiries", () => {
    let now = 1_000;
    const account = makeAccount("a");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, 60_000);
    pool.setGlobalCooldownForAccount(account, 30_000);
    pool.setModelCooldownForAccount(account, "sonnet", 90_000);
    pool.setModelCooldownForAccount(account, "sonnet", 10_000);

    expect(pool.getApplicableCooldownUntil("a", OPUS_CONTEXT)).toBe(61_000);
    expect(pool.getApplicableCooldownUntil("a", SONNET_CONTEXT)).toBe(91_000);
    now = 61_000;
    expect(pool.getApplicableCooldownUntil("a", OPUS_CONTEXT)).toBe(0);
    expect(pool.getApplicableCooldownUntil("a", SONNET_CONTEXT)).toBe(91_000);
  });

  it("expires exactly the matching model cooldown", () => {
    let now = 1_000;
    const account = makeAccount("a");
    const pool = new TokenPool([account], { now: () => now });
    pool.setModelCooldownForAccount(account, "sonnet", 10_000);
    pool.setModelCooldownForAccount(account, "opus", 20_000);

    now = 11_000;
    expect(pool.getApplicableCooldownUntil("a", SONNET_CONTEXT)).toBe(0);
    expect(pool.getApplicableCooldownUntil("a", OPUS_CONTEXT)).toBe(21_000);
  });

  it("does not carry scoped cooldown state through removal and same-ID replacement", () => {
    const oldAccount = makeAccount("a");
    const pool = new TokenPool([oldAccount], { now: () => 1_000 });
    pool.setGlobalCooldownForAccount(oldAccount, 60_000);
    pool.setModelCooldownForAccount(oldAccount, "sonnet", 90_000);

    pool.removeAccount("a");
    const replacement = pool.addAccount({
      id: "a",
      accessToken: "sk-ant-oat01-replacement",
      refreshToken: "sk-ant-ort01-replacement",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference"],
    });

    expect(pool.getApplicableCooldownUntil("a", SONNET_CONTEXT)).toBe(0);
    expect(pool.isEligible(replacement.id, SONNET_CONTEXT)).toBe(true);
  });

  it("moves only an ambiguity-created global cooldown to a proven model scope", () => {
    const account = makeAccount("a");
    const pool = new TokenPool([account], { now: () => 1_000 });
    const token = pool.setAmbiguousGlobalCooldownForAccount(account, 60_000, "sonnet");

    pool.reconcileAmbiguousGlobalCooldownForAccount(account, token!, "sonnet", 90_000);

    expect(pool.getApplicableCooldownUntil("a", OPUS_CONTEXT)).toBe(0);
    expect(pool.getApplicableCooldownUntil("a", SONNET_CONTEXT)).toBe(91_000);
  });

  it("does not narrow a definite global cooldown during reconciliation", () => {
    const account = makeAccount("a");
    const pool = new TokenPool([account], { now: () => 1_000 });
    pool.setGlobalCooldownForAccount(account, 60_000);

    pool.reconcileAmbiguousGlobalCooldownForAccount(account, 999, "sonnet", 90_000);

    expect(pool.getApplicableCooldownUntil("a", OPUS_CONTEXT)).toBe(61_000);
  });

  it("reconciles only the exact ambiguous failure when two model 429s overlap", () => {
    const account = makeAccount("a");
    const pool = new TokenPool([account], { now: () => 1_000 });
    const sonnetFailure = pool.setAmbiguousGlobalCooldownForAccount(account, 60_000, "sonnet");
    const opusFailure = pool.setAmbiguousGlobalCooldownForAccount(account, 90_000, "opus");

    pool.reconcileAmbiguousGlobalCooldownForAccount(account, sonnetFailure!, "sonnet", 60_000);
    expect(pool.getApplicableCooldownUntil("a", SONNET_CONTEXT)).toBe(91_000);
    expect(pool.getApplicableCooldownUntil("a", OPUS_CONTEXT)).toBe(91_000);

    pool.reconcileAmbiguousGlobalCooldownForAccount(account, opusFailure!, "opus", 90_000);
    expect(pool.getApplicableCooldownUntil("a", SONNET_CONTEXT)).toBe(61_000);
    expect(pool.getApplicableCooldownUntil("a", OPUS_CONTEXT)).toBe(91_000);
  });
});

describe("TokenPool — unhealthy accounts", () => {
  it("skips unhealthy accounts", () => {
    const pool = new TokenPool([
      makeAccount("a", false),
      makeAccount("b"),
      makeAccount("c"),
    ]);
    const ids = [pool.getNext().id, pool.getNext().id, pool.getNext().id];
    expect(ids).toEqual(["b", "c", "b"]);
  });

  it("throws when all accounts are unhealthy", () => {
    const pool = new TokenPool([makeAccount("a", false), makeAccount("b", false)]);
    expect(() => pool.getNext()).toThrow(NoEligibleAccountError);
  });

  it("getHealthy() excludes unhealthy accounts", () => {
    const pool = new TokenPool([makeAccount("a", false), makeAccount("b"), makeAccount("c")]);
    expect(pool.getHealthy().map(a => a.id)).toEqual(["b", "c"]);
  });
});

describe("TokenPool — busy accounts", () => {
  it("does not use legacy busy state as an eligibility signal", () => {
    const pool = new TokenPool([makeAccount("a", true, true), makeAccount("b")]);
    expect(pool.getNext().id).toBe("a");
    expect(pool.getNext().id).toBe("b");
  });

  it("rotates normally when all healthy accounts have legacy busy state", () => {
    const a = makeAccount("a", true, true);
    const b = makeAccount("b", true, true);
    const pool = new TokenPool([a, b]);
    expect(pool.getNext().id).toBe("a");
    expect(pool.getNext().id).toBe("b");
  });

  it("does not fall back when all busy accounts are unhealthy", () => {
    const a = makeAccount("a", false, true);
    const b = makeAccount("b", false, true);
    const pool = new TokenPool([a, b]);
    expect(() => pool.getNext()).toThrow(NoEligibleAccountError);
  });
});

describe("TokenPool — model-aware hard eligibility", () => {
  const nowMs = 1_000_000;
  const futureReset = 1_100;

  it("excludes an account with an exhausted matching model scope", () => {
    const a = makeAccount("a");
    addModelLimit(a, "sonnet", 1, futureReset);
    const pool = new TokenPool([a, makeAccount("b")], { now: () => nowMs });

    expect(pool.acquireBest(new Map(), SONNET_CONTEXT).account.id).toBe("b");
  });

  it("does not exclude an account for an exhausted unrelated model scope", () => {
    const a = makeAccount("a");
    addModelLimit(a, "sonnet", 1, futureReset);
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(pool.acquireBest(new Map(), OPUS_CONTEXT).account.id).toBe("a");
  });

  it("uses global windows only for an unknown request model", () => {
    const a = makeAccount("a");
    addModelLimit(a, "sonnet", 1, futureReset);
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(pool.acquireBest(new Map(), { requestedModel: "future-model-v1" }).account.id).toBe("a");
  });

  it.each([
    ["five-hour", "fiveHourUtil", "fiveHourReset"],
    ["weekly", "sevenDayUtil", "sevenDayReset"],
  ] as const)("excludes every model when global %s capacity is exhausted", (_name, utilKey, resetKey) => {
    const a = makeAccount("a");
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      [utilKey]: 1,
      [resetKey]: futureReset,
    };
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(() => pool.acquireBest(new Map(), OPUS_CONTEXT)).toThrow(NoEligibleAccountError);
  });

  it("keeps an otherwise exhausted account eligible when extra usage is usable", () => {
    const a = makeAccount("a");
    a.rateLimits.usage = {
      fiveHour: { utilization: 1, resetAt: futureReset },
      modelLimits: [],
      extraUsage: { enabled: true, spendLimitReached: false },
      fetchedAt: 100,
      fetchStatus: "fresh",
    };
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(pool.acquireBest(new Map(), SONNET_CONTEXT).account.id).toBe("a");
  });

  it("keeps fresh extra usage authoritative after newer response headers", () => {
    const a = makeAccount("a");
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      fiveHourUtil: 1,
      fiveHourReset: futureReset,
      lastUpdated: 200,
      usage: {
        fiveHour: { utilization: 0.5, resetAt: futureReset },
        modelLimits: [],
        extraUsage: { enabled: true, spendLimitReached: false },
        fetchedAt: 100,
        fetchStatus: "fresh",
      },
    };
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(pool.acquireBest(new Map(), SONNET_CONTEXT).account.id).toBe("a");
  });

  it.each([
    ["reached", { enabled: true, spendLimitReached: true }],
    ["disabled", { enabled: false, spendLimitReached: false }],
    ["disabled with a reason", { enabled: true, spendLimitReached: false, disabledReason: "paused" }],
  ] as const)("does not use %s extra usage for exhausted capacity", (_name, extraUsage) => {
    const a = makeAccount("a");
    a.rateLimits.usage = {
      fiveHour: { utilization: 1, resetAt: futureReset },
      modelLimits: [],
      extraUsage,
      fetchedAt: 100,
      fetchStatus: "fresh",
    };
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(() => pool.acquireBest(new Map(), SONNET_CONTEXT)).toThrow(NoEligibleAccountError);
  });

  it("uses newer fresh snapshot globals instead of older response headers", () => {
    const a = makeAccount("a");
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      fiveHourUtil: 1,
      fiveHourReset: futureReset,
      lastUpdated: 100,
      usage: {
        fiveHour: { utilization: 0.2, resetAt: futureReset },
        modelLimits: [],
        fetchedAt: 200,
        fetchStatus: "fresh",
      },
    };
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(pool.acquireBest(new Map(), SONNET_CONTEXT).account.id).toBe("a");
  });

  it("blocks on exhausted newer snapshot globals despite older available headers", () => {
    const a = makeAccount("a");
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      fiveHourUtil: 0.2,
      fiveHourReset: futureReset,
      lastUpdated: 100,
      usage: {
        fiveHour: { utilization: 1, resetAt: futureReset },
        modelLimits: [],
        fetchedAt: 200,
        fetchStatus: "fresh",
      },
    };
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(() => pool.acquireBest(new Map(), SONNET_CONTEXT)).toThrow(NoEligibleAccountError);
  });

  it("uses newer response headers instead of an older usage snapshot", () => {
    const a = makeAccount("a");
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      fiveHourUtil: 0.2,
      fiveHourReset: futureReset,
      lastUpdated: 200,
      usage: {
        fiveHour: { utilization: 1, resetAt: futureReset },
        modelLimits: [],
        fetchedAt: 100,
        fetchStatus: "stale",
      },
    };
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(pool.acquireBest(new Map(), SONNET_CONTEXT).account.id).toBe("a");
  });

  it("keeps stale snapshot values as conservative evidence until reset", () => {
    const a = makeAccount("a");
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      fiveHourUtil: 0.2,
      fiveHourReset: futureReset,
      lastUpdated: 100,
      usage: {
        fiveHour: { utilization: 1, resetAt: futureReset },
        modelLimits: [],
        fetchedAt: 200,
        fetchStatus: "stale",
      },
    };
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(() => pool.acquireBest(new Map(), SONNET_CONTEXT)).toThrow(NoEligibleAccountError);
  });

  it("falls back to current response headers when a snapshot is unavailable", () => {
    const a = makeAccount("a");
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      fiveHourUtil: 0.2,
      fiveHourReset: futureReset,
      lastUpdated: 100,
      usage: {
        fiveHour: { utilization: 1, resetAt: futureReset },
        modelLimits: [],
        fetchedAt: 200,
        fetchStatus: "unavailable",
      },
    };
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(pool.acquireBest(new Map(), SONNET_CONTEXT).account.id).toBe("a");
  });

  it("rolls an exhausted matching model window over after its reset", () => {
    const a = makeAccount("a");
    addModelLimit(a, "sonnet", 1, 999);
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(pool.acquireBest(new Map(), SONNET_CONTEXT).account.id).toBe("a");
    expect(a.rateLimits.usage?.modelLimits[0]).toMatchObject({ utilization: 0, resetAt: 0 });
  });

  it("applies a matching model scope regardless of its display active flag", () => {
    const a = makeAccount("a");
    addModelLimit(a, "sonnet", 1, futureReset);
    a.rateLimits.usage!.modelLimits[0].active = false;
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(() => pool.acquireBest(new Map(), SONNET_CONTEXT)).toThrow(NoEligibleAccountError);
  });

  it("never produces NaN ranking from non-finite or malformed utilization", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    a.rateLimits.fiveHourUtil = Number.NaN;
    addModelLimit(a, "sonnet", Number.POSITIVE_INFINITY, futureReset);
    a.rateLimits.usage!.sevenDay = { utilization: "malformed" as unknown as number, resetAt: futureReset };
    b.rateLimits.fiveHourUtil = 0.8;
    const pool = new TokenPool([a, b], { now: () => nowMs });

    expect(pool.acquireBest(new Map(), SONNET_CONTEXT).account.id).toBe("a");
  });

  it("does not authorize paid spillover from a stale extra-usage state", () => {
    const a = makeAccount("a");
    a.rateLimits.usage = {
      fiveHour: { utilization: 1, resetAt: futureReset },
      modelLimits: [],
      extraUsage: { enabled: true, spendLimitReached: false },
      fetchedAt: 100,
      fetchStatus: "stale",
    };
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(() => pool.acquireBest(new Map(), SONNET_CONTEXT)).toThrow(NoEligibleAccountError);
  });
});

describe("TokenPool — hard versus soft fallback", () => {
  const nowMs = 1_000_000;

  it("may bypass only user caps when hard capacity remains", () => {
    const capped = makeAccount("capped");
    capped.sessionLimitPercent = 50;
    capped.rateLimits.fiveHourUtil = 0.6;
    const cooling = makeAccount("cooling");
    const pool = new TokenPool([cooling, capped], { now: () => nowMs });
    pool.setCooldown("cooling", 60_000);
    let bypassed: Account | undefined;
    pool.onCapBypass = account => { bypassed = account; };

    const lease = pool.acquireBest(new Map(), SONNET_CONTEXT);
    expect(lease.account).toBe(capped);
    expect(lease.fallback).toBe(true);
    expect(bypassed).toBe(capped);
  });

  it("never falls back to a globally cooling account", () => {
    const pool = new TokenPool([makeAccount("cooling")], { now: () => nowMs });
    pool.setCooldown("cooling", 60_000);

    expect(() => pool.acquireBest(new Map(), SONNET_CONTEXT)).toThrow(NoEligibleAccountError);
  });

  it("never falls back to an account cooling for the requested model", () => {
    const a = makeAccount("model-cooling");
    addModelLimit(a, "sonnet", 1, 1_100);
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(() => pool.acquireBest(new Map(), SONNET_CONTEXT)).toThrow(NoEligibleAccountError);
  });

  it("can use a model-cooling account for a different model", () => {
    const a = makeAccount("model-cooling");
    addModelLimit(a, "sonnet", 1, 1_100);
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(pool.acquireBest(new Map(), OPUS_CONTEXT).account).toBe(a);
  });

  it("never falls back to an upstream rate-limited account", () => {
    const a = makeAccount("upstream-limited");
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourReset: 1_100,
    };
    const pool = new TokenPool([a], { now: () => nowMs });

    expect(() => pool.acquireBest(new Map(), SONNET_CONTEXT)).toThrow(NoEligibleAccountError);
  });

  it("does not trust a far-future OAuth usage reset for local retry timing", () => {
    const a = makeAccount("snapshot-far-future");
    a.rateLimits.usage = {
      fiveHour: {
        utilization: 1,
        resetAt: nowMs / 1_000 + 8 * 24 * 60 * 60 + 2,
      },
      modelLimits: [],
      fetchedAt: 1,
      fetchStatus: "fresh",
    };
    const pool = new TokenPool([a], { now: () => nowMs });

    let thrown: unknown;
    try {
      pool.acquireBest(new Map(), SONNET_CONTEXT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NoEligibleAccountError);
    expect(thrown).toMatchObject({ reason: "rate_limited" });
    expect((thrown as NoEligibleAccountError).retryAtMs).toBeUndefined();
  });

  it("does not trust a far-future legacy header reset for local retry timing", () => {
    const a = makeAccount("header-far-future");
    a.rateLimits.fiveHourUtil = 1;
    a.rateLimits.fiveHourReset = nowMs / 1_000 + 8 * 24 * 60 * 60 + 2;
    const pool = new TokenPool([a], { now: () => nowMs });

    let thrown: unknown;
    try {
      pool.acquireBest(new Map(), SONNET_CONTEXT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NoEligibleAccountError);
    expect(thrown).toMatchObject({ reason: "rate_limited" });
    expect((thrown as NoEligibleAccountError).retryAtMs).toBeUndefined();
  });

  it("returns the earliest applicable unblock time when all accounts are hard-blocked", () => {
    const quotaBlocked = makeAccount("quota-blocked");
    quotaBlocked.rateLimits.usage = {
      fiveHour: { utilization: 1, resetAt: 1_200 },
      sevenDay: { utilization: 1, resetAt: 1_100 },
      modelLimits: [],
      fetchedAt: 100,
      fetchStatus: "fresh",
    };
    const cooling = makeAccount("cooling");
    const disabled = makeAccount("disabled");
    disabled.enabled = false;
    const pool = new TokenPool([quotaBlocked, cooling, disabled], { now: () => nowMs });
    pool.setCooldown("cooling", 150_000);

    let thrown: unknown;
    try {
      pool.acquireBest(new Map(), SONNET_CONTEXT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NoEligibleAccountError);
    expect(thrown).toMatchObject({
      reason: "rate_limited",
      retryAtMs: 1_150_000,
      blockedAccounts: 3,
    });
  });

  it("reports unavailable without exposing account identifiers", () => {
    const account = makeAccount("private-account-id", false);
    const pool = new TokenPool([account], { now: () => nowMs });

    let thrown: unknown;
    try {
      pool.acquireBest(new Map(), SONNET_CONTEXT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NoEligibleAccountError);
    expect(thrown).toMatchObject({ reason: "unavailable", blockedAccounts: 1 });
    expect((thrown as Error).message).not.toContain(account.id);
  });
});

describe("TokenPool — requested-model headroom ranking", () => {
  const nowMs = 1_000_000;

  it("ranks by the worst applicable requested-model or global utilization", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    a.rateLimits.fiveHourUtil = 0.2;
    b.rateLimits.fiveHourUtil = 0.5;
    addModelLimit(a, "sonnet", 0.9, 1_100);
    addModelLimit(b, "sonnet", 0.1, 1_100);
    const pool = new TokenPool([a, b], { now: () => nowMs });

    expect(pool.acquireBest(new Map(), SONNET_CONTEXT).account).toBe(b);
  });

  it("normalizes global headroom by each configured user cap", () => {
    const lowerRawUtilization = makeAccount("lower-raw");
    lowerRawUtilization.sessionLimitPercent = 50;
    lowerRawUtilization.rateLimits.fiveHourUtil = 0.4;
    const greaterEffectiveHeadroom = makeAccount("greater-headroom");
    greaterEffectiveHeadroom.sessionLimitPercent = 100;
    greaterEffectiveHeadroom.rateLimits.fiveHourUtil = 0.6;
    const pool = new TokenPool(
      [lowerRawUtilization, greaterEffectiveHeadroom],
      { now: () => nowMs },
    );

    expect(pool.acquireBest(new Map(), SONNET_CONTEXT).account).toBe(greaterEffectiveHeadroom);
  });

  it("ranks paid extra usage behind equal-load accounts with included quota", () => {
    const paid = makeAccount("paid");
    paid.rateLimits.usage = {
      fiveHour: { utilization: 1, resetAt: 1_100 },
      modelLimits: [],
      extraUsage: { enabled: true, spendLimitReached: false },
      fetchedAt: 100,
      fetchStatus: "fresh",
    };
    const included = makeAccount("included");
    included.rateLimits.fiveHourUtil = 0.9;
    const pool = new TokenPool([paid, included], { now: () => nowMs });

    expect(pool.acquireBest(new Map(), SONNET_CONTEXT).account).toBe(included);
  });
});

describe("TokenPool — stats", () => {
  it("getStats() returns one entry per account", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    pool.getNext(); // trigger one request
    const stats = pool.getStats();
    expect(stats).toHaveLength(2);
    expect(stats[0].id).toBe("a");
    expect(stats[0].requestCount).toBe(1);
    expect(typeof stats[0].expiresInMs).toBe("number");
  });

  it("getAll() returns all accounts including unhealthy", () => {
    const pool = new TokenPool([makeAccount("a", false), makeAccount("b")]);
    expect(pool.getAll()).toHaveLength(2);
  });

  it("getStats() includes enabled and limit fields", () => {
    const pool = new TokenPool([makeAccount("a")]);
    const s = pool.getStats()[0];
    expect(s.enabled).toBe(true);
    expect(s.sessionLimitPercent).toBe(100);
    expect(s.weeklyLimitPercent).toBe(100);
  });

  it("getStats() includes current in-flight and cooldown state", () => {
    const pool = new TokenPool([makeAccount("a")]);
    const lease = pool.acquireBest(new Map());
    pool.setCooldown("a", 1_000);

    const s = pool.getStats()[0];
    expect(s.inFlightRequests).toBe(1);
    expect(s.coolingDown).toBe(true);

    lease.release();
  });

  it("reports only the earliest active scoped cooldown timestamp", () => {
    const account = makeAccount("a");
    const pool = new TokenPool([account], { now: () => 1_000 });
    pool.setModelCooldownForAccount(account, "opus", 20_000);
    pool.setModelCooldownForAccount(account, "sonnet", 10_000);

    const stats = pool.getStats()[0];
    expect(stats.cooldownUntilMs).toBe(11_000);
    expect(stats).not.toHaveProperty("modelUntil");
    expect(stats).not.toHaveProperty("cooldowns");
  });
});

describe("TokenPool — mutation API", () => {
  it("removeAccount mutates the original array in place (no reference desync)", () => {
    const accounts = [makeAccount("a"), makeAccount("b"), makeAccount("c")];
    const pool = new TokenPool(accounts);
    // The refresh loop captures `accounts` by reference — the array must
    // be mutated in place so the loop sees the removal.
    pool.removeAccount("b");
    expect(accounts).toHaveLength(2);
    expect(accounts.map(a => a.id)).toEqual(["a", "c"]);
    expect(pool.getAll()).toBe(accounts); // same reference
  });

  it("removeAccount returns false for unknown id", () => {
    const pool = new TokenPool([makeAccount("a")]);
    expect(pool.removeAccount("nope")).toBe(false);
    expect(pool.getAll()).toHaveLength(1);
  });

  it("addAccount appends to the original array", () => {
    const accounts = [makeAccount("a")];
    const pool = new TokenPool(accounts);
    const record: AccountRecord = {
      id: "b",
      accessToken: "sk-ant-oat01-b",
      refreshToken: "sk-ant-ort01-b",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference"],
    };
    pool.addAccount(record);
    expect(pool.getAll()).toHaveLength(2);
    expect(accounts).toHaveLength(2); // same reference
  });

  it("addAccount rejects duplicate ids", () => {
    const pool = new TokenPool([makeAccount("a")]);
    const record: AccountRecord = {
      id: "a",
      accessToken: "x",
      refreshToken: "x",
      expiresAt: 0,
      scopes: [],
    };
    expect(() => pool.addAccount(record)).toThrow(/already exists/);
  });

  it("updateAccount patches enabled and limits", () => {
    const pool = new TokenPool([makeAccount("a")]);
    pool.updateAccount("a", { enabled: false, weeklyLimitPercent: 42 });
    const a = pool.getAll()[0];
    expect(a.enabled).toBe(false);
    expect(a.weeklyLimitPercent).toBe(42);
    expect(a.sessionLimitPercent).toBe(100); // unchanged
  });

  it("updateAccount returns null for unknown id", () => {
    const pool = new TokenPool([makeAccount("a")]);
    expect(pool.updateAccount("nope", { enabled: false })).toBeNull();
  });

  it("getNext() throws EmptyPoolError when pool is empty", () => {
    const pool = new TokenPool([makeAccount("a")]);
    pool.removeAccount("a");
    expect(() => pool.getNext()).toThrow(EmptyPoolError);
  });
});

describe("TokenPool — rate limit cooldown expiry", () => {
  it("auto-clears rate_limited status when the claimed reset window has passed", () => {
    const a = makeAccount("a");
    const pastSec = Math.floor(Date.now() / 1000) - 60;
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourReset: pastSec,
    };
    const pool = new TokenPool([a]);
    pool.getNext();
    expect(a.rateLimits.status).toBe("allowed");
  });

  it("keeps rate_limited status when the claimed reset is still in the future", () => {
    const a = makeAccount("a");
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourReset: futureSec,
    };
    const pool = new TokenPool([a, makeAccount("b")]);
    // "a" is still capped → "b" should be used instead.
    expect(pool.getNext().id).toBe("b");
    expect(a.rateLimits.status).toBe("rate_limited");
  });

  it("returns a recovered account to rotation on the next getNext()", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    const pastSec = Math.floor(Date.now() / 1000) - 1;
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "seven_day",
      sevenDayReset: pastSec,
    };
    const pool = new TokenPool([a, b]);
    // Round-robin across both accounts again after recovery.
    const ids = [pool.getNext().id, pool.getNext().id];
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("fires onCooldownExpired when an account recovers", () => {
    const a = makeAccount("a");
    const pastSec = Math.floor(Date.now() / 1000) - 1;
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourReset: pastSec,
    };
    const pool = new TokenPool([a]);
    let recovered: Account | null = null;
    pool.onCooldownExpired = (acct) => { recovered = acct; };
    pool.getNext();
    expect(recovered).not.toBeNull();
    expect(recovered!.id).toBe("a");
  });

  it("sweepExpiredCooldowns() clears status without selecting an account", () => {
    const a = makeAccount("a");
    const pastSec = Math.floor(Date.now() / 1000) - 1;
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourReset: pastSec,
    };
    const pool = new TokenPool([a]);
    const before = a.requestCount;
    pool.sweepExpiredCooldowns();
    expect(a.rateLimits.status).toBe("allowed");
    expect(a.requestCount).toBe(before); // sweep must not consume a turn
  });

  it("clears status when claim is empty and all known windows have expired", () => {
    const a = makeAccount("a");
    const pastSec = Math.floor(Date.now() / 1000) - 1;
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "",
      fiveHourReset: pastSec,
      sevenDayReset: pastSec,
    };
    const pool = new TokenPool([a]);
    pool.getNext();
    expect(a.rateLimits.status).toBe("allowed");
  });

  it("stays rate_limited when claim is empty but one window is still in the future", () => {
    const a = makeAccount("a");
    const nowSec = Math.floor(Date.now() / 1000);
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      status: "rate_limited",
      claim: "",
      fiveHourReset: nowSec - 60,       // expired
      sevenDayReset: nowSec + 3600,     // still active
    };
    const pool = new TokenPool([a, makeAccount("b")]);
    // "a" is still limited by the 7-day window → pool skips it.
    expect(pool.getNext().id).toBe("b");
    expect(a.rateLimits.status).toBe("rate_limited");
    // But the 5h util should have been zeroed by the window rollover.
    expect(a.rateLimits.fiveHourUtil).toBe(0);
    expect(a.rateLimits.fiveHourReset).toBe(0);
  });
});

describe("TokenPool — user cap window rollover", () => {
  it("returns a capped account to rotation when its window resets", () => {
    const a = makeAccount("a");
    a.sessionLimitPercent = 80;
    const pastSec = Math.floor(Date.now() / 1000) - 1;
    // Account was at 90% util (over the 80% cap) with a reset in the past.
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      fiveHourUtil: 0.9,
      fiveHourReset: pastSec,
    };
    const pool = new TokenPool([a, makeAccount("b")]);
    // Before: "a" would be skipped as overUserCap. After sweep: util → 0
    // and "a" rejoins round-robin.
    const ids = [pool.getNext().id, pool.getNext().id];
    expect(ids.sort()).toEqual(["a", "b"]);
    expect(a.rateLimits.fiveHourUtil).toBe(0);
  });

  it("keeps a capped account out when the window has not reset yet", () => {
    const a = makeAccount("a");
    a.sessionLimitPercent = 80;
    const nowSec = Math.floor(Date.now() / 1000);
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      fiveHourUtil: 0.9,
      fiveHourReset: nowSec + 3600,
    };
    const pool = new TokenPool([a, makeAccount("b")]);
    expect(pool.getNext().id).toBe("b");
    expect(a.rateLimits.fiveHourUtil).toBe(0.9); // unchanged
  });

  it("rolls over the 7-day window independently of the 5-hour window", () => {
    const a = makeAccount("a");
    const nowSec = Math.floor(Date.now() / 1000);
    a.rateLimits = {
      ...DEFAULT_RATE_LIMITS,
      fiveHourUtil: 0.3,
      fiveHourReset: nowSec + 60,   // 5h still active
      sevenDayUtil: 0.99,
      sevenDayReset: nowSec - 1,    // 7d expired
    };
    const pool = new TokenPool([a]);
    pool.sweepExpiredCooldowns();
    expect(a.rateLimits.fiveHourUtil).toBe(0.3);       // untouched
    expect(a.rateLimits.fiveHourReset).toBe(nowSec + 60);
    expect(a.rateLimits.sevenDayUtil).toBe(0);         // rolled over
    expect(a.rateLimits.sevenDayReset).toBe(0);
  });
});

describe("TokenPool — user caps", () => {
  it("skips disabled accounts", () => {
    const a = makeAccount("a");
    a.enabled = false;
    const pool = new TokenPool([a, makeAccount("b")]);
    const ids = [pool.getNext().id, pool.getNext().id];
    expect(ids).toEqual(["b", "b"]);
  });

  it("skips accounts over the weekly cap", () => {
    const a = makeAccount("a");
    a.weeklyLimitPercent = 50;
    a.rateLimits = { ...DEFAULT_RATE_LIMITS, sevenDayUtil: 0.55 }; // 55% > 50% cap
    const pool = new TokenPool([a, makeAccount("b")]);
    expect(pool.getNext().id).toBe("b");
  });

  it("skips accounts over the session cap", () => {
    const a = makeAccount("a");
    a.sessionLimitPercent = 80;
    a.rateLimits = { ...DEFAULT_RATE_LIMITS, fiveHourUtil: 0.85 }; // 85% > 80% cap
    const pool = new TokenPool([a, makeAccount("b")]);
    expect(pool.getNext().id).toBe("b");
  });

  it("falls back to capped account when ALL are over cap", () => {
    const a = makeAccount("a");
    a.weeklyLimitPercent = 50;
    a.rateLimits = { ...DEFAULT_RATE_LIMITS, sevenDayUtil: 0.6, fiveHourReset: 100 };
    const pool = new TokenPool([a]);
    // Should still return the account (advisory cap, not hard block)
    expect(pool.getNext().id).toBe("a");
  });

  it("fires onCapBypass when falling back to capped accounts", () => {
    const a = makeAccount("a");
    a.weeklyLimitPercent = 50;
    a.rateLimits = { ...DEFAULT_RATE_LIMITS, sevenDayUtil: 0.6, fiveHourReset: 100 };
    const pool = new TokenPool([a]);
    let bypassed: Account | null = null;
    pool.onCapBypass = (acct) => { bypassed = acct; };
    pool.getNext();
    expect(bypassed).not.toBeNull();
    expect(bypassed!.id).toBe("a");
  });
});

describe("renameAccount", () => {
  it("carries in-flight load to the new id and releases against it", () => {
    const pool = new TokenPool([makeAccount("old-name"), makeAccount("other")]);
    const lease = pool.tryAcquire("old-name");
    expect(lease).not.toBeNull();
    expect(pool.getInFlight("old-name")).toBe(1);

    const renamed = pool.renameAccount("old-name", "new-name");

    expect(renamed?.id).toBe("new-name");
    expect(pool.findById("old-name")).toBeNull();
    expect(pool.findById("new-name")).toBe(renamed);
    // The load counter must move with the id, or the release after the
    // rename would decrement a key that was never incremented.
    expect(pool.getInFlight("new-name")).toBe(1);
    expect(pool.getInFlight("old-name")).toBe(0);

    lease!.release();
    expect(pool.getInFlight("new-name")).toBe(0);
  });

  it("returns null for an unknown id and changes nothing", () => {
    const pool = new TokenPool([makeAccount("a")]);
    expect(pool.renameAccount("missing", "b")).toBeNull();
    expect(pool.findById("a")).not.toBeNull();
  });
});
