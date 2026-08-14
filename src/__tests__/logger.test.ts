import { afterEach, describe, expect, it, vi } from "vitest";
import { logWarn } from "../proxy/logger.js";

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
