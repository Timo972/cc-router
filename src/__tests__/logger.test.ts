import { afterEach, describe, expect, it, vi } from "vitest";
import { logRoute, logWarn } from "../proxy/logger.js";

describe("logWarn", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints a single [WARN] line carrying the context and message", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logWarn("responses", "max_output_tokens dropped");

    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain("[WARN]");
    expect(line).toContain("responses");
    expect(line).toContain("max_output_tokens dropped");
  });
});

describe("ts() timestamp prefix", () => {
  afterEach(() => vi.restoreAllMocks());

  it("carries a full date, not just time-of-day, so multi-day logs stay distinguishable by hour", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logRoute("acct-1", 1, 5, "sticky");

    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0][0]);
    // e.g. "[2026-08-24 12:03:56]" — date + time, space-separated, no "T".
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
  });
});
