import { describe, expect, it } from "vitest";
import { loadGrokAccountSnapshots } from "../providers/xai/overview.js";

function jwtWith(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf-8").toString("base64url");
  return `header.${payload}.sig`;
}

describe("loadGrokAccountSnapshots", () => {
  const now = () => Date.parse("2026-08-21T10:00:00Z");

  it("returns an empty list when grok is not logged in", () => {
    expect(loadGrokAccountSnapshots({
      grokHome: "/tmp/missing-grok-home",
      fileExists: () => false,
    })).toEqual([]);
  });

  it("reads identity and live sessions without leaking tokens", () => {
    const token = jwtWith({
      email: "alex@example.com",
      tier: 1,
      exp: Math.floor(now() / 1000) + 3600,
    });
    const files: Record<string, string> = {
      "/tmp/grok-home/auth.json": JSON.stringify({
        "https://auth.x.ai::client": {
          key: token,
          auth_mode: "oidc",
          email: "alex@example.com",
          expires_at: "2026-08-21T14:00:00Z",
          refresh_token: "secret-refresh",
        },
      }),
      "/tmp/grok-home/active_sessions.json": JSON.stringify([
        { session_id: "sess-live", pid: 111, opened_at: "2026-08-21T09:00:00Z" },
        { session_id: "sess-dead", pid: 222, opened_at: "2026-08-21T08:00:00Z" },
      ]),
    };

    const views = loadGrokAccountSnapshots({
      grokHome: "/tmp/grok-home",
      now,
      fileExists: path => path in files,
      readFile: path => files[path]!,
      isProcessAlive: pid => pid === 111,
    });

    expect(views).toEqual([{
      id: "grok-alex",
      provider: "xai_subscription",
      enabled: true,
      healthy: true,
      busy: true,
      inFlightRequests: 0,
      activeSessions: 1,
      requestCount: 0,
      errorCount: 0,
      expiresInMs: Date.parse("2026-08-21T14:00:00Z") - now(),
      lastUsedMs: 0,
      lastRefreshMs: 0,
      tier: 1,
    }]);
    expect(JSON.stringify(views)).not.toContain("secret-refresh");
    expect(JSON.stringify(views)).not.toContain(token);
    expect(JSON.stringify(views)).not.toContain("alex@example.com");
  });

  it("marks an expired Grok login unhealthy", () => {
    const views = loadGrokAccountSnapshots({
      grokHome: "/tmp/grok-home",
      now,
      fileExists: () => true,
      readFile: () => JSON.stringify({
        a: {
          key: jwtWith({ email: "a@x.ai", exp: Math.floor(now() / 1000) - 10 }),
          auth_mode: "oidc",
          email: "a@x.ai",
          expires_at: "2026-08-21T09:00:00Z",
        },
      }),
      isProcessAlive: () => false,
    });
    expect(views[0]).toMatchObject({ id: "grok-a", healthy: false, busy: false, activeSessions: 0 });
  });
});
