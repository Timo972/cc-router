import { describe, it, expect } from "vitest";
import { TokenPool } from "../proxy/token-pool.js";
import type { Account, AccountUsageSnapshot, ModelRateLimit } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";

const FABLE = { requestedModel: "claude-fable-5", modelFamily: "fable" } as const;
const SONNET = { requestedModel: "claude-sonnet-4-20250514", modelFamily: "sonnet" } as const;

function makeAccount(id: string): Account {
  return {
    id,
    tokens: {
      accessToken: `sk-ant-oat01-${id}`,
      refreshToken: `sk-ant-ort01-${id}`,
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference", "user:profile"],
    },
    healthy: true,
    busy: false,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
    rateLimits: { ...DEFAULT_RATE_LIMITS, status: "allowed" },
    enabled: true,
    sessionLimitPercent: 100,
    weeklyLimitPercent: 100,
  };
}

function modelLimit(modelFamily: string, utilization: number, active = true): ModelRateLimit {
  return {
    kind: "weekly_scoped",
    group: "weekly",
    modelFamily,
    displayName: modelFamily,
    utilization,
    resetAt: utilization >= 1 ? 2_000_000_000 : 0,
    active,
    severity: utilization >= 1 ? "critical" : "unknown",
  };
}

interface SnapshotOptions {
  fetchedAt: number;
  fiveHour?: number;
  sevenDay?: number;
  models?: ModelRateLimit[];
  fetchStatus?: AccountUsageSnapshot["fetchStatus"];
}

function snapshot(options: SnapshotOptions): AccountUsageSnapshot {
  return {
    fiveHour: { utilization: options.fiveHour ?? 0, resetAt: 2_000_000_000 },
    sevenDay: { utilization: options.sevenDay ?? 0, resetAt: 2_000_000_000 },
    modelLimits: options.models ?? [],
    extraUsage: { enabled: false, spendLimitReached: false },
    fetchedAt: options.fetchedAt,
    fetchStatus: options.fetchStatus ?? "fresh",
  };
}

function setUsage(account: Account, usage: AccountUsageSnapshot): void {
  account.rateLimits = { ...account.rateLimits, usage };
}

describe("cooldowns superseded by a newer usage snapshot", () => {
  it("releases a global cooldown once a newer snapshot reports headroom", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("upgraded");
    const pool = new TokenPool([account], { now: () => now });

    // A five_hour 429 benches the account until its 5h window resets in 2h.
    pool.setGlobalCooldownForAccount(account, 2 * 60 * 60_000);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);

    // The plan is upgraded; three minutes later the usage endpoint reports
    // every window back to zero.
    now += 3 * 60_000;
    setUsage(account, snapshot({ fetchedAt: now, fiveHour: 0, sevenDay: 0 }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(0);
    expect(pool.isCoolingDown(account.id)).toBe(false);
    expect(pool.isEligible(account.id, FABLE)).toBe(true);
  });

  it("keeps a global cooldown when the newer snapshot still reports no headroom", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("still-limited");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, 2 * 60 * 60_000);
    const cooldownUntil = now + 2 * 60 * 60_000;

    now += 3 * 60_000;
    setUsage(account, snapshot({ fetchedAt: now, fiveHour: 1, sevenDay: 0.4 }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(cooldownUntil);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("ignores a snapshot fetched before the cooldown was recorded", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("racing-snapshot");
    const pool = new TokenPool([account], { now: () => now });

    // A refresh lands first, reporting headroom...
    setUsage(account, snapshot({ fetchedAt: now, fiveHour: 0, sevenDay: 0 }));

    // ...and only then does the 429 arrive. The older snapshot knows nothing
    // about the limit that produced it and must not cancel it.
    now += 30_000;
    pool.setGlobalCooldownForAccount(account, 2 * 60 * 60_000);
    const cooldownUntil = now + 2 * 60 * 60_000;

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(cooldownUntil);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("ignores a snapshot that is not fresh", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("stale-snapshot");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, 2 * 60 * 60_000);
    const cooldownUntil = now + 2 * 60 * 60_000;

    now += 3 * 60_000;
    setUsage(account, snapshot({ fetchedAt: now, fiveHour: 0, sevenDay: 0, fetchStatus: "stale" }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(cooldownUntil);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("releases an ambiguous global cooldown once a newer snapshot reports headroom", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("ambiguous");
    const pool = new TokenPool([account], { now: () => now });

    pool.setAmbiguousGlobalCooldownForAccount(account, 2 * 60 * 60_000, "fable");
    expect(pool.isEligible(account.id, FABLE)).toBe(false);

    now += 3 * 60_000;
    setUsage(account, snapshot({
      fetchedAt: now,
      models: [modelLimit("fable", 0, false)],
    }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(0);
    expect(pool.isEligible(account.id, FABLE)).toBe(true);
  });

  it("releases a model cooldown once a newer snapshot reports that family has headroom", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("model-scoped");
    const pool = new TokenPool([account], { now: () => now });

    pool.setModelCooldownForAccount(account, "fable", 5 * 24 * 60 * 60_000);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);

    now += 3 * 60_000;
    setUsage(account, snapshot({
      fetchedAt: now,
      models: [modelLimit("fable", 0, false)],
    }));

    expect(pool.getCooldownSummary(account.id).modelCooldowns).toEqual([]);
    expect(pool.isEligible(account.id, FABLE)).toBe(true);
  });

  it("keeps a model cooldown while that family is still exhausted", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("model-still-exhausted");
    const pool = new TokenPool([account], { now: () => now });

    pool.setModelCooldownForAccount(account, "fable", 5 * 24 * 60 * 60_000);
    const cooldownUntil = now + 5 * 24 * 60 * 60_000;

    now += 3 * 60_000;
    setUsage(account, snapshot({
      fetchedAt: now,
      models: [modelLimit("fable", 1)],
    }));

    expect(pool.getCooldownSummary(account.id).modelCooldowns).toEqual([
      { modelFamily: "fable", untilMs: cooldownUntil },
    ]);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("keeps a model cooldown the snapshot does not mention", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("model-unreported");
    const pool = new TokenPool([account], { now: () => now });

    pool.setModelCooldownForAccount(account, "fable", 5 * 24 * 60 * 60_000);
    const cooldownUntil = now + 5 * 24 * 60 * 60_000;

    now += 3 * 60_000;
    setUsage(account, snapshot({ fetchedAt: now, models: [modelLimit("opus", 0, false)] }));

    expect(pool.getCooldownSummary(account.id).modelCooldowns).toEqual([
      { modelFamily: "fable", untilMs: cooldownUntil },
    ]);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("keeps the global cooldown of an account the snapshot has no windows for", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("windowless-snapshot");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, 2 * 60 * 60_000);
    const cooldownUntil = now + 2 * 60 * 60_000;

    now += 3 * 60_000;
    account.rateLimits = {
      ...account.rateLimits,
      usage: { modelLimits: [], fetchedAt: now, fetchStatus: "fresh" },
    };

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(cooldownUntil);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("releasing a global cooldown does not bypass a still-exhausted model window", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("global-clear-model-exhausted");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, 2 * 60 * 60_000);

    // The account-wide windows recovered, but Fable specifically is spent.
    now += 3 * 60_000;
    setUsage(account, snapshot({
      fetchedAt: now,
      fiveHour: 0,
      sevenDay: 0,
      models: [modelLimit("fable", 1)],
    }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(0);
    // Fable stays blocked on the exhausted-window check, not the cooldown.
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
    // Another family on the same account is routable again.
    expect(pool.isEligible(account.id, SONNET)).toBe(true);
  });
});

// Values captured from a live account that had just been moved to a 20x plan:
// the usage endpoint reported every window empty, while the pool still held the
// cooldown minted from the pre-upgrade 429 and 429'd every request for the rest
// of the old five-hour window.
describe("regression: account benched by a pre-upgrade cooldown", () => {
  const HEADERS_AT_MS = 1_787_238_524_415;
  const USAGE_FETCHED_AT_MS = 1_787_239_726_282;
  const FIVE_HOUR_RESET_SEC = 1_787_248_800;

  it("routes again as soon as the post-upgrade snapshot lands", () => {
    let now = HEADERS_AT_MS;
    const account = makeAccount("max-developer2-droidrun");
    const pool = new TokenPool([account], { now: () => now });

    account.rateLimits = {
      ...account.rateLimits,
      status: "allowed",
      claim: "five_hour",
      fiveHourUtil: 1,
      fiveHourReset: FIVE_HOUR_RESET_SEC,
      sevenDayUtil: 0.56,
      sevenDayReset: 1_787_353_200,
      lastUpdated: HEADERS_AT_MS,
    };
    pool.setGlobalCooldownForAccount(account, FIVE_HOUR_RESET_SEC * 1_000 - now);
    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(FIVE_HOUR_RESET_SEC * 1_000);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);

    now = USAGE_FETCHED_AT_MS;
    setUsage(account, {
      fiveHour: { utilization: 0, resetAt: 0 },
      sevenDay: { utilization: 0, resetAt: 0 },
      modelLimits: [{
        kind: "weekly_scoped",
        group: "weekly",
        modelFamily: "fable",
        displayName: "Fable",
        utilization: 0,
        resetAt: 0,
        active: false,
        severity: "unknown",
      }],
      extraUsage: { enabled: false, spendLimitReached: false },
      fetchedAt: USAGE_FETCHED_AT_MS,
      fetchStatus: "fresh",
    });

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(0);
    expect(pool.isEligible(account.id, FABLE)).toBe(true);
    expect(pool.acquireBest(new Map(), FABLE).account.id).toBe("max-developer2-droidrun");
  });
});

describe("header rate_limited status superseded by a newer usage snapshot", () => {
  function rateLimitedAccount(id: string, headerTimeMs: number): Account {
    const account = makeAccount(id);
    account.rateLimits = {
      ...account.rateLimits,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourUtil: 1,
      fiveHourReset: Math.floor(headerTimeMs / 1000) + 2 * 60 * 60,
      lastUpdated: headerTimeMs,
    };
    return account;
  }

  it("returns the account to rotation once a newer snapshot reports headroom", () => {
    let now = 1_000_000_000_000;
    const account = rateLimitedAccount("header-limited", now);
    const pool = new TokenPool([account], { now: () => now });
    expect(pool.isEligible(account.id, FABLE)).toBe(false);

    now += 3 * 60_000;
    setUsage(account, snapshot({ fetchedAt: now, fiveHour: 0, sevenDay: 0 }));

    expect(pool.isEligible(account.id, FABLE)).toBe(true);
    expect(account.rateLimits.status).toBe("allowed");
  });

  it("reports the recovery through onCooldownExpired", () => {
    let now = 1_000_000_000_000;
    const account = rateLimitedAccount("header-limited-callback", now);
    const pool = new TokenPool([account], { now: () => now });
    const recovered: string[] = [];
    pool.onCooldownExpired = a => recovered.push(a.id);

    now += 3 * 60_000;
    setUsage(account, snapshot({ fetchedAt: now, fiveHour: 0, sevenDay: 0 }));
    pool.sweepExpiredCooldowns();

    expect(recovered).toEqual(["header-limited-callback"]);
  });

  it("stays blocked when the newer snapshot still reports no headroom", () => {
    let now = 1_000_000_000_000;
    const account = rateLimitedAccount("header-still-limited", now);
    const pool = new TokenPool([account], { now: () => now });

    now += 3 * 60_000;
    setUsage(account, snapshot({ fetchedAt: now, fiveHour: 1, sevenDay: 0.4 }));

    expect(pool.isEligible(account.id, FABLE)).toBe(false);
    expect(account.rateLimits.status).toBe("rate_limited");
  });

  it("stays blocked when the snapshot predates the limiting headers", () => {
    let now = 1_000_000_000_000;
    const account = rateLimitedAccount("header-newer-than-snapshot", now);
    const pool = new TokenPool([account], { now: () => now });
    // Snapshot fetched a minute before the 429 headers landed.
    setUsage(account, snapshot({ fetchedAt: now - 60_000, fiveHour: 0, sevenDay: 0 }));

    expect(pool.isEligible(account.id, FABLE)).toBe(false);
    expect(account.rateLimits.status).toBe("rate_limited");
  });

  it("stays blocked when the snapshot is not fresh", () => {
    let now = 1_000_000_000_000;
    const account = rateLimitedAccount("header-stale-snapshot", now);
    const pool = new TokenPool([account], { now: () => now });

    now += 3 * 60_000;
    setUsage(account, snapshot({ fetchedAt: now, fiveHour: 0, sevenDay: 0, fetchStatus: "stale" }));

    expect(pool.isEligible(account.id, FABLE)).toBe(false);
    expect(account.rateLimits.status).toBe("rate_limited");
  });
});
