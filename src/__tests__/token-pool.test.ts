import { describe, it, expect, beforeEach } from "vitest";
import { TokenPool, EmptyPoolError } from "../proxy/token-pool.js";
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

  it("chooses the lowest in-flight account for all-unavailable fallback", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    const pool = new TokenPool([a, b]);
    const first = pool.tryAcquire("a");
    a.enabled = false;
    b.enabled = false;

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

  it("returns first account when ALL are unhealthy (emergency fallback)", () => {
    const pool = new TokenPool([makeAccount("a", false), makeAccount("b", false)]);
    expect(pool.getNext().id).toBe("a");
  });

  it("getHealthy() excludes unhealthy accounts", () => {
    const pool = new TokenPool([makeAccount("a", false), makeAccount("b"), makeAccount("c")]);
    expect(pool.getHealthy().map(a => a.id)).toEqual(["b", "c"]);
  });
});

describe("TokenPool — busy accounts", () => {
  it("skips busy accounts in round-robin", () => {
    const pool = new TokenPool([makeAccount("a", true, true), makeAccount("b")]);
    expect(pool.getNext().id).toBe("b");
    expect(pool.getNext().id).toBe("b");
  });

  it("returns account with earliest reset when ALL healthy accounts are busy", () => {
    const a = makeAccount("a", true, true);
    const b = makeAccount("b", true, true);
    // Use future timestamps — past resets get swept to 0 before selection,
    // which would defeat the "earliest reset" comparison.
    const nowSec = Math.floor(Date.now() / 1000);
    a.rateLimits = { ...DEFAULT_RATE_LIMITS, fiveHourReset: nowSec + 7200 };
    b.rateLimits = { ...DEFAULT_RATE_LIMITS, fiveHourReset: nowSec + 60 };
    const pool = new TokenPool([a, b]);
    expect(pool.getNext().id).toBe("b");
  });

  it("falls back to least-loaded of all when all are both busy AND unhealthy", () => {
    const a = makeAccount("a", false, true);
    const b = makeAccount("b", false, true);
    // All unhealthy → emergency path returns first account
    const pool = new TokenPool([a, b]);
    expect(pool.getNext().id).toBe("a");
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
