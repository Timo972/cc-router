import { describe, expect, it } from "vitest";
import {
  MAX_UPSTREAM_ATTEMPTS,
  SAME_ACCOUNT_RETRY_DELAY_MS,
  isRetryableUpstreamStatus,
  retryDelay,
} from "../proxy/upstream-retry.js";

describe("isRetryableUpstreamStatus", () => {
  it("retries rate limits and server errors only", () => {
    expect(isRetryableUpstreamStatus(429)).toBe(true);
    expect(isRetryableUpstreamStatus(500)).toBe(true);
    expect(isRetryableUpstreamStatus(502)).toBe(true);
    expect(isRetryableUpstreamStatus(503)).toBe(true);
    expect(isRetryableUpstreamStatus(529)).toBe(true);
  });

  it("never retries success, client errors, or auth failures", () => {
    expect(isRetryableUpstreamStatus(200)).toBe(false);
    expect(isRetryableUpstreamStatus(400)).toBe(false);
    expect(isRetryableUpstreamStatus(401)).toBe(false);
    expect(isRetryableUpstreamStatus(403)).toBe(false);
    expect(isRetryableUpstreamStatus(404)).toBe(false);
    expect(isRetryableUpstreamStatus(0)).toBe(false);
  });
});

describe("policy constants", () => {
  it("bounds the retry loop", () => {
    expect(MAX_UPSTREAM_ATTEMPTS).toBe(3);
    expect(SAME_ACCOUNT_RETRY_DELAY_MS).toBeGreaterThan(0);
  });
});

describe("retryDelay", () => {
  it("resolves after roughly the requested delay", async () => {
    const start = Date.now();
    await retryDelay(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it("resolves immediately for a zero delay", async () => {
    const start = Date.now();
    await retryDelay(0);
    expect(Date.now() - start).toBeLessThan(20);
  });

  it("resolves early when the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const wait = retryDelay(5_000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await wait;
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("resolves immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await retryDelay(5_000, controller.signal);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
