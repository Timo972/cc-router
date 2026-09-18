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

describe("AccountInfoCache.refreshOne", () => {
  const sources = () => [
    { id: "a", provider: "anthropic_subscription" as const, accessToken: "a", expiresAt: 2_000, scopes: ["user:inference", "user:profile"] },
    { id: "b", provider: "openai_subscription" as const, accessToken: "b", expiresAt: 2_000 },
  ];

  it("fetches identity for that account only and makes it readable", async () => {
    const fetchInfo = vi.fn(async () => ({ accountType: "personal" as const, email: "a@example.com", fetchStatus: "fresh" as const, fetchedAt: 1 }));
    const cache = new AccountInfoCache(sources, { now: () => 1, fetchInfo });
    await cache.refreshOne({ id: "a", provider: "anthropic_subscription" });
    expect(fetchInfo.mock.calls.map(([source]) => source.id)).toEqual(["a"]);
    expect(cache.get(sources()[0]!)).toMatchObject({ email: "a@example.com", fetchStatus: "fresh" });
    cache.stop();
  });

  it("joins an in-flight fetch for the same account instead of issuing a second request", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchInfo = vi.fn(async () => {
      await gate;
      return { accountType: "personal" as const, email: "a@example.com", fetchStatus: "fresh" as const, fetchedAt: 1 };
    });
    const cache = new AccountInfoCache(sources, { now: () => 1, fetchInfo });

    const pass = cache.refresh(true);
    await new Promise(resolve => setImmediate(resolve));
    const one = cache.refreshOne({ id: "a", provider: "anthropic_subscription" });
    const again = cache.refreshOne({ id: "a", provider: "anthropic_subscription" });
    release();
    await Promise.all([pass, one, again]);

    expect(fetchInfo.mock.calls.filter(([source]) => source.id === "a")).toHaveLength(1);
    expect(cache.get(sources()[0]!)).toMatchObject({ email: "a@example.com", fetchStatus: "fresh" });
    cache.stop();
  });

  it("ignores an unknown account and an inference-only Claude token", async () => {
    const fetchInfo = vi.fn(async () => ({ accountType: "personal" as const, fetchStatus: "fresh" as const, fetchedAt: 1 }));
    const cache = new AccountInfoCache(() => [
      { id: "long", provider: "anthropic_subscription" as const, accessToken: "x", expiresAt: 2_000, scopes: ["user:inference"] },
    ], { now: () => 1, fetchInfo });
    await cache.refreshOne({ id: "nope", provider: "anthropic_subscription" });
    await cache.refreshOne({ id: "long", provider: "anthropic_subscription" });
    expect(fetchInfo).not.toHaveBeenCalled();
    cache.stop();
  });
});
