import { describe, expect, it, vi } from "vitest";
import { saveProviderAccountsOnShutdown } from "../proxy/shutdown-persistence.js";

describe("shutdown account persistence", () => {
  it("attempts the OpenAI save even when the Anthropic save fails", () => {
    const saveAnthropic = vi.fn(() => { throw new Error("anthropic disk failure"); });
    const saveOpenAI = vi.fn();

    expect(() => saveProviderAccountsOnShutdown([], [], {
      saveAnthropic,
      saveOpenAI,
    })).not.toThrow();

    expect(saveAnthropic).toHaveBeenCalledWith([]);
    expect(saveOpenAI).toHaveBeenCalledWith([]);
  });
});
