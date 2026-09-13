import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeCodexResetCredit } from "../providers/openai/usage-reset.js";

afterEach(() => vi.unstubAllGlobals());

describe("Codex reset redemption", () => {
  it("sends an account-scoped, idempotent POST and parses the upstream result", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ code: "reset", windows_reset: 2 }));
    vi.stubGlobal("fetch", fetch);
    expect(await consumeCodexResetCredit({ accessToken: "token" }, "request-1"))
      .toEqual({ code: "reset" });
    expect(fetch).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer token" }),
      body: JSON.stringify({ redeem_request_id: "request-1" }),
      redirect: "error",
    }));
  });

  it.each(["nothing_to_reset", "no_credit", "already_redeemed"])("preserves the %s outcome", async code => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code })));
    expect(await consumeCodexResetCredit({ accessToken: "token" }, "request-1")).toEqual({ code });
  });

  it.each([Response.json({ code: "unknown" }), new Response("secret upstream body", { status: 500 }), new Response("not json")])
    ("does not claim success or expose raw bodies for unrecognized responses", async response => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(consumeCodexResetCredit({ accessToken: "token" }, "request-1")).rejects.toThrow("outcome unknown");
    });

  it("does not automatically retry an uncertain network failure", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("secret token"));
    vi.stubGlobal("fetch", fetch);
    await expect(consumeCodexResetCredit({ accessToken: "token" }, "request-1")).rejects.toThrow("outcome unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
