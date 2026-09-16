import { describe, expect, it, vi } from "vitest";
import { fetchAccountInfo } from "../providers/account-info-fetch.js";
import { sanitizeAccountInfo, formatAccountInfo } from "../providers/account-info.js";
import { AccountInfoCache } from "../proxy/account-info-cache.js";

const now = 1_800_000_000_000;
const jwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const account = {
  id: "claude", provider: "anthropic_subscription" as const,
  accessToken: "token", expiresAt: now + 100_000,
};
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("account metadata fetching", () => {
  it("extracts Claude identity and subscription start, not a guessed billing period", async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      account: { uuid: "user", email: "test@example.com", accessToken: "secret" },
      organization: {
        uuid: "org", name: "Personal", organization_type: "claude_max",
        rate_limit_tier: "default_claude_max_20x", subscription_status: "active",
        subscription_created_at: "2025-02-03T10:00:00Z",
        billing_type: "stripe_subscription", payment_auth_hosted_invoice_url: "secret",
      },
    }));
    const result = await fetchAccountInfo(account, { fetch, now: () => now });
    expect(fetch).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/profile",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer token" }) }));
    expect(result).toEqual({
      accountType: "personal", accountId: "user", workspaceId: "org",
      workspaceName: "Personal", email: "test@example.com", plan: "Max 20x",
      subscription: { status: "active", startedAt: "2025-02-03T10:00:00.000Z" },
      fetchedAt: now, fetchStatus: "fresh",
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|interval|currentPeriodStart|renewsAt/);
  });

  it("uses ChatGPT account structure and selects the token workspace, not the first or default", async () => {
    const accessToken = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "selected", chatgpt_plan_type: "plus" },
      "https://api.openai.com/profile": { email: "fallback@example.com" },
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ account_id: "selected", email: "live@example.com", plan_type: "business" }))
      .mockResolvedValueOnce(response({
        default_account_id: "other",
        accounts: [
          { id: "other", structure: "personal", name: "Wrong", plan_type: "plus" },
          { id: "selected", structure: "workspace", name: "Our team", plan_type: "business" },
        ],
      }));
    const info = await fetchAccountInfo({ ...account, provider: "openai_subscription", accessToken }, { fetch, now: () => now });
    expect(info).toMatchObject({
      accountType: "workspace", workspaceId: "selected", workspaceName: "Our team",
      email: "live@example.com", plan: "business", fetchStatus: "fresh",
    });
    expect(info?.subscription).toBeUndefined();
    expect(fetch.mock.calls.every(([, init]) => init.headers["chatgpt-account-id"] === "selected")).toBe(true);
  });

  it("falls back to token claims on failures, without inferring account type from the plan", async () => {
    const accessToken = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "selected", chatgpt_plan_type: "business" },
      "https://api.openai.com/profile": { email: "fallback@example.com" },
    });
    const fetch = vi.fn().mockRejectedValue(new Error("secret upstream error"));
    expect(await fetchAccountInfo({ ...account, provider: "openai_subscription", accessToken }, { fetch, now: () => now }))
      .toMatchObject({ email: "fallback@example.com", accountType: "unknown", fetchStatus: "stale" });
  });

  it("rejects mismatched ChatGPT usage identity and never picks an unrelated workspace", async () => {
    const accessToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "selected" } });
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ account_id: "wrong", email: "wrong@example.com", plan_type: "pro" }))
      .mockResolvedValueOnce(response({ accounts: [{ id: "wrong", name: "Wrong", structure: "workspace" }] }));
    const result = await fetchAccountInfo({ ...account, provider: "openai_subscription", accessToken }, { fetch, now: () => now });
    expect(JSON.stringify(result) ?? "").not.toContain("wrong");
    expect(result?.fetchStatus).not.toBe("fresh");
  });

  it("allows only the verified Grok subscription fields", async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      subscriptionTier: "GrokPro", hasGrokCodeAccess: true, renewalDate: "2027-01-01",
      email: "unverified@example.com", team_id: "unverified",
    }));
    const result = await fetchAccountInfo({ ...account, provider: "xai_subscription" }, { fetch, now: () => now });
    expect(result).toEqual({ accountType: "unknown", plan: "GrokPro", fetchedAt: now, fetchStatus: "fresh" });
  });

  it("returns unavailable for HTTP failures and malformed profiles without leaking error bodies", async () => {
    for (const res of [new Response("secret", { status: 403 }), response({}), response([])]) {
      expect(await fetchAccountInfo(account, { fetch: vi.fn().mockResolvedValue(res), now: () => now })).toBeUndefined();
    }
  });
});

describe("account metadata disclosure and display", () => {
  it("allowlists fields and rejects control sequences and malformed dates", () => {
    const safe = sanitizeAccountInfo({
      accountType: "workspace", email: "bad\u001b[31m@example.com", workspaceName: "name\ninject",
      plan: "business", accessToken: "secret", fetchedAt: now, fetchStatus: "fresh",
      subscription: { startedAt: "nonsense", interval: "annual", currentPeriodEnd: "2027-02-03T10:00:00Z",
        cancelAtPeriodEnd: true, secret: "secret" },
    });
    expect(safe).toEqual({
      accountType: "workspace", plan: "business", fetchedAt: now, fetchStatus: "fresh",
      subscription: { interval: "annual", currentPeriodEnd: "2027-02-03T10:00:00.000Z", cancelAtPeriodEnd: true },
    });
    expect(formatAccountInfo(safe)).toContain("annual");
    expect(formatAccountInfo(safe)).toContain("Ends 2027-02-03");
    expect(formatAccountInfo(safe)).not.toContain("Renews");
  });
});

describe("account metadata cache", () => {
  it("single-flights refreshes, serves cached data and marks failures stale", async () => {
    let clock = now;
    const info = { accountType: "personal" as const, email: "a@example.com", fetchStatus: "fresh" as const, fetchedAt: now };
    const fetchInfo = vi.fn().mockResolvedValue(info);
    const cache = new AccountInfoCache(() => [account], { fetchInfo, now: () => clock });
    await Promise.all([cache.refresh(), cache.refresh()]);
    expect(fetchInfo).toHaveBeenCalledTimes(1);
    expect(cache.get(account)).toEqual(info);
    await cache.refresh();
    expect(fetchInfo).toHaveBeenCalledTimes(1);
    clock += 301_000;
    fetchInfo.mockResolvedValue(undefined);
    await cache.refresh();
    expect(cache.get(account)).toEqual({ ...info, fetchStatus: "stale" });
    cache.stop();
  });

  it("preserves the last successful workspace on a partial/token-only fallback", async () => {
    const info = { accountType: "workspace" as const, workspaceName: "Example", plan: "business",
      email: "a@example.com", fetchStatus: "fresh" as const, fetchedAt: now };
    const fetchInfo = vi.fn().mockResolvedValueOnce(info).mockResolvedValueOnce({
      accountType: "unknown", plan: "plus", fetchStatus: "stale",
    });
    const cache = new AccountInfoCache(() => [account], { fetchInfo, now: () => now });
    await cache.refresh();
    await cache.refresh(true);
    expect(cache.get(account)).toEqual({ ...info, fetchStatus: "stale" });
    cache.stop();
  });

  it("skips expired and disabled accounts and retries failures only after the retry interval", async () => {
    let clock = now;
    const fetchInfo = vi.fn().mockResolvedValue(undefined);
    const cache = new AccountInfoCache(() => [
      account, { ...account, id: "expired", expiresAt: now - 1 }, { ...account, id: "disabled", enabled: false },
    ], { fetchInfo, now: () => clock });
    await cache.refresh();
    await cache.refresh();
    expect(fetchInfo).toHaveBeenCalledTimes(1);
    clock += 60_001;
    await cache.refresh();
    expect(fetchInfo).toHaveBeenCalledTimes(2);
    cache.stop();
  });

  it("does not publish an old credential result into a replacement account", async () => {
    let current = account;
    let finish!: (value: any) => void;
    const fetchInfo = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const cache = new AccountInfoCache(() => [current], { fetchInfo, now: () => now });
    const pending = cache.refresh();
    current = { ...account, accessToken: "replacement" };
    finish({ accountType: "personal", email: "old@example.com", fetchStatus: "fresh", fetchedAt: now });
    await pending;
    expect(cache.get(current)).toEqual({ accountType: "unknown", fetchStatus: "unavailable" });
    cache.stop();
  });

  it("a forced refresh after credential rotation waits for a new pass, not just the old one", async () => {
    let current = account;
    let finish!: (value: unknown) => void;
    const fetchInfo = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({
        accountType: "personal", email: "new@example.com", fetchedAt: now, fetchStatus: "fresh",
      });
    const cache = new AccountInfoCache(() => [current], { fetchInfo, now: () => now });
    const initial = cache.refresh();
    current = { ...account, accessToken: "replacement" };
    const forced = cache.refresh(true);
    const duplicate = cache.refresh(true);
    finish({ accountType: "personal", email: "old@example.com", fetchedAt: now, fetchStatus: "fresh" });
    await Promise.all([initial, forced, duplicate]);
    expect(fetchInfo).toHaveBeenCalledTimes(2);
    expect(cache.get(current).email).toBe("new@example.com");
    cache.stop();
  });

  it("bounds concurrency, skips expired/disabled credentials and aborts on shutdown", async () => {
    let active = 0;
    let peak = 0;
    const fetchInfo = vi.fn(async (_account, { signal }) => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { active--; resolve(); }, { once: true }));
      return undefined;
    });
    const rows = Array.from({ length: 5 }, (_, i) => ({ ...account, id: String(i) }));
    rows.push({ ...account, id: "expired", expiresAt: now - 1 });
    const cache = new AccountInfoCache(() => [...rows, { ...account, id: "disabled", enabled: false }], { fetchInfo, now: () => now });
    const pending = cache.refresh();
    expect(peak).toBe(2);
    cache.stop();
    await pending;
    expect(fetchInfo).toHaveBeenCalledTimes(2);
    expect(active).toBe(0);
  });
});
