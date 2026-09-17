import { describe, expect, it } from "vitest";
import { needsReauthentication } from "../providers/auth-state.js";

describe("needsReauthentication", () => {
  it("is true for an Anthropic account whose refresh token was terminally rejected", () => {
    expect(needsReauthentication({ authExpired: true })).toBe(true);
  });

  it("is true for an OpenAI account quarantined by a permanent auth failure", () => {
    expect(needsReauthentication({ authFailure: "permanent" })).toBe(true);
  });

  it("is false for an OpenAI account whose auth failure is only transient", () => {
    expect(needsReauthentication({ authFailure: "transient" })).toBe(false);
  });

  it("is false for a quarantined account with no permanent failure recorded", () => {
    // A quarantine can come from a transient rejection the next tick retries;
    // only a permanent failure means the operator has to act.
    expect(needsReauthentication({ authState: "quarantined" })).toBe(false);
  });

  it("is false for an account with working credentials", () => {
    expect(needsReauthentication({})).toBe(false);
  });
});
