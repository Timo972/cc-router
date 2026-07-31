import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountsApi } from "../ui/accountsApi.js";

describe("createAccountsApi", () => {
  afterEach(() => vi.restoreAllMocks());

  it("updates all accounts for a provider through the management endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      provider: "openai_subscription",
      enabled: false,
      changed: 2,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const api = createAccountsApi("http://router.local/", "secret");

    await api.setProviderEnabled("openai_subscription", false);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://router.local/cc-router/accounts/providers/openai_subscription",
      expect.objectContaining({
        method: "PATCH",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("reads the authenticated account safe view without retaining arbitrary response fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      accounts: [{
        id: "max-1",
        provider: "anthropic_subscription",
        rateLimits: { usage: { modelLimits: [] } },
        accessToken: "must-not-be-retained",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const api = createAccountsApi("http://router.local", "secret");
    const accounts = await api.list();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://router.local/cc-router/accounts",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer secret" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(accounts).toEqual([{
      id: "max-1",
      provider: "anthropic_subscription",
      rateLimits: { usage: { modelLimits: [] } },
    }]);
    expect(JSON.stringify(accounts)).not.toContain("must-not-be-retained");
  });
});
