import { describe, expect, it } from "vitest";
import {
  applyCodexRateLimits,
  bucketForModel,
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
    expect(account.modelBuckets.get("gpt-5.6-sol")).toBe("codex_bengalfox");
    expect(bucketForModel(account, "gpt-5.6-luna")).toBeUndefined();
  });

  it("drops a stale mapping whose bucket no longer exists", () => {
    const account = createOpenAIAccount(record());
    learnModelBucket(account, "gpt-5.6-sol", "codex_gone");
    expect(bucketForModel(account, "gpt-5.6-sol")).toBeUndefined();
    expect(account.modelBuckets.has("gpt-5.6-sol")).toBe(false);
  });

  it("never maps the default limit id and bounds the map", () => {
    const account = createOpenAIAccount(record());
    learnModelBucket(account, "gpt-5.6-sol", DEFAULT_CODEX_LIMIT_ID);
    expect(account.modelBuckets.size).toBe(0);
    for (let i = 0; i < 40; i++) learnModelBucket(account, `model-${i}`, "codex_x");
    expect(account.modelBuckets.size).toBeLessThanOrEqual(32);
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
});
