import { describe, expect, it, vi } from "vitest";
import { AccountInfoCache } from "../proxy/account-info-cache.js";

describe("AccountInfoCache scopes", () => {
  it("never fetches identity for an anthropic source without user:profile", async () => {
    const fetchInfo = vi.fn(async () => ({ accountType: "personal" as const, fetchStatus: "fresh" as const, fetchedAt: 1 }));
    const cache = new AccountInfoCache(() => [
      { id: "long", provider: "anthropic_subscription", accessToken: "a", expiresAt: 2_000, scopes: ["user:inference"] },
      { id: "full", provider: "anthropic_subscription", accessToken: "b", expiresAt: 2_000, scopes: ["user:inference", "user:profile"] },
    ], { now: () => 1, fetchInfo });
    await cache.refresh(true);
    expect(fetchInfo.mock.calls.map(([source]) => source.id)).toEqual(["full"]);
    cache.stop();
  });

  it("does not gate OpenAI or xAI sources on scopes", async () => {
    const fetchInfo = vi.fn(async () => ({ accountType: "personal" as const, fetchStatus: "fresh" as const, fetchedAt: 1 }));
    const cache = new AccountInfoCache(() => [
      { id: "openai", provider: "openai_subscription", accessToken: "a", expiresAt: 2_000, scopes: ["openid"] },
      { id: "xai", provider: "xai_subscription", accessToken: "b", expiresAt: 2_000 },
    ], { now: () => 1, fetchInfo });
    await cache.refresh(true);
    expect(fetchInfo.mock.calls.map(([source]) => source.id).sort()).toEqual(["openai", "xai"]);
    cache.stop();
  });
});
