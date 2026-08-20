import { describe, it, expect } from "vitest";
import { TokenPool } from "../proxy/token-pool.js";
import type { Account, AccountUsageSnapshot, ModelRateLimit } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";

const FABLE = { requestedModel: "claude-fable-5", modelFamily: "fable" } as const;
const SONNET = { requestedModel: "claude-sonnet-4-20250514", modelFamily: "sonnet" } as const;
const TWO_HOURS = 2 * 60 * 60_000;
const FIVE_DAYS = 5 * 24 * 60 * 60_000;

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

function modelLimit(modelFamily: string, utilization: number): ModelRateLimit {
  return {
    kind: "weekly_scoped",
    group: "weekly",
    modelFamily,
    displayName: modelFamily,
    utilization,
    resetAt: utilization >= 1 ? 2_000_000_000 : 0,
    active: true,
    severity: utilization >= 1 ? "critical" : "unknown",
  };
}

interface SnapshotOptions {
  /** When the refresh completed. Defaults to `requestedAt`. */
  fetchedAt?: number;
  /** When the refresh was initiated — the timestamp supersession trusts. */
  requestedAt?: number;
  fiveHour?: number;
  sevenDay?: number;
  models?: ModelRateLimit[];
  fetchStatus?: AccountUsageSnapshot["fetchStatus"];
  omitRequestedAt?: boolean;
  omitWindows?: boolean;
}

function snapshot(options: SnapshotOptions): AccountUsageSnapshot {
  const requestedAt = options.requestedAt ?? options.fetchedAt ?? 0;
  const snap: AccountUsageSnapshot = {
    modelLimits: options.models ?? [],
    extraUsage: { enabled: false, spendLimitReached: false },
    fetchedAt: options.fetchedAt ?? requestedAt,
    fetchStatus: options.fetchStatus ?? "fresh",
  };
  if (!options.omitRequestedAt) snap.requestedAt = requestedAt;
  if (!options.omitWindows) {
    snap.fiveHour = { utilization: options.fiveHour ?? 0, resetAt: 2_000_000_000 };
    snap.sevenDay = { utilization: options.sevenDay ?? 0, resetAt: 2_000_000_000 };
  }
  return snap;
}

function setUsage(account: Account, usage: AccountUsageSnapshot): void {
  account.rateLimits = { ...account.rateLimits, usage };
}

describe("global cooldowns superseded only within the scope that created them", () => {
  it("releases a five_hour cooldown once a newer snapshot reports five-hour headroom", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("five-hour-limited");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, TWO_HOURS, "five_hour");
    expect(pool.isEligible(account.id, FABLE)).toBe(false);

    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 0, sevenDay: 0 }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(0);
    expect(pool.isCoolingDown(account.id)).toBe(false);
    expect(pool.isEligible(account.id, FABLE)).toBe(true);
  });

  it("releases a seven_day cooldown once a newer snapshot reports seven-day headroom", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("seven-day-limited");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, TWO_HOURS, "seven_day");

    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 0.2, sevenDay: 0 }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(0);
    expect(pool.isEligible(account.id, FABLE)).toBe(true);
  });

  it("keeps a five_hour cooldown while the five-hour window is still spent", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("five-hour-still-spent");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, TWO_HOURS, "five_hour");
    const cooldownUntil = now + TWO_HOURS;

    // The seven-day window has headroom; the limiting window does not.
    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 1, sevenDay: 0 }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(cooldownUntil);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("keeps a seven_day cooldown when only the unrelated five-hour window recovered", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("seven-day-still-spent");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, TWO_HOURS, "seven_day");
    const cooldownUntil = now + TWO_HOURS;

    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 0, sevenDay: 1 }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(cooldownUntil);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("releases a five_hour cooldown from its own window while the seven-day window is spent", () => {
    // Only the claimed window's recovery is in question here. The exhausted
    // seven-day window is hardBlock's business, not the cooldown's, so the
    // cooldown goes while the account stays blocked.
    let now = 1_000_000_000_000;
    const account = makeAccount("five-hour-recovered-seven-day-spent");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, TWO_HOURS, "five_hour");

    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 0, sevenDay: 1 }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(0);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("keeps an unscoped cooldown, which no usage window speaks for", () => {
    // A 529 overload cooldown and the seven_day_oauth_apps claim both land
    // here: the snapshot carries no window describing either limit, so
    // ordinary five-hour/seven-day headroom is not evidence about them.
    let now = 1_000_000_000_000;
    const account = makeAccount("unscoped");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, 30_000);
    const cooldownUntil = now + 30_000;

    now += 3_000;
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 0, sevenDay: 0 }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(cooldownUntil);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("keeps an ambiguous cooldown, whose limiting scope is unknown", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("ambiguous");
    const pool = new TokenPool([account], { now: () => now });

    pool.setAmbiguousGlobalCooldownForAccount(account, TWO_HOURS, "fable");
    const cooldownUntil = now + TWO_HOURS;

    now += 3 * 60_000;
    setUsage(account, snapshot({
      requestedAt: now,
      fiveHour: 0,
      sevenDay: 0,
      models: [modelLimit("fable", 0)],
    }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(cooldownUntil);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("keeps a scoped cooldown when the snapshot omits that window", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("windowless-snapshot");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, TWO_HOURS, "five_hour");
    const cooldownUntil = now + TWO_HOURS;

    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, omitWindows: true }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(cooldownUntil);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("ignores a snapshot that is not fresh", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("stale-snapshot");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, TWO_HOURS, "five_hour");
    const cooldownUntil = now + TWO_HOURS;

    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, fetchStatus: "stale" }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(cooldownUntil);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("releasing a global cooldown does not bypass a still-exhausted model window", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("global-clear-model-exhausted");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, TWO_HOURS, "five_hour");

    // The account-wide windows recovered, but Fable specifically is spent.
    now += 3 * 60_000;
    setUsage(account, snapshot({
      requestedAt: now,
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

describe("supersession requires a refresh initiated after the block", () => {
  it("ignores a refresh that started before the cooldown was recorded", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("in-flight-refresh");
    const pool = new TokenPool([account], { now: () => now });

    // A scheduled refresh is already on the wire...
    const refreshStartedAt = now;

    // ...the request 429s while it is in flight...
    now += 400;
    pool.setGlobalCooldownForAccount(account, TWO_HOURS, "five_hour");
    const cooldownUntil = now + TWO_HOURS;

    // ...and only then does the response body finish parsing. It completed
    // after the 429 but describes the account as it was before it.
    now += 600;
    setUsage(account, snapshot({
      requestedAt: refreshStartedAt,
      fetchedAt: now,
      fiveHour: 0,
      sevenDay: 0,
    }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(cooldownUntil);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("ignores a snapshot with no initiation timestamp at all", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("no-requested-at");
    const pool = new TokenPool([account], { now: () => now });

    pool.setGlobalCooldownForAccount(account, TWO_HOURS, "five_hour");
    const cooldownUntil = now + TWO_HOURS;

    now += 3 * 60_000;
    setUsage(account, snapshot({ fetchedAt: now, omitRequestedAt: true }));

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(cooldownUntil);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("ignores a refresh that started before a model cooldown was recorded", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("in-flight-refresh-model");
    const pool = new TokenPool([account], { now: () => now });

    const refreshStartedAt = now;
    now += 400;
    pool.setModelCooldownForAccount(account, "fable", FIVE_DAYS);
    const cooldownUntil = now + FIVE_DAYS;

    now += 600;
    setUsage(account, snapshot({
      requestedAt: refreshStartedAt,
      fetchedAt: now,
      models: [modelLimit("fable", 0)],
    }));

    expect(pool.getCooldownSummary(account.id).modelCooldowns).toEqual([
      { modelFamily: "fable", untilMs: cooldownUntil },
    ]);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });
});

describe("model cooldowns superseded by a newer usage snapshot", () => {
  it("releases a model cooldown once a newer snapshot reports that family has headroom", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("model-scoped");
    const pool = new TokenPool([account], { now: () => now });

    pool.setModelCooldownForAccount(account, "fable", FIVE_DAYS);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);

    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, models: [modelLimit("fable", 0)] }));

    expect(pool.getCooldownSummary(account.id).modelCooldowns).toEqual([]);
    expect(pool.isEligible(account.id, FABLE)).toBe(true);
  });

  it("keeps a model cooldown while that family is still exhausted", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("model-still-exhausted");
    const pool = new TokenPool([account], { now: () => now });

    pool.setModelCooldownForAccount(account, "fable", FIVE_DAYS);
    const cooldownUntil = now + FIVE_DAYS;

    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, models: [modelLimit("fable", 1)] }));

    expect(pool.getCooldownSummary(account.id).modelCooldowns).toEqual([
      { modelFamily: "fable", untilMs: cooldownUntil },
    ]);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });

  it("keeps a model cooldown the snapshot does not mention", () => {
    let now = 1_000_000_000_000;
    const account = makeAccount("model-unreported");
    const pool = new TokenPool([account], { now: () => now });

    pool.setModelCooldownForAccount(account, "fable", FIVE_DAYS);
    const cooldownUntil = now + FIVE_DAYS;

    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, models: [modelLimit("opus", 0)] }));

    expect(pool.getCooldownSummary(account.id).modelCooldowns).toEqual([
      { modelFamily: "fable", untilMs: cooldownUntil },
    ]);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
  });
});

// Values captured from a live account that had just been moved to a 20x plan:
// the usage endpoint reported every window empty, while the pool still held the
// cooldown minted from the pre-upgrade 429 and 429'd every request for the rest
// of the old five-hour window.
describe("regression: account benched by a pre-upgrade cooldown", () => {
  const HEADERS_AT_MS = 1_787_238_524_415;
  const USAGE_REQUESTED_AT_MS = 1_787_239_726_000;
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
    pool.setGlobalCooldownForAccount(account, FIVE_HOUR_RESET_SEC * 1_000 - now, "five_hour");
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
      requestedAt: USAGE_REQUESTED_AT_MS,
      fetchedAt: USAGE_FETCHED_AT_MS,
      fetchStatus: "fresh",
    });

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(0);
    expect(pool.isEligible(account.id, FABLE)).toBe(true);
    expect(pool.acquireBest(new Map(), FABLE).account.id).toBe("max-developer2-droidrun");
  });
});

describe("header rate_limited status superseded by a newer usage snapshot", () => {
  function rateLimitedAccount(id: string, headerTimeMs: number, claim = "five_hour"): Account {
    const account = makeAccount(id);
    account.rateLimits = {
      ...account.rateLimits,
      status: "rate_limited",
      claim,
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
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 0, sevenDay: 0 }));

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
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 0, sevenDay: 0 }));
    pool.sweepExpiredCooldowns();

    expect(recovered).toEqual(["header-limited-callback"]);
  });

  it("stays blocked when the limiting window still reports no headroom", () => {
    let now = 1_000_000_000_000;
    const account = rateLimitedAccount("header-still-limited", now);
    const pool = new TokenPool([account], { now: () => now });

    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 1, sevenDay: 0 }));

    expect(pool.isEligible(account.id, FABLE)).toBe(false);
    expect(account.rateLimits.status).toBe("rate_limited");
  });

  it("supersedes a five_hour claim from its own window alone", () => {
    let now = 1_000_000_000_000;
    const account = rateLimitedAccount("header-five-hour-scoped", now);
    const pool = new TokenPool([account], { now: () => now });

    // The seven-day window being spent is irrelevant to a five_hour claim.
    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 0, sevenDay: 1 }));
    pool.sweepExpiredCooldowns();

    expect(account.rateLimits.status).toBe("allowed");
  });

  it("supersedes a seven_day claim only from the seven-day window", () => {
    let now = 1_000_000_000_000;
    const account = rateLimitedAccount("header-seven-day", now, "seven_day");
    account.rateLimits = {
      ...account.rateLimits,
      sevenDayReset: Math.floor(now / 1000) + 7 * 24 * 60 * 60,
    };
    const pool = new TokenPool([account], { now: () => now });

    // Five-hour headroom says nothing about the seven-day claim.
    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 0, sevenDay: 1 }));
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
    expect(account.rateLimits.status).toBe("rate_limited");

    // The claimed window recovering does supersede it.
    now += 60_000;
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 0, sevenDay: 0 }));
    expect(pool.isEligible(account.id, FABLE)).toBe(true);
    expect(account.rateLimits.status).toBe("allowed");
  });

  it("requires both windows for an unattributed claim", () => {
    let now = 1_000_000_000_000;
    const account = rateLimitedAccount("header-unknown-claim", now, "");
    account.rateLimits = {
      ...account.rateLimits,
      sevenDayReset: Math.floor(now / 1000) + 7 * 24 * 60 * 60,
    };
    const pool = new TokenPool([account], { now: () => now });

    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 0, sevenDay: 1 }));
    expect(pool.isEligible(account.id, FABLE)).toBe(false);
    expect(account.rateLimits.status).toBe("rate_limited");

    now += 60_000;
    setUsage(account, snapshot({ requestedAt: now, fiveHour: 0, sevenDay: 0 }));
    expect(pool.isEligible(account.id, FABLE)).toBe(true);
    expect(account.rateLimits.status).toBe("allowed");
  });

  it("stays blocked when the refresh started before the limiting headers", () => {
    let now = 1_000_000_000_000;
    const account = rateLimitedAccount("header-newer-than-refresh", now);
    const pool = new TokenPool([account], { now: () => now });

    setUsage(account, snapshot({
      requestedAt: now - 60_000,
      fetchedAt: now + 500,
      fiveHour: 0,
      sevenDay: 0,
    }));

    expect(pool.isEligible(account.id, FABLE)).toBe(false);
    expect(account.rateLimits.status).toBe("rate_limited");
  });

  it("stays blocked when the snapshot is not fresh", () => {
    let now = 1_000_000_000_000;
    const account = rateLimitedAccount("header-stale-snapshot", now);
    const pool = new TokenPool([account], { now: () => now });

    now += 3 * 60_000;
    setUsage(account, snapshot({ requestedAt: now, fetchStatus: "stale" }));

    expect(pool.isEligible(account.id, FABLE)).toBe(false);
    expect(account.rateLimits.status).toBe("rate_limited");
  });
});
