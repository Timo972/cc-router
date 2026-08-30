import { describe, expect, it } from "vitest";
import {
  MAX_UPSTREAM_ATTEMPTS,
  RETRY_REFRESH_TIMEOUT_MS,
  SAME_ACCOUNT_RETRY_DELAY_MS,
  boundedWait,
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

describe("boundedWait", () => {
  it("resolves the work's value when it settles inside the deadline", async () => {
    await expect(boundedWait(Promise.resolve("done"), 5_000, "fallback")).resolves.toBe("done");
  });

  it("returns the fallback when the deadline passes first", async () => {
    const start = Date.now();
    const result = await boundedWait(new Promise(() => {}), 30, "fallback");
    expect(result).toBe("fallback");
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("returns the fallback as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const wait = boundedWait(new Promise(() => {}), 5_000, "fallback", controller.signal);
    setTimeout(() => controller.abort(), 10);
    const start = Date.now();
    expect(await wait).toBe("fallback");
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("returns the fallback immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await boundedWait(new Promise(() => {}), 5_000, "fallback", controller.signal)).toBe("fallback");
  });

  it("maps a rejection inside the deadline to the fallback", async () => {
    await expect(boundedWait(Promise.reject(new Error("boom")), 5_000, "fallback")).resolves.toBe("fallback");
  });

  it("swallows a rejection arriving after the deadline already resolved the wait", async () => {
    let reject!: (error: Error) => void;
    const work = new Promise<string>((_, rej) => { reject = rej; });
    expect(await boundedWait(work, 10, "fallback")).toBe("fallback");
    // A late rejection must not surface as an unhandled rejection — vitest
    // fails the run if one escapes.
    reject(new Error("late failure"));
    await new Promise(resolve => setImmediate(resolve));
  });

  it("keeps a generous production deadline", () => {
    expect(RETRY_REFRESH_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(RETRY_REFRESH_TIMEOUT_MS).toBeLessThan(60_000);
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
