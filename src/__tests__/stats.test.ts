import { describe, expect, it } from "vitest";
import { applyCodexUsage, stats, type LogEntry } from "../proxy/stats.js";

describe("applyCodexUsage", () => {
  it("normalizes OpenAI's inclusive input total into cached and uncached buckets", () => {
    const entry: LogEntry = {
      ts: Date.now(),
      accountId: "codex-account",
      model: "gpt-5",
      type: "route",
    };
    const totalsBefore = {
      input: stats.totalInputTokens,
      cacheRead: stats.totalCacheReadTokens,
      output: stats.totalOutputTokens,
    };

    applyCodexUsage(entry, {
      inputTokens: 100,
      cachedInputTokens: 60,
      outputTokens: 25,
    });

    expect(entry).toMatchObject({
      inputTokens: 40,
      cacheReadTokens: 60,
      outputTokens: 25,
    });
    expect(stats.totalInputTokens - totalsBefore.input).toBe(40);
    expect(stats.totalCacheReadTokens - totalsBefore.cacheRead).toBe(60);
    expect(stats.totalOutputTokens - totalsBefore.output).toBe(25);
  });
});
