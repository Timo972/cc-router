import { describe, expect, it } from "vitest";
import {
  fetchGrokSubscription,
  parseGrokUserPayload,
  GROK_USER_ENDPOINT,
} from "../providers/xai/subscription-fetch.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseGrokUserPayload", () => {
  it("extracts the plan name and code-access flag", () => {
    expect(parseGrokUserPayload({
      userId: "u1",
      email: "user@example.com",
      subscriptionTier: "GrokPro",
      hasGrokCodeAccess: true,
    })).toEqual({ ok: true, subscriptionTier: "GrokPro", hasCodeAccess: true });
  });

  it("omits fields that are absent or the wrong type", () => {
    expect(parseGrokUserPayload({ userId: "u1", subscriptionTier: 42, hasGrokCodeAccess: "yes" }))
      .toEqual({ ok: true });
  });

  it("rejects non-object bodies", () => {
    expect(parseGrokUserPayload(null)).toEqual({ ok: false, reason: "malformed" });
    expect(parseGrokUserPayload([])).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("fetchGrokSubscription", () => {
  it("reads the plan from a live 200 response", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const result = await fetchGrokSubscription({ accessToken: "tok-123" }, {
      fetch: (async (url, init) => {
        seenUrl = String(url);
        seenAuth = (init?.headers as Record<string, string>)["authorization"] ?? "";
        return jsonResponse({ subscriptionTier: "GrokPro", hasGrokCodeAccess: true });
      }) as typeof fetch,
    });
    expect(seenUrl).toBe(GROK_USER_ENDPOINT);
    expect(seenAuth).toBe("Bearer tok-123");
    expect(result).toEqual({ ok: true, subscriptionTier: "GrokPro", hasCodeAccess: true });
  });

  it("maps 401/403 to an auth failure", async () => {
    const result = await fetchGrokSubscription({ accessToken: "tok" }, {
      fetch: (async () => new Response("nope", { status: 401 })) as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "auth" });
  });

  it("maps other non-OK statuses to an http failure", async () => {
    const result = await fetchGrokSubscription({ accessToken: "tok" }, {
      fetch: (async () => new Response("boom", { status: 500 })) as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "http" });
  });

  it("maps a thrown fetch to a network failure", async () => {
    const result = await fetchGrokSubscription({ accessToken: "tok" }, {
      fetch: (async () => { throw new Error("down"); }) as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "network" });
  });
});
