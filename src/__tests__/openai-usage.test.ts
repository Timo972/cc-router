import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_LIMIT_ID,
  decodeOpenAIPlan,
  headersToRecord,
  normalizeCodexLimitId,
  parseCodexRateLimits,
  resolveActiveLimit,
} from "../providers/openai/usage.js";

const NOW_MS = 1_754_000_000_000; // fixed clock for relative resets
const NOW_SEC = Math.floor(NOW_MS / 1000);

function jwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${body}.signature`;
}

describe("parseCodexRateLimits", () => {
  it("parses the default bucket's primary and secondary windows", () => {
    const update = parseCodexRateLimits({
      "x-codex-primary-used-percent": "12.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(NOW_SEC + 600),
      "x-codex-secondary-used-percent": "80",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": String(NOW_SEC + 86_400),
    }, NOW_MS);

    expect(update.buckets).toHaveLength(1);
    const bucket = update.buckets[0]!;
    expect(bucket.limitId).toBe(DEFAULT_CODEX_LIMIT_ID);
    expect(bucket.primary).toEqual({ utilization: 0.125, resetAt: NOW_SEC + 600, windowMinutes: 300 });
    expect(bucket.secondary).toEqual({ utilization: 0.8, resetAt: NOW_SEC + 86_400, windowMinutes: 10_080 });
  });

  it("discovers named bucket families dynamically and reads their limit-name", () => {
    const update = parseCodexRateLimits({
      "x-codex-primary-used-percent": "10",
      "x-codex-bengalfox-primary-used-percent": "88",
      "x-codex-bengalfox-primary-window-minutes": "300",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS);

    expect(update.buckets.map(b => b.limitId)).toEqual(["codex", "codex_bengalfox"]);
    const named = update.buckets[1]!;
    expect(named.limitName).toBe("gpt-5.6-sol");
    expect(named.primary?.utilization).toBeCloseTo(0.88);
    expect(named.secondary).toBeUndefined();
  });

  it("clamps malformed, negative, and over-100 values without discarding the snapshot", () => {
    const update = parseCodexRateLimits({
      "x-codex-primary-used-percent": "250",
      "x-codex-secondary-used-percent": "-5",
      "x-codex-secondary-reset-at": "not-a-number",
    }, NOW_MS);

    const bucket = update.buckets[0]!;
    expect(bucket.primary?.utilization).toBe(1);
    expect(bucket.secondary?.utilization).toBe(0);
    expect(bucket.secondary?.resetAt).toBe(0);
  });

  it("falls back to reset-after-seconds when reset-at is absent", () => {
    const update = parseCodexRateLimits({
      "x-codex-primary-used-percent": "50",
      "x-codex-primary-reset-after-seconds": "120",
    }, NOW_MS);
    expect(update.buckets[0]?.primary?.resetAt).toBe(NOW_SEC + 120);
  });

  it("ignores past reset-at values and treats millisecond timestamps as seconds", () => {
    const update = parseCodexRateLimits({
      "x-codex-primary-used-percent": "50",
      "x-codex-primary-reset-at": String(NOW_SEC - 100),
      "x-codex-secondary-used-percent": "50",
      "x-codex-secondary-reset-at": String((NOW_SEC + 600) * 1000),
    }, NOW_MS);
    expect(update.buckets[0]?.primary?.resetAt).toBe(0);
    expect(update.buckets[0]?.secondary?.resetAt).toBe(NOW_SEC + 600);
  });

  it("emits no bucket when a family has no usable data", () => {
    const update = parseCodexRateLimits({ "x-codex-bengalfox-limit-name": "gpt-5.6-sol" }, NOW_MS);
    expect(update.buckets).toHaveLength(0);
  });

  it("parses credits headers and tolerates a missing balance", () => {
    const update = parseCodexRateLimits({
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-unlimited": "0",
    }, NOW_MS);
    expect(update.credits).toEqual({ hasCredits: true, unlimited: false });
  });
});

describe("normalizeCodexLimitId / resolveActiveLimit", () => {
  it("normalizes to lowercase with dashes mapped to underscores", () => {
    expect(normalizeCodexLimitId(" Codex-BengalFox ")).toBe("codex_bengalfox");
  });

  it("resolves the active limit header and rejects garbage", () => {
    expect(resolveActiveLimit({ "x-codex-active-limit": "codex-bengalfox" })).toBe("codex_bengalfox");
    expect(resolveActiveLimit({})).toBeUndefined();
    expect(resolveActiveLimit({ "x-codex-active-limit": "  " })).toBeUndefined();
    expect(resolveActiveLimit({ "x-codex-active-limit": "a".repeat(80) })).toBeUndefined();
  });
});

describe("decodeOpenAIPlan", () => {
  it("reads chatgpt_plan_type from the auth claim", () => {
    const token = jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "Plus" } });
    expect(decodeOpenAIPlan(token)).toBe("plus");
  });

  it("returns undefined for malformed tokens and missing claims", () => {
    expect(decodeOpenAIPlan("not-a-jwt")).toBeUndefined();
    expect(decodeOpenAIPlan(jwt({}))).toBeUndefined();
  });
});

describe("headersToRecord", () => {
  it("lowercases fetch Headers into a plain record", () => {
    const headers = new Headers({ "X-Codex-Primary-Used-Percent": "10" });
    expect(headersToRecord(headers)).toEqual({ "x-codex-primary-used-percent": "10" });
  });
});
