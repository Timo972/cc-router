import { describe, it, expect } from "vitest";
import { TokenPool } from "../proxy/token-pool.js";
import { parseAnthropicUsage } from "../providers/anthropic/usage.js";
import type { Account, AccountUsageSnapshot, ModelRateLimit } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS } from "../proxy/types.js";

const FABLE = { requestedModel: "claude-fable-5", modelFamily: "fable" } as const;
const SONNET = { requestedModel: "claude-sonnet-4-20250514", modelFamily: "sonnet" } as const;
const TWO_HOURS = 2 * 60 * 60_000;
const FIVE_DAYS = 5 * 24 * 60 * 60_000;
const START_MS = 1_000_000_000_000;

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

/**
 * One account with an explicit clock and an explicit event sequence.
 *
 * Keeping the two separate is the point: wall-clock time decides when a
 * cooldown *expires*, while the sequence decides what happened *after* what.
 * Tests that need a same-millisecond race hold `now` still and advance only
 * the sequence.
 */
function harness(id: string) {
  const state = { now: START_MS, seq: 0 };
  const account = makeAccount(id);
  const pool = new TokenPool([account], {
    now: () => state.now,
    nextSequence: () => ++state.seq,
  });
  return {
    account,
    pool,
    now: () => state.now,
    advance(ms: number) { state.now += ms; return state.now; },
    jumpTo(ms: number) { state.now = ms; return state.now; },
    /** Claim the next sequence number, as a refresh starting now would. */
    nextSeq() { return ++state.seq; },
    /** Peek without consuming, to reuse an earlier point in the order. */
    currentSeq() { return state.seq; },
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
  /** Ordering token claimed when the refresh started. Omit to make the
   *  snapshot unorderable, which must never supersede anything. */
  requestedSeq?: number;
  fetchedAt?: number;
  fiveHour?: number;
  sevenDay?: number;
  models?: ModelRateLimit[];
  fetchStatus?: AccountUsageSnapshot["fetchStatus"];
  omitWindows?: boolean;
  /** Present the windows the way the parser renders a malformed payload:
   *  the window exists, but carries no utilization figure. */
  unreportedWindows?: boolean;
}

function snapshot(options: SnapshotOptions): AccountUsageSnapshot {
  const snap: AccountUsageSnapshot = {
    modelLimits: options.models ?? [],
    extraUsage: { enabled: false, spendLimitReached: false },
    fetchedAt: options.fetchedAt ?? START_MS,
    fetchStatus: options.fetchStatus ?? "fresh",
  };
  if (options.requestedSeq !== undefined) snap.requestedSeq = options.requestedSeq;
  if (!options.omitWindows) {
    snap.fiveHour = options.unreportedWindows
      ? { resetAt: 0 }
      : { utilization: options.fiveHour ?? 0, resetAt: 2_000_000_000 };
    snap.sevenDay = options.unreportedWindows
      ? { resetAt: 0 }
      : { utilization: options.sevenDay ?? 0, resetAt: 2_000_000_000 };
  }
  return snap;
}

function setUsage(account: Account, usage: AccountUsageSnapshot): void {
  account.rateLimits = { ...account.rateLimits, usage };
}

describe("global cooldowns superseded only within the scope that created them", () => {
  it("releases a five_hour cooldown once a later snapshot reports five-hour headroom", () => {
    const h = harness("five-hour-limited");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 0 }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(0);
    expect(h.pool.isCoolingDown(h.account.id)).toBe(false);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });

  it("releases a seven_day cooldown once a later snapshot reports seven-day headroom", () => {
    const h = harness("seven-day-limited");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "seven_day");

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0.2, sevenDay: 0 }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(0);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });

  it("releases a five_hour cooldown from its own window while the seven-day window is spent", () => {
    // Only the claimed window's recovery is in question here. The exhausted
    // seven-day window is hardBlock's business, not the cooldown's, so the
    // cooldown goes while the account stays blocked.
    const h = harness("five-hour-recovered-seven-day-spent");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 1 }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(0);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("keeps a five_hour cooldown while the five-hour window is still spent", () => {
    const h = harness("five-hour-still-spent");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");
    const cooldownUntil = h.now() + TWO_HOURS;

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 1, sevenDay: 0 }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(cooldownUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("keeps a seven_day cooldown when only the unrelated five-hour window recovered", () => {
    const h = harness("seven-day-still-spent");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "seven_day");
    const cooldownUntil = h.now() + TWO_HOURS;

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 1 }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(cooldownUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("keeps an unscoped cooldown, which no usage window speaks for", () => {
    // A 529 overload cooldown and the seven_day_oauth_apps claim both land
    // here: the snapshot carries no window describing either limit, so
    // ordinary five-hour/seven-day headroom is not evidence about them.
    const h = harness("unscoped");
    h.pool.setGlobalCooldownForAccount(h.account, 30_000);
    const cooldownUntil = h.now() + 30_000;

    h.advance(3_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 0 }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(cooldownUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("keeps an ambiguous cooldown, whose limiting scope is unknown", () => {
    const h = harness("ambiguous");
    h.pool.setAmbiguousGlobalCooldownForAccount(h.account, TWO_HOURS, "fable");
    const cooldownUntil = h.now() + TWO_HOURS;

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({
      requestedSeq: h.nextSeq(),
      fiveHour: 0,
      sevenDay: 0,
      models: [modelLimit("fable", 0)],
    }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(cooldownUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("keeps a scoped cooldown when the snapshot omits that window", () => {
    const h = harness("windowless-snapshot");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");
    const cooldownUntil = h.now() + TWO_HOURS;

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), omitWindows: true }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(cooldownUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("keeps a cooldown when the window carries no utilization figure", () => {
    // A recognized but malformed payload — `five_hour: {}`, or a non-numeric
    // utilization — leaves a window present with nothing reported in it. That
    // is missing data, not proof of capacity, and must not unbench an account
    // that may still be answering 429s.
    const h = harness("unreported-utilization");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");
    const cooldownUntil = h.now() + TWO_HOURS;

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), unreportedWindows: true }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(cooldownUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("keeps a model cooldown when that family reports no utilization figure", () => {
    const h = harness("unreported-model-utilization");
    h.pool.setModelCooldownForAccount(h.account, "fable", FIVE_DAYS);
    const cooldownUntil = h.now() + FIVE_DAYS;

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({
      requestedSeq: h.nextSeq(),
      models: [{
        kind: "weekly_scoped",
        group: "weekly",
        modelFamily: "fable",
        displayName: "Fable",
        resetAt: 0,
        active: true,
        severity: "unknown",
      }],
    }));

    expect(h.pool.getCooldownSummary(h.account.id).modelCooldowns).toEqual([
      { modelFamily: "fable", untilMs: cooldownUntil },
    ]);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("does not let a rolled-over window become reported headroom", () => {
    // The snapshot carries a reset but no utilization. When that reset passes,
    // the window rolls over — and if the rollover writes a zero, an unreported
    // window turns into apparent headroom and retires a cooldown that runs
    // past it. A figure we synthesized is not a figure the provider reported.
    const h = harness("rolled-over-unreported");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");
    const cooldownUntil = h.now() + TWO_HOURS;

    const windowResetSec = Math.floor(h.now() / 1000) + 60;
    const withReset = snapshot({ requestedSeq: h.nextSeq(), omitWindows: true });
    withReset.fiveHour = { resetAt: windowResetSec };
    withReset.sevenDay = { resetAt: windowResetSec };
    setUsage(h.account, withReset);

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(cooldownUntil);

    // Past the window's reset, but well short of the cooldown's own expiry.
    h.jumpTo(windowResetSec * 1_000 + 1_000);
    h.pool.sweepExpiredCooldowns();

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(cooldownUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);

    // It still ends on its own terms.
    h.jumpTo(cooldownUntil + 1);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });

  it("keeps a cooldown against a real malformed payload end to end", () => {
    // The layers have to agree: the parser must not manufacture a zero, and
    // the pool must not read one as capacity. Driving the real parser proves
    // the pair, rather than a hand-built snapshot shape.
    const h = harness("malformed-payload");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");
    const cooldownUntil = h.now() + TWO_HOURS;

    h.advance(3 * 60_000);
    const parsed = parseAnthropicUsage(
      { five_hour: {}, seven_day: { utilization: null } },
      h.now(),
      h.nextSeq(),
    );
    expect(parsed).not.toBeNull();
    setUsage(h.account, parsed!);

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(cooldownUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);

    // The same payload carrying a genuine zero does retire it.
    const reported = parseAnthropicUsage(
      { five_hour: { utilization: 0 }, seven_day: { utilization: 0 } },
      h.now(),
      h.nextSeq(),
    );
    setUsage(h.account, reported!);

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(0);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });

  it("keeps a rate_limited status when the claimed window reports nothing", () => {
    const h = harness("unreported-status");
    h.account.rateLimits = {
      ...h.account.rateLimits,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourUtil: 1,
      fiveHourReset: Math.floor(h.now() / 1000) + 2 * 60 * 60,
      lastUpdated: h.now(),
      lastUpdatedSeq: h.nextSeq(),
    };

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), unreportedWindows: true }));

    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
    expect(h.account.rateLimits.status).toBe("rate_limited");
  });

  it("ignores a snapshot that is not fresh", () => {
    const h = harness("stale-snapshot");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");
    const cooldownUntil = h.now() + TWO_HOURS;

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fetchStatus: "stale" }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(cooldownUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("releasing a global cooldown does not bypass a still-exhausted model window", () => {
    const h = harness("global-clear-model-exhausted");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");

    // The account-wide windows recovered, but Fable specifically is spent.
    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({
      requestedSeq: h.nextSeq(),
      fiveHour: 0,
      sevenDay: 0,
      models: [modelLimit("fable", 1)],
    }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(0);
    // Fable stays blocked on the exhausted-window check, not the cooldown.
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
    // Another family on the same account is routable again.
    expect(h.pool.isEligible(h.account.id, SONNET)).toBe(true);
  });
});

describe("overlapping global cooldowns from different scopes", () => {
  it("keeps an overload cooldown when a scoped one is released over it", () => {
    const h = harness("overload-then-scoped");

    // A 529 overload lands first, then a five-hour 429 from a concurrent
    // request extends the account's cooldown well past it.
    h.pool.setGlobalCooldownForAccount(h.account, 30_000);
    const overloadUntil = h.now() + 30_000;
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");

    // Five-hour headroom retires the quota cooldown but says nothing about
    // the overload, which must serve out its 30 seconds.
    h.advance(5_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 0 }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(overloadUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);

    h.jumpTo(overloadUntil + 1);
    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(0);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });

  it("still releases a scoped cooldown after an overlapping overload expires", () => {
    const h = harness("scoped-then-overload");

    // Reverse order: the multi-hour quota cooldown first, then a brief 529.
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");
    h.pool.setGlobalCooldownForAccount(h.account, 30_000);

    // Once the overload has passed, the quota cooldown is still supersedable —
    // the short unscoped block must not have made it permanent.
    h.advance(31_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 0 }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(0);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });

  it("blocks until the longest live scope expires, whatever order they arrived in", () => {
    const h = harness("longest-scope-wins");
    // Shorter first, so a reader that stops at the first entry would report it.
    h.pool.setGlobalCooldownForAccount(h.account, 60_000, "five_hour");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "seven_day");
    const fiveHourUntil = h.now() + 60_000;
    const sevenDayUntil = h.now() + TWO_HOURS;

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(sevenDayUntil);

    // Neither window has recovered, so both entries stand.
    h.advance(5_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 1, sevenDay: 1 }));
    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(sevenDayUntil);

    // The shorter one expiring on its own does not shorten the account's block.
    h.jumpTo(fiveHourUntil + 1);
    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(sevenDayUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("does not let a later shorter 429 revive an already-superseded expiry", () => {
    // Two requests are in flight. The first 429s with a long reset, the
    // refresh it triggers comes back with headroom, and only then does the
    // second — already on the wire — 429 with a short reset. Nothing swept
    // in between, so the release had no chance to run.
    const h = harness("shorter-429-after-refresh");

    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");

    // The refresh proving headroom was initiated after that first 429.
    const refreshSeq = h.nextSeq();

    // The second 429 lands before any sweep, and asks for far less time.
    h.advance(1_000);
    h.pool.setGlobalCooldownForAccount(h.account, 60_000, "five_hour");
    const shortUntil = h.now() + 60_000;

    // The refresh retires the long expiry it was newer than; the short one
    // it predates survives on its own terms.
    setUsage(h.account, snapshot({ requestedSeq: refreshSeq, fiveHour: 0, sevenDay: 0 }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(shortUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);

    // Once the short cooldown is out, nothing holds the account back — the
    // long expiry must not outlive the snapshot that superseded it.
    h.jumpTo(shortUntil + 1);
    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(0);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });

  it("keeps each scope on its own window", () => {
    const h = harness("both-scopes");
    h.pool.setGlobalCooldownForAccount(h.account, 60_000, "five_hour");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "seven_day");
    const sevenDayUntil = h.now() + TWO_HOURS;

    // Only the five-hour window recovered; the seven-day cooldown remains.
    h.advance(5_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 1 }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(sevenDayUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });
});

describe("ordering survives same-millisecond events", () => {
  it("supersedes a cooldown recorded in the same millisecond as the refresh", () => {
    // The post-429 refresh is queued in the same event-loop turn as the
    // cooldown, so Date.now() reads identically for both. The refresh is
    // still causally later and must be able to release the cooldown.
    const h = harness("same-millisecond");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);

    // No h.advance() — the clock does not move at all.
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 0 }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(0);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });

  it("supersedes a model cooldown recorded in the same millisecond", () => {
    const h = harness("same-millisecond-model");
    h.pool.setModelCooldownForAccount(h.account, "fable", FIVE_DAYS);

    setUsage(h.account, snapshot({
      requestedSeq: h.nextSeq(),
      models: [modelLimit("fable", 0)],
    }));

    expect(h.pool.getCooldownSummary(h.account.id).modelCooldowns).toEqual([]);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });

  it("supersedes a rate_limited status stamped in the same millisecond", () => {
    const h = harness("same-millisecond-status");
    h.account.rateLimits = {
      ...h.account.rateLimits,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourUtil: 1,
      fiveHourReset: Math.floor(h.now() / 1000) + 2 * 60 * 60,
      lastUpdated: h.now(),
      lastUpdatedSeq: h.nextSeq(),
    };

    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 0 }));

    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
    expect(h.account.rateLimits.status).toBe("allowed");
  });

  it("refuses a refresh sequenced before the cooldown", () => {
    const h = harness("earlier-sequence");

    // The refresh was initiated first; the 429 followed while it was in flight.
    const refreshSeq = h.nextSeq();
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");
    const cooldownUntil = h.now() + TWO_HOURS;

    // It completes long after, but describes the account as it was before.
    h.advance(600);
    setUsage(h.account, snapshot({
      requestedSeq: refreshSeq,
      fetchedAt: h.now(),
      fiveHour: 0,
      sevenDay: 0,
    }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(cooldownUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("refuses a refresh sequenced before a model cooldown", () => {
    const h = harness("earlier-sequence-model");
    const refreshSeq = h.nextSeq();
    h.pool.setModelCooldownForAccount(h.account, "fable", FIVE_DAYS);
    const cooldownUntil = h.now() + FIVE_DAYS;

    h.advance(600);
    setUsage(h.account, snapshot({
      requestedSeq: refreshSeq,
      fetchedAt: h.now(),
      models: [modelLimit("fable", 0)],
    }));

    expect(h.pool.getCooldownSummary(h.account.id).modelCooldowns).toEqual([
      { modelFamily: "fable", untilMs: cooldownUntil },
    ]);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("refuses a refresh carrying the cooldown's own token", () => {
    // A token equal to the cooldown's is not later than it. The live sequence
    // never repeats a value, so this pins the boundary rather than a
    // reachable state — it is the contract a future ordering source must keep.
    const h = harness("equal-sequence");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");
    const cooldownUntil = h.now() + TWO_HOURS;

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({
      requestedSeq: h.currentSeq(),
      fiveHour: 0,
      sevenDay: 0,
    }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(cooldownUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("refuses a snapshot with no ordering token at all", () => {
    const h = harness("unorderable");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");
    const cooldownUntil = h.now() + TWO_HOURS;

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ fetchedAt: h.now(), fiveHour: 0, sevenDay: 0 }));

    expect(h.pool.getCooldownSummary(h.account.id).globalUntilMs).toBe(cooldownUntil);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("refuses a rate_limited status with no ordering token", () => {
    const h = harness("unorderable-status");
    h.account.rateLimits = {
      ...h.account.rateLimits,
      status: "rate_limited",
      claim: "five_hour",
      fiveHourUtil: 1,
      fiveHourReset: Math.floor(h.now() / 1000) + 2 * 60 * 60,
      lastUpdated: h.now(),
    };

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 0 }));

    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
    expect(h.account.rateLimits.status).toBe("rate_limited");
  });
});

describe("capacity source precedence", () => {
  it("prefers whichever of headers and usage is newer in the event order", () => {
    // The usage fetch starts, a response lands with exhausting headers while
    // it is in flight, and the fetch finishes last. Its data is older than
    // those headers however late its clock reading is, so the headers decide
    // capacity — otherwise the fresher exhaustion signal is hidden behind a
    // snapshot that never saw it.
    const h = harness("headers-newer-than-usage");
    h.pool.setGlobalCooldownForAccount(h.account, TWO_HOURS, "five_hour");

    const refreshSeq = h.nextSeq();

    h.advance(500);
    h.account.rateLimits = {
      ...h.account.rateLimits,
      fiveHourUtil: 1,
      fiveHourReset: Math.floor(h.now() / 1000) + 2 * 60 * 60,
      lastUpdated: h.now(),
      lastUpdatedSeq: h.nextSeq(),
    };

    h.advance(500);
    setUsage(h.account, snapshot({
      requestedSeq: refreshSeq,
      fetchedAt: h.now(),
      fiveHour: 0,
      sevenDay: 0,
    }));

    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("uses the usage snapshot once its own refresh is the newer event", () => {
    const h = harness("usage-newer-than-headers");
    h.account.rateLimits = {
      ...h.account.rateLimits,
      fiveHourUtil: 1,
      fiveHourReset: Math.floor(h.now() / 1000) + 2 * 60 * 60,
      lastUpdated: h.now(),
      lastUpdatedSeq: h.nextSeq(),
    };

    h.advance(60_000);
    setUsage(h.account, snapshot({
      requestedSeq: h.nextSeq(),
      fetchedAt: h.now(),
      fiveHour: 0,
      sevenDay: 0,
    }));

    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });

  it("falls back to timestamps for a snapshot with no ordering token", () => {
    const h = harness("legacy-precedence");
    h.account.rateLimits = {
      ...h.account.rateLimits,
      fiveHourUtil: 1,
      fiveHourReset: Math.floor(h.now() / 1000) + 2 * 60 * 60,
      lastUpdated: h.now(),
    };

    h.advance(60_000);
    setUsage(h.account, snapshot({ fetchedAt: h.now(), fiveHour: 0, sevenDay: 0 }));

    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });
});

describe("model cooldowns superseded by a later usage snapshot", () => {
  it("releases a model cooldown once a later snapshot reports that family has headroom", () => {
    const h = harness("model-scoped");
    h.pool.setModelCooldownForAccount(h.account, "fable", FIVE_DAYS);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), models: [modelLimit("fable", 0)] }));

    expect(h.pool.getCooldownSummary(h.account.id).modelCooldowns).toEqual([]);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });

  it("does not let a later shorter 429 revive a superseded model expiry", () => {
    // Same shape as the global case: two requests in flight against one
    // family, the refresh triggered by the first returning headroom, and the
    // second 429 landing with a shorter reset before anything swept.
    const h = harness("shorter-model-429-after-refresh");
    h.pool.setModelCooldownForAccount(h.account, "fable", FIVE_DAYS);

    const refreshSeq = h.nextSeq();

    h.advance(1_000);
    h.pool.setModelCooldownForAccount(h.account, "fable", 60_000);
    const shortUntil = h.now() + 60_000;

    setUsage(h.account, snapshot({
      requestedSeq: refreshSeq,
      models: [modelLimit("fable", 0)],
    }));

    expect(h.pool.getCooldownSummary(h.account.id).modelCooldowns).toEqual([
      { modelFamily: "fable", untilMs: shortUntil },
    ]);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);

    // The five-day expiry must not outlive the refresh that superseded it.
    h.jumpTo(shortUntil + 1);
    expect(h.pool.getCooldownSummary(h.account.id).modelCooldowns).toEqual([]);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });

  it("does not let ambiguity reconciliation revive a superseded model expiry", () => {
    // The reconciliation setter merges into the same per-family state, so it
    // must preserve provenance the same way.
    const h = harness("reconcile-model-merge");
    h.pool.setModelCooldownForAccount(h.account, "fable", FIVE_DAYS);

    const refreshSeq = h.nextSeq();

    h.advance(1_000);
    const token = h.pool.setAmbiguousGlobalCooldownForAccount(h.account, 60_000, "fable");
    expect(token).toBeDefined();
    expect(h.pool.reconcileAmbiguousGlobalCooldownForAccount(
      h.account,
      token!,
      "fable",
      60_000,
    )).toBe(true);
    const reconciledUntil = h.now() + 60_000;

    setUsage(h.account, snapshot({
      requestedSeq: refreshSeq,
      models: [modelLimit("fable", 0)],
    }));

    expect(h.pool.getCooldownSummary(h.account.id).modelCooldowns).toEqual([
      { modelFamily: "fable", untilMs: reconciledUntil },
    ]);

    h.jumpTo(reconciledUntil + 1);
    expect(h.pool.getCooldownSummary(h.account.id).modelCooldowns).toEqual([]);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
  });

  it("keeps a model cooldown while that family is still exhausted", () => {
    const h = harness("model-still-exhausted");
    h.pool.setModelCooldownForAccount(h.account, "fable", FIVE_DAYS);
    const cooldownUntil = h.now() + FIVE_DAYS;

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), models: [modelLimit("fable", 1)] }));

    expect(h.pool.getCooldownSummary(h.account.id).modelCooldowns).toEqual([
      { modelFamily: "fable", untilMs: cooldownUntil },
    ]);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
  });

  it("keeps a model cooldown the snapshot does not mention", () => {
    const h = harness("model-unreported");
    h.pool.setModelCooldownForAccount(h.account, "fable", FIVE_DAYS);
    const cooldownUntil = h.now() + FIVE_DAYS;

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), models: [modelLimit("opus", 0)] }));

    expect(h.pool.getCooldownSummary(h.account.id).modelCooldowns).toEqual([
      { modelFamily: "fable", untilMs: cooldownUntil },
    ]);
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
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
    const state = { now: HEADERS_AT_MS, seq: 0 };
    const account = makeAccount("max-developer2-droidrun");
    const pool = new TokenPool([account], {
      now: () => state.now,
      nextSequence: () => ++state.seq,
    });

    account.rateLimits = {
      ...account.rateLimits,
      status: "allowed",
      claim: "five_hour",
      fiveHourUtil: 1,
      fiveHourReset: FIVE_HOUR_RESET_SEC,
      sevenDayUtil: 0.56,
      sevenDayReset: 1_787_353_200,
      lastUpdated: HEADERS_AT_MS,
      lastUpdatedSeq: ++state.seq,
    };
    pool.setGlobalCooldownForAccount(
      account,
      FIVE_HOUR_RESET_SEC * 1_000 - state.now,
      "five_hour",
    );
    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(FIVE_HOUR_RESET_SEC * 1_000);
    expect(pool.isEligible(account.id, FABLE)).toBe(false);

    state.now = USAGE_FETCHED_AT_MS;
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
      requestedSeq: ++state.seq,
      fetchedAt: USAGE_FETCHED_AT_MS,
      fetchStatus: "fresh",
    });

    expect(pool.getCooldownSummary(account.id).globalUntilMs).toBe(0);
    expect(pool.isEligible(account.id, FABLE)).toBe(true);
    expect(pool.acquireBest(new Map(), FABLE).account.id).toBe("max-developer2-droidrun");
  });
});

describe("header rate_limited status superseded by a later usage snapshot", () => {
  function rateLimited(h: ReturnType<typeof harness>, claim: string): void {
    h.account.rateLimits = {
      ...h.account.rateLimits,
      status: "rate_limited",
      claim,
      fiveHourUtil: 1,
      fiveHourReset: Math.floor(h.now() / 1000) + 2 * 60 * 60,
      sevenDayReset: Math.floor(h.now() / 1000) + 7 * 24 * 60 * 60,
      lastUpdated: h.now(),
      lastUpdatedSeq: h.nextSeq(),
    };
  }

  it("returns the account to rotation once a later snapshot reports headroom", () => {
    const h = harness("header-limited");
    rateLimited(h, "five_hour");
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 0 }));

    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
    expect(h.account.rateLimits.status).toBe("allowed");
  });

  it("reports the recovery through onCooldownExpired", () => {
    const h = harness("header-limited-callback");
    rateLimited(h, "five_hour");
    const recovered: string[] = [];
    h.pool.onCooldownExpired = a => recovered.push(a.id);

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 0 }));
    h.pool.sweepExpiredCooldowns();

    expect(recovered).toEqual(["header-limited-callback"]);
  });

  it("waits for every account-global blocker before announcing recovery", () => {
    // A 529 overlaps the quota 429. Superseding the header status leaves the
    // account still blocked by the overload cooldown, so announcing recovery
    // there would tell the user it rejoined a rotation it is absent from —
    // and, since the status only flips once, the real recovery would pass
    // unannounced.
    const h = harness("recovery-gated-on-cooldown");
    rateLimited(h, "five_hour");
    h.pool.setGlobalCooldownForAccount(h.account, 30_000);
    const overloadUntil = h.now() + 30_000;

    const recovered: string[] = [];
    h.pool.onCooldownExpired = a => recovered.push(a.id);

    h.advance(3_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 0 }));
    h.pool.sweepExpiredCooldowns();

    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
    expect(recovered).toEqual([]);

    // Repeated polling while still blocked must not announce anything either.
    h.advance(1_000);
    h.pool.sweepExpiredCooldowns();
    expect(recovered).toEqual([]);

    // Once the overload clears, the account really is back — announce it once.
    h.jumpTo(overloadUntil + 1);
    h.pool.sweepExpiredCooldowns();
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
    expect(recovered).toEqual(["recovery-gated-on-cooldown"]);

    // And not again on subsequent polls.
    h.pool.sweepExpiredCooldowns();
    expect(recovered).toEqual(["recovery-gated-on-cooldown"]);
  });

  it("never announces recovery for a model-scoped limit, which is not a rotation exit", () => {
    // A seven_day_<family> claim limits one family. The account keeps serving
    // everything else, so it never left the rotation and there is no rejoining
    // to report — matching hardBlock, which does not treat that claim as an
    // account-wide blocker either.
    const h = harness("model-scoped-claim");
    h.account.rateLimits = {
      ...h.account.rateLimits,
      status: "rate_limited",
      claim: "seven_day_fable",
      sevenDayReset: Math.floor(h.now() / 1000) + 7 * 24 * 60 * 60,
      lastUpdated: h.now(),
      lastUpdatedSeq: h.nextSeq(),
    };
    h.pool.setModelCooldownForAccount(h.account, "fable", 60_000);
    const fableUntil = h.now() + 60_000;

    const recovered: string[] = [];
    h.pool.onCooldownExpired = a => recovered.push(a.id);

    h.pool.sweepExpiredCooldowns();
    // Fable is spent; every other family still routes here.
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
    expect(h.pool.isEligible(h.account.id, SONNET)).toBe(true);
    expect(recovered).toEqual([]);

    h.jumpTo(fableUntil + 1);
    h.pool.sweepExpiredCooldowns();
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
    expect(recovered).toEqual([]);
  });

  it("does not announce recovery while an account-wide window is still spent", () => {
    const h = harness("recovery-gated-on-window");
    rateLimited(h, "five_hour");
    const recovered: string[] = [];
    h.pool.onCooldownExpired = a => recovered.push(a.id);

    // The claimed five-hour window recovered, but the seven-day window is
    // exhausted, so the account is not routable for anything.
    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 1 }));
    h.pool.sweepExpiredCooldowns();

    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
    expect(recovered).toEqual([]);

    h.advance(60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 0 }));
    h.pool.sweepExpiredCooldowns();

    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
    expect(recovered).toEqual(["recovery-gated-on-window"]);
  });

  it("stays blocked when the limiting window still reports no headroom", () => {
    const h = harness("header-still-limited");
    rateLimited(h, "five_hour");

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 1, sevenDay: 0 }));

    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
    expect(h.account.rateLimits.status).toBe("rate_limited");
  });

  it("supersedes a five_hour claim from its own window alone", () => {
    const h = harness("header-five-hour-scoped");
    rateLimited(h, "five_hour");

    // The seven-day window being spent is irrelevant to a five_hour claim.
    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 1 }));
    h.pool.sweepExpiredCooldowns();

    expect(h.account.rateLimits.status).toBe("allowed");
  });

  it("supersedes a seven_day claim only from the seven-day window", () => {
    const h = harness("header-seven-day");
    rateLimited(h, "seven_day");

    // Five-hour headroom says nothing about the seven-day claim.
    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 1 }));
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
    expect(h.account.rateLimits.status).toBe("rate_limited");

    // The claimed window recovering does supersede it.
    h.advance(60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 0 }));
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
    expect(h.account.rateLimits.status).toBe("allowed");
  });

  it("requires both windows for an unattributed claim", () => {
    const h = harness("header-unknown-claim");
    rateLimited(h, "");

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 1 }));
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
    expect(h.account.rateLimits.status).toBe("rate_limited");

    h.advance(60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fiveHour: 0, sevenDay: 0 }));
    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(true);
    expect(h.account.rateLimits.status).toBe("allowed");
  });

  it("stays blocked when the snapshot is not fresh", () => {
    const h = harness("header-stale-snapshot");
    rateLimited(h, "five_hour");

    h.advance(3 * 60_000);
    setUsage(h.account, snapshot({ requestedSeq: h.nextSeq(), fetchStatus: "stale" }));

    expect(h.pool.isEligible(h.account.id, FABLE)).toBe(false);
    expect(h.account.rateLimits.status).toBe("rate_limited");
  });
});
