import { describe, expect, it } from "vitest";
import { createOpenAIAccountRecord } from "../providers/openai/account-record.js";
import { SetupDiagnosticError } from "../telemetry/setup-diagnostics.js";

describe("createOpenAIAccountRecord", () => {
  it("normalizes a valid OpenAI subscription account record", () => {
    expect(createOpenAIAccountRecord({
      id: "openai-primary",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: "1999999999000",
      scopes: "openid profile email offline_access",
    })).toEqual({
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1999999999000,
      scopes: ["openid", "profile", "email", "offline_access"],
      enabled: true,
    });
  });

  it("rejects invalid account IDs and missing tokens", () => {
    expect(() => createOpenAIAccountRecord({
      id: "bad id",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: "1999999999000",
    })).toThrow(/Only letters/);

    expect(() => createOpenAIAccountRecord({
      id: "openai-primary",
      accessToken: "",
      refreshToken: "refresh",
      expiresAt: "1999999999000",
    })).toThrow(/Access token/);
  });

  it("attaches a safe typed classification while keeping validation detail local", () => {
    const error = (() => {
      try {
        createOpenAIAccountRecord({
          id: "PRIVATE invalid id",
          accessToken: "PRIVATE access",
          refreshToken: "PRIVATE refresh",
          expiresAt: "not-a-date",
        });
      } catch (value) {
        return value;
      }
    })();

    expect(error).toBeInstanceOf(SetupDiagnosticError);
    expect((error as SetupDiagnosticError).classification).toEqual({
      stage: "credential_parse",
      reason: "malformed_credentials",
      expected: true,
    });
    expect(JSON.stringify((error as SetupDiagnosticError).classification)).not.toContain("PRIVATE");
  });
});
