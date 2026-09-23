import { afterEach, expect, it, vi } from "vitest";
import { createAccountsApi, RouterRefusedResetError } from "../ui/accountsApi.js";

afterEach(() => vi.unstubAllGlobals());

it("authenticates account redemption and URL-encodes the selected account ID", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ reset: { provider: "openai", code: "no_credit", usageRefreshed: true } }));
  vi.stubGlobal("fetch", fetch);
  expect(await createAccountsApi("http://router.local/", "secret").resetUsage("account /1", "request-id"))
    .toEqual({ provider: "openai", code: "no_credit", usageRefreshed: true, replay: false });
  expect(fetch).toHaveBeenCalledWith("http://router.local/cc-router/accounts/account%20%2F1/reset-usage", expect.objectContaining({
    method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({ redeemRequestId: "request-id" }),
  }));
});

it.each([
  undefined,
  { provider: "openai", code: "unknown", usageRefreshed: true },
  { provider: "openai", code: ["reset"], usageRefreshed: true },
  { provider: "openai", code: "reset" },
  { code: "reset", usageRefreshed: true },
  { provider: "openai", code: "already_used", usageRefreshed: true },
  { provider: "anthropic", code: "no_credit", usageRefreshed: true },
  { provider: "anthropic", code: "unavailable", usageRefreshed: true },
])
  ("rejects malformed redemption responses rather than confirming a spend", async reset => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ reset })));
    await expect(createAccountsApi("http://router.local").resetUsage("account", "request-id")).rejects.toThrow("Invalid reset response");
  });

it("parses a Claude redemption with the remaining count", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    reset: { provider: "anthropic", code: "reset", usageRefreshed: true, resetsLeft: 0, replay: false },
  })));
  expect(await createAccountsApi("http://router.local").resetUsage("claude", "request-id"))
    .toEqual({ provider: "anthropic", code: "reset", usageRefreshed: true, resetsLeft: 0, replay: false });
});

it("omits resetsLeft when the router does not report it", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    reset: { provider: "anthropic", code: "cooldown", usageRefreshed: false },
  })));
  expect(await createAccountsApi("http://router.local").resetUsage("claude", "request-id"))
    .toEqual({ provider: "anthropic", code: "cooldown", usageRefreshed: false, replay: false });
});

it.each([
  [true, true],
  [false, false],
  ["true", false],
  [1, false],
])("reads replay %j as %s", async (replay, expected) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    reset: { provider: "anthropic", code: "already_used", usageRefreshed: true, replay },
  })));
  expect(await createAccountsApi("http://router.local").resetUsage("claude", "request-id"))
    .toEqual({ provider: "anthropic", code: "already_used", usageRefreshed: true, replay: expected });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    reset: { provider: "openai", code: "already_redeemed", usageRefreshed: true, replay },
  })));
  expect(await createAccountsApi("http://router.local").resetUsage("chatgpt", "request-id"))
    .toEqual({ provider: "openai", code: "already_redeemed", usageRefreshed: true, replay: expected });
});

it.each([400, 404, 409, 503])("surfaces the router's error text for HTTP %i", async status => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "No reset available\u0007 for this account" }, { status })));
  const attempt = createAccountsApi("http://router.local").resetUsage("claude", "request-id");
  await expect(attempt).rejects.toThrow(/^No reset available for this account$/);
  await expect(attempt).rejects.toBeInstanceOf(RouterRefusedResetError);
});

it.each([500, 502, 504, 401])("keeps HTTP %i as a bare status even with an error body", async status => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "upstream said something" }, { status })));
  const attempt = createAccountsApi("http://router.local").resetUsage("claude", "request-id");
  await expect(attempt).rejects.toThrow(new RegExp(`^HTTP ${status}$`));
  await expect(attempt).rejects.not.toBeInstanceOf(RouterRefusedResetError);
});

it("falls back to the HTTP status when a 409 body is not JSON or has no error", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 409 })));
  await expect(createAccountsApi("http://router.local").resetUsage("claude", "request-id")).rejects.toThrow(/^HTTP 409$/);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: 42 }, { status: 409 })));
  await expect(createAccountsApi("http://router.local").resetUsage("claude", "request-id")).rejects.toThrow(/^HTTP 409$/);
});
