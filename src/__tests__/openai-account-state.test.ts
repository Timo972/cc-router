import { describe, expect, it } from "vitest";
import {
  applyCodexRateLimits,
  bucketForModel,
  bucketIdForModel,
  createOpenAIAccount,
  learnModelBucket,
  sweepCodexRateLimits,
} from "../providers/openai/account-state.js";
import { DEFAULT_CODEX_LIMIT_ID, parseCodexRateLimits } from "../providers/openai/usage.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

const NOW_MS = 1_754_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function record(overrides: Partial<OpenAISubscriptionAccount> = {}): OpenAISubscriptionAccount {
  return {
    id: "openai-a",
    provider: "openai_subscription",
    accessToken: "header.e30.sig", // "{}" payload — no plan claim
    refreshToken: "rt",
    expiresAt: NOW_MS + 3_600_000,
    enabled: true,
    ...overrides,
  };
}

describe("createOpenAIAccount", () => {
  it("builds a runtime account with defaults and clamped caps", () => {
    const account = createOpenAIAccount(record({ sessionLimitPercent: 250, weeklyLimitPercent: -3 }));
    expect(account.healthy).toBe(true);
    expect(account.requestCount).toBe(0);
    expect(account.sessionLimitPercent).toBe(100);
    expect(account.weeklyLimitPercent).toBe(0);
    expect(account.scopes).toEqual(["openid", "profile", "email", "offline_access"]);
    expect(account.rateLimits.buckets.size).toBe(0);
    expect(account.rateLimits.plan).toBeUndefined();
  });
});

describe("applyCodexRateLimits", () => {
  it("merges buckets and keeps last-good values for absent fields", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "40",
      "x-codex-secondary-used-percent": "10",
    }, NOW_MS), NOW_MS);
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "55",
    }, NOW_MS + 1000), NOW_MS + 1000);

    const bucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID)!;
    expect(bucket.primary?.utilization).toBeCloseTo(0.55);
    expect(bucket.secondary?.utilization).toBeCloseTo(0.1); // kept from the first response
    expect(account.rateLimits.lastUpdated).toBe(NOW_MS + 1000);
  });
});

describe("bucketForModel", () => {
  it("learns a mapping lazily from a bucket limit-name matching the model slug", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "88",
      "x-codex-bengalfox-limit-name": "GPT-5.6-Sol",
    }, NOW_MS), NOW_MS);

    const bucket = bucketForModel(account, "gpt-5.6-sol");
    expect(bucket?.limitId).toBe("codex_bengalfox");
    expect(account.modelBuckets.get("gpt-5.6-sol")?.limitId).toBe("codex_bengalfox");
    expect(bucketForModel(account, "gpt-5.6-luna")).toBeUndefined();
  });

  it("retains a mapping to a limitId with no bucket snapshot yet, for cooldown lookups", () => {
    const account = createOpenAIAccount(record());
    learnModelBucket(account, "gpt-5.6-sol", "codex_gone", NOW_MS);
    // No snapshot exists for "codex_gone" yet (e.g. a header-only 429 learned
    // the mapping before any rate-limit snapshot arrived for that bucket).
    // bucketForModel correctly has nothing to return, but must not delete the
    // mapping — bucketIdForModel still resolves it so a cooldown keyed on
    // that limitId keeps being enforced.
    expect(bucketForModel(account, "gpt-5.6-sol")).toBeUndefined();
    expect(account.modelBuckets.get("gpt-5.6-sol")?.limitId).toBe("codex_gone");
    expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("codex_gone");
  });

  it("never maps the default limit id and bounds the map", () => {
    const account = createOpenAIAccount(record());
    learnModelBucket(account, "gpt-5.6-sol", DEFAULT_CODEX_LIMIT_ID, NOW_MS);
    expect(account.modelBuckets.size).toBe(0);
    for (let i = 0; i < 40; i++) learnModelBucket(account, `model-${i}`, "codex_x", NOW_MS);
    expect(account.modelBuckets.size).toBeLessThanOrEqual(32);
  });

  it("prefers a newly reported live bucket over a stale cached mapping", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "10",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);
    expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("codex_bengalfox");

    // Upstream moves the model to a different limit id and reports the new
    // bucket as exhausted. The cached mapping still points at the old id, but
    // the live bucket is the one with current exhaustion data.
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-newfox-primary-used-percent": "100",
      "x-codex-newfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS + 1000), NOW_MS + 1000);

    expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("codex_newfox");
    expect(bucketForModel(account, "gpt-5.6-sol")?.primary?.utilization).toBe(1);
    expect(account.modelBuckets.get("gpt-5.6-sol")?.limitId).toBe("codex_newfox");
  });

  it("prefers a newer active-limit mapping over an older live snapshot", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "50",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);
    expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("codex_bengalfox");

    // A header-only 429 carries no snapshot at all — it names the active
    // limit and nothing else, so the pre-move bucket is still sitting in the
    // map naming this model. The 429 is the newer evidence.
    learnModelBucket(account, "gpt-5.6-sol", "codex_newfox", NOW_MS + 1000);

    expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("codex_newfox");
    // Resolving must not overwrite the mapping with the older snapshot's
    // bucket either, or the second lookup has nothing left to find.
    expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("codex_newfox");
    expect(account.modelBuckets.get("gpt-5.6-sol")?.limitId).toBe("codex_newfox");
  });

  it("prefers the active-limit mapping when it ties with the snapshot it arrived with", () => {
    const account = createOpenAIAccount(record());
    // A 429 carrying both rate-limit headers and `x-codex-active-limit` is
    // applied and routed from one `now`, so the snapshot it refreshes and the
    // mapping it learns share a timestamp. Only the header names the bucket
    // that limited this request.
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "50",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);
    learnModelBucket(account, "gpt-5.6-sol", "codex_newfox", NOW_MS);

    expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("codex_newfox");
    expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("codex_newfox");
    expect(account.modelBuckets.get("gpt-5.6-sol")?.limitId).toBe("codex_newfox");
  });

  it("keeps a snapshot-less mapping from aging out while it is still being used", () => {
    const account = createOpenAIAccount(record());
    // A header-only 429's mapping has no bucket snapshot to fall back on, so
    // losing it to eviction loses the cooldown with it.
    learnModelBucket(account, "gpt-5.6-sol", "codex_headeronly", NOW_MS);
    for (let i = 0; i < 31; i++) learnModelBucket(account, `filler-${i}`, "codex_x", NOW_MS + i);

    // Consulted on every request right up to the cap being exceeded.
    for (let i = 0; i < 31; i++) {
      expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("codex_headeronly");
    }
    learnModelBucket(account, "one-model-too-many", "codex_x", NOW_MS + 100);

    // Reading a Map does not move the key, so without an explicit re-insert
    // this mapping would still be the oldest entry and the first evicted.
    expect(account.modelBuckets.get("gpt-5.6-sol")?.limitId).toBe("codex_headeronly");
    expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("codex_headeronly");
  });

  it("keeps the active-limit mapping when two live buckets tie on last-seen", () => {
    const account = createOpenAIAccount(record());
    // One response stamps every bucket it carries with the same `lastSeenAt`,
    // so recency cannot separate two buckets that name the same model.
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "10",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
      "x-codex-newfox-primary-used-percent": "100",
      "x-codex-newfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);

    // A 429's `x-codex-active-limit` is upstream naming the bucket that
    // actually limited the request — the only authoritative mapping there is.
    learnModelBucket(account, "gpt-5.6-sol", "codex_newfox", NOW_MS);

    // Resolution must keep landing there, not drift back to whichever bucket
    // happened to be inserted first.
    expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("codex_newfox");
    expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("codex_newfox");
    expect(account.modelBuckets.get("gpt-5.6-sol")?.limitId).toBe("codex_newfox");
  });

  it("falls back to the cached mapping when no live bucket names the model", () => {
    const account = createOpenAIAccount(record());
    // The header-only 429 path: a mapping exists with no bucket snapshot, and
    // it must survive so the pool can still find that bucket's cooldown.
    learnModelBucket(account, "gpt-5.6-sol", "codex_headeronly", NOW_MS);
    expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("codex_headeronly");
    expect(bucketForModel(account, "gpt-5.6-sol")).toBeUndefined();
  });

  it("relearning a mapping refreshes its recency so eviction stays true LRU", () => {
    const account = createOpenAIAccount(record());
    // Fill the map exactly to capacity.
    for (let i = 0; i < 32; i++) learnModelBucket(account, `model-${i}`, "codex_x", NOW_MS);

    // `model-0` is the oldest by insertion, but relearning it must move it to
    // the back of the eviction queue — a plain Map.set would not.
    learnModelBucket(account, "model-0", "codex_bengalfox", NOW_MS);
    learnModelBucket(account, "model-new", "codex_x", NOW_MS);

    expect(account.modelBuckets.size).toBe(32);
    expect(account.modelBuckets.get("model-0")?.limitId).toBe("codex_bengalfox");
    expect(account.modelBuckets.has("model-new")).toBe(true);
    // `model-1` was the oldest entry never touched since insertion.
    expect(account.modelBuckets.has("model-1")).toBe(false);
  });
});

describe("sweepCodexRateLimits", () => {
  it("zeroes expired default windows and reports recovery of exhausted ones", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(NOW_SEC + 60),
    }, NOW_MS), NOW_MS);

    expect(sweepCodexRateLimits(account, NOW_MS)).toBe(false);
    const recovered = sweepCodexRateLimits(account, NOW_MS + 61_000);
    expect(recovered).toBe(true);
    const bucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID)!;
    expect(bucket.primary?.utilization).toBe(0);
    expect(bucket.primary?.resetAt).toBe(0);
  });

  it("drops a named bucket and its model mappings once its windows reset", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "100",
      "x-codex-bengalfox-primary-reset-at": String(NOW_SEC + 60),
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);
    expect(bucketForModel(account, "gpt-5.6-sol")).toBeDefined();

    sweepCodexRateLimits(account, NOW_MS + 61_000);
    expect(account.rateLimits.buckets.has("codex_bengalfox")).toBe(false);
    expect(account.modelBuckets.size).toBe(0);
  });

  it("self-heals a stale exhausted default window that has no trustworthy resetAt", () => {
    const account = createOpenAIAccount(record());
    // No reset-at / reset-after-seconds header at all: parseResetAtSeconds falls
    // back to 0 (untrustworthy), same as a past or malformed reset would.
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
    }, NOW_MS), NOW_MS);
    const bucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID)!;
    expect(bucket.primary?.resetAt).toBe(0);
    expect(bucket.primary?.utilization).toBe(1);

    // 5 hours (the default staleness window, since no windowMinutes was reported)
    // after the snapshot was last refreshed: the window is treated as stale and
    // self-heals, reporting recovery so the pool's cooldown-expiry hook fires.
    const staleAt = NOW_MS + 5 * 60 * 60 * 1000 + 1;
    const recovered = sweepCodexRateLimits(account, staleAt);
    expect(recovered).toBe(true);
    const swept = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID)!;
    expect(swept.primary?.utilization).toBe(0);
    expect(swept.primary?.resetAt).toBe(0);
  });

  it("self-heals a stale exhausted named bucket even while other traffic keeps the account snapshot fresh", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "100",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);
    expect(bucketForModel(account, "gpt-5.6-sol")?.limitId).toBe("codex_bengalfox");

    // Other models keep hitting the account: only the default bucket refreshes,
    // keeping the account-wide lastUpdated fresh the whole time.
    const staleAt = NOW_MS + 5 * 60 * 60 * 1000 + 1;
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "10",
    }, staleAt - 1), staleAt - 1);

    // The named bucket's own snapshot is 5h old — it must still self-heal.
    const recovered = sweepCodexRateLimits(account, staleAt);
    expect(recovered).toBe(true);
    expect(account.rateLimits.buckets.has("codex_bengalfox")).toBe(false);
    expect(account.modelBuckets.size).toBe(0);
  });

  it("keeps a fresh exhausted named bucket while an older default bucket goes stale", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
    }, NOW_MS), NOW_MS);

    // The named bucket arrives much later; its own snapshot is still fresh at
    // sweep time even though the account first reported usage 5h ago.
    const laterMs = NOW_MS + 5 * 60 * 60 * 1000;
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "100",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, laterMs), laterMs);

    sweepCodexRateLimits(account, laterMs + 60_000);
    expect(account.rateLimits.buckets.has("codex_bengalfox")).toBe(true);
  });

  it("recovers a named bucket's individually-expired window in place while a still-live other window keeps the bucket alive", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "100",
      "x-codex-bengalfox-primary-reset-at": String(NOW_SEC + 5 * 3600), // 5h window, exhausted
      "x-codex-bengalfox-secondary-used-percent": "30",
      "x-codex-bengalfox-secondary-reset-at": String(NOW_SEC + 6 * 24 * 3600), // 6d window, not exhausted
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);
    expect(bucketForModel(account, "gpt-5.6-sol")).toBeDefined();

    // Just after the 5h primary window resets, well before the 6d secondary
    // window does.
    const staleAt = NOW_MS + 5 * 3600 * 1000 + 1000;
    const recovered = sweepCodexRateLimits(account, staleAt);
    expect(recovered).toBe(true);
    // The primary recovers in place, but the secondary still carries live
    // (nonzero) utilization — the bucket isn't "nothing left exhausted", it's
    // still meaningfully tracking usage, so the bucket and its model mapping
    // must survive rather than being tidied away.
    const bucket = account.rateLimits.buckets.get("codex_bengalfox");
    expect(bucket).toBeDefined();
    expect(bucket?.primary?.utilization).toBe(0);
    expect(bucket?.primary?.resetAt).toBe(0);
    expect(bucket?.secondary?.utilization).toBeCloseTo(0.3);
    expect(bucketForModel(account, "gpt-5.6-sol")?.limitId).toBe("codex_bengalfox");
  });

  it("zeroes an individually-expired named-bucket window in place while the bucket stays blocked by its other window", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "100",
      "x-codex-bengalfox-primary-reset-at": String(NOW_SEC + 5 * 3600), // 5h window, exhausted
      "x-codex-bengalfox-secondary-used-percent": "100",
      "x-codex-bengalfox-secondary-reset-at": String(NOW_SEC + 6 * 24 * 3600), // 6d window, exhausted
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);

    const staleAt = NOW_MS + 5 * 3600 * 1000 + 1000;
    const recovered = sweepCodexRateLimits(account, staleAt);
    expect(recovered).toBe(true);
    const bucket = account.rateLimits.buckets.get("codex_bengalfox");
    expect(bucket).toBeDefined();
    expect(bucket?.primary?.utilization).toBe(0);
    expect(bucket?.primary?.resetAt).toBe(0);
    expect(bucket?.secondary?.utilization).toBe(1); // still exhausted — still blocking
    expect(bucketForModel(account, "gpt-5.6-sol")).toBeDefined();
  });

  it("does not clear an exhausted default window with resetAt 0 while its snapshot is still fresh", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
    }, NOW_MS), NOW_MS);

    const recovered = sweepCodexRateLimits(account, NOW_MS + 60_000);
    expect(recovered).toBe(false);
    const bucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID)!;
    expect(bucket.primary?.utilization).toBe(1);
    expect(bucket.primary?.resetAt).toBe(0);
  });

  it("keeps a named bucket and its mapping alive via isRetained even though every window just zeroed out", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "0",
      "x-codex-bengalfox-primary-reset-at": String(NOW_SEC + 60),
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);
    expect(bucketForModel(account, "gpt-5.6-sol")).toBeDefined();

    // Without isRetained this bucket would be removed (window expired this
    // sweep, everything it reports is at zero utilization). An active
    // bucket-scoped cooldown retains it regardless.
    const recovered = sweepCodexRateLimits(account, NOW_MS + 61_000, {
      isRetained: limitId => limitId === "codex_bengalfox",
    });
    expect(recovered).toBe(false); // utilization was already 0 — nothing to "recover"
    expect(account.rateLimits.buckets.has("codex_bengalfox")).toBe(true);
    expect(bucketForModel(account, "gpt-5.6-sol")?.limitId).toBe("codex_bengalfox");
  });

  it("reaps a retained bucket once its cooldown ends, not eight days later", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "100",
      "x-codex-bengalfox-primary-reset-at": String(NOW_SEC + 60),
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);

    // The window resets while a longer bucket cooldown is still holding the
    // bucket, so the reap it earned has to wait.
    sweepCodexRateLimits(account, NOW_MS + 61_000, {
      isRetained: limitId => limitId === "codex_bengalfox",
    });
    expect(account.rateLimits.buckets.has("codex_bengalfox")).toBe(true);

    // Zeroing is not re-observable — utilization and resetAt are both 0 now,
    // indistinguishable from a bucket that was never used — so this sweep has
    // no expiry of its own to go on and must act on the deferred verdict.
    sweepCodexRateLimits(account, NOW_MS + 120_000);
    expect(account.rateLimits.buckets.has("codex_bengalfox")).toBe(false);
    expect(account.modelBuckets.get("gpt-5.6-sol")).toBeUndefined();
  });

  it("cancels a deferred reap when upstream reports the bucket again", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "100",
      "x-codex-bengalfox-primary-reset-at": String(NOW_SEC + 60),
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);
    sweepCodexRateLimits(account, NOW_MS + 61_000, {
      isRetained: limitId => limitId === "codex_bengalfox",
    });

    // A bucket upstream is mentioning again is live, whatever the sweep
    // concluded while it was being held back.
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "30",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS + 90_000), NOW_MS + 90_000);

    sweepCodexRateLimits(account, NOW_MS + 120_000);
    expect(account.rateLimits.buckets.has("codex_bengalfox")).toBe(true);
    expect(bucketForModel(account, "gpt-5.6-sol")?.primary?.utilization).toBe(0.3);
  });

  it("reaps a named bucket the upstream has not mentioned in over the 8-day trust horizon", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "30",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);
    expect(bucketForModel(account, "gpt-5.6-sol")).toBeDefined();

    // No resetAt was ever reported for this window, and 30% never reaches
    // full exhaustion, so nothing else would ever clear it — only the
    // "upstream went silent on this bucket" reap can.
    const longSilence = NOW_MS + 8 * 24 * 60 * 60 * 1000 + 1;
    sweepCodexRateLimits(account, longSilence);
    expect(account.rateLimits.buckets.has("codex_bengalfox")).toBe(false);
    expect(bucketForModel(account, "gpt-5.6-sol")).toBeUndefined();
  });

  it("does not reap a stale unmentioned bucket while it is retained", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "30",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);

    const longSilence = NOW_MS + 8 * 24 * 60 * 60 * 1000 + 1;
    sweepCodexRateLimits(account, longSilence, { isRetained: limitId => limitId === "codex_bengalfox" });
    expect(account.rateLimits.buckets.has("codex_bengalfox")).toBe(true);
    expect(bucketForModel(account, "gpt-5.6-sol")?.limitId).toBe("codex_bengalfox");
  });
});

describe("applyCodexRateLimits bucket cap", () => {
  it("evicts the least-recently-seen named bucket once the cap is reached", () => {
    const account = createOpenAIAccount(record());
    for (let i = 0; i < 16; i++) {
      applyCodexRateLimits(account, parseCodexRateLimits({
        [`x-bucket${i}-primary-used-percent`]: "10",
      }, NOW_MS + i), NOW_MS + i);
    }
    expect(account.rateLimits.buckets.size).toBe(16);
    expect(account.rateLimits.buckets.has("bucket0")).toBe(true);

    // A 17th distinct bucket forces an eviction. bucket0 was seen first (the
    // lowest lastSeenAt), so it is the one that goes.
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-bucket16-primary-used-percent": "10",
    }, NOW_MS + 100), NOW_MS + 100);

    expect(account.rateLimits.buckets.size).toBe(16);
    expect(account.rateLimits.buckets.has("bucket0")).toBe(false);
    expect(account.rateLimits.buckets.has("bucket16")).toBe(true);
  });

  it("never evicts the default bucket to make room, even though it was seen before every named bucket", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "10",
    }, NOW_MS), NOW_MS); // default bucket — oldest-seen entry overall
    for (let i = 0; i < 15; i++) {
      applyCodexRateLimits(account, parseCodexRateLimits({
        [`x-bucket${i}-primary-used-percent`]: "10",
      }, NOW_MS + 10 + i), NOW_MS + 10 + i);
    }
    expect(account.rateLimits.buckets.size).toBe(16); // default + 15 named = cap

    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-bucket15-primary-used-percent": "10",
    }, NOW_MS + 100), NOW_MS + 100);

    expect(account.rateLimits.buckets.size).toBe(16);
    expect(account.rateLimits.buckets.has(DEFAULT_CODEX_LIMIT_ID)).toBe(true); // never evicted
    expect(account.rateLimits.buckets.has("bucket0")).toBe(false); // oldest *named* bucket evicted instead
    expect(account.rateLimits.buckets.has("bucket15")).toBe(true);
  });

  it("leaves the evicted bucket's model mapping in place on cap-eviction", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-bucket0-primary-used-percent": "10",
      "x-bucket0-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);
    expect(bucketForModel(account, "gpt-5.6-sol")?.limitId).toBe("bucket0");

    for (let i = 1; i < 16; i++) {
      applyCodexRateLimits(account, parseCodexRateLimits({
        [`x-bucket${i}-primary-used-percent`]: "10",
      }, NOW_MS + i), NOW_MS + i);
    }
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-bucket16-primary-used-percent": "10",
    }, NOW_MS + 100), NOW_MS + 100);

    // bucket0's snapshot is gone (evicted purely for space)...
    expect(account.rateLimits.buckets.has("bucket0")).toBe(false);
    // ...but the model->limitId mapping survives, so a cooldown keyed on it,
    // or a future bucketIdForModel lookup, still resolves with no snapshot
    // present — mirroring the header-only-429 case bucketIdForModel already
    // supports.
    expect(account.modelBuckets.get("gpt-5.6-sol")?.limitId).toBe("bucket0");
    expect(bucketIdForModel(account, "gpt-5.6-sol")).toBe("bucket0");
  });
});
