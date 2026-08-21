import { describe, expect, it } from "vitest";
import { importGrokCliAuth } from "../providers/xai/import-auth.js";

function jwtWith(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf-8").toString("base64url");
  return `header.${payload}.sig`;
}

describe("importGrokCliAuth", () => {
  it("imports the Grok CLI OIDC login into an xAI account record", () => {
    const token = jwtWith({ email: "alex@example.com", exp: 2_000_000_000, tier: 1 });
    const record = importGrokCliAuth({
      grokHome: "/tmp/grok-home",
      fileExists: () => true,
      readFile: () => JSON.stringify({
        "https://auth.x.ai::client": {
          key: token,
          auth_mode: "oidc",
          email: "alex@example.com",
          refresh_token: "refresh-token",
          expires_at: "2026-08-21T14:00:00Z",
        },
      }),
    });

    expect(record).toMatchObject({
      id: "grok-alex",
      provider: "xai_subscription",
      refreshToken: "refresh-token",
      enabled: true,
    });
    expect(record.accessToken).toBe(token);
    expect(record.expiresAt).toBe(Date.parse("2026-08-21T14:00:00Z"));
  });

  it("throws when the Grok CLI is not logged in", () => {
    expect(() => importGrokCliAuth({
      grokHome: "/tmp/missing",
      fileExists: () => false,
    })).toThrow(/No Grok CLI login/);
  });
});
