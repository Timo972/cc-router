import { afterEach, expect, it, vi } from "vitest";
import { createAccountsApi } from "../ui/accountsApi.js";

afterEach(() => vi.unstubAllGlobals());

it("authenticates account redemption and URL-encodes the selected account ID", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ reset: { code: "no_credit", usageRefreshed: true } }));
  vi.stubGlobal("fetch", fetch);
  expect(await createAccountsApi("http://router.local/", "secret").resetUsage("account /1", "request-id"))
    .toEqual({ code: "no_credit", usageRefreshed: true });
  expect(fetch).toHaveBeenCalledWith("http://router.local/cc-router/accounts/account%20%2F1/reset-usage", expect.objectContaining({
    method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({ redeemRequestId: "request-id" }),
  }));
});

it.each([undefined, { code: "unknown", usageRefreshed: true }, { code: ["reset"], usageRefreshed: true }, { code: "reset" }])
  ("rejects malformed redemption responses rather than confirming a spend", async reset => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ reset })));
    await expect(createAccountsApi("http://router.local").resetUsage("account", "request-id")).rejects.toThrow("Invalid reset response");
  });
