import { describe, expect, it, vi } from "vitest";
import { consumeClaudeLimitReset } from "../providers/anthropic/usage-reset.js";
import { ResetNotSubmittedError } from "../proxy/reset-errors.js";

const ORG = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f";
const GRANT = "opus55-launch-promax-20260921";
const REQ = "12345678-1234-4234-8234-123456789abc";
const account = { tokens: { accessToken: "sk-ant-oat01-secret", expiresAt: 0, scopes: [] } };

describe("Claude reset redemption", () => {
  it("posts the program, grant and request id with the Claude Code surface", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ result: "reset", resets_left: 0, cleared: ["five_hour"] }));
    expect(await consumeClaudeLimitReset(account, ORG, GRANT, REQ, { fetch })).toEqual({ code: "reset", resetsLeft: 0 });
    expect(fetch).toHaveBeenCalledWith(`https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`, expect.objectContaining({
      method: "POST",
      redirect: "error",
      body: JSON.stringify({ program: "cedar_ember", grant_id: GRANT, request_id: REQ }),
      headers: expect.objectContaining({
        authorization: "Bearer sk-ant-oat01-secret",
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "claude-cli/2.1.280 (external, cli)",
        "content-type": "application/json",
      }),
    }));
  });

  it.each(["already_used", "not_limited", "cooldown", "ineligible"])("preserves %s", async code => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ result: code }));
    expect(await consumeClaudeLimitReset(account, ORG, GRANT, REQ, { fetch })).toEqual({ code });
  });

  it.each([401, 403])("reports %i as not submitted", async status => {
    const fetch = vi.fn().mockResolvedValue(new Response("secret body", { status }));
    const error = await consumeClaudeLimitReset(account, ORG, GRANT, REQ, { fetch }).catch(e => e);
    expect(error).toBeInstanceOf(ResetNotSubmittedError);
    expect(error.status).toBe(503);
    expect(String(error.message)).not.toContain("secret");
  });

  it.each([
    () => new Response("secret", { status: 429 }),
    () => new Response("secret", { status: 500 }),
    () => new Response("not json"),
    () => Response.json({ result: "surprise" }),
    () => Response.json({ result: "unavailable" }),
    () => Response.json({ result: "reset", reason: "reset_unconfirmed" }),
    () => Response.json({ result: "ineligible", reason: "stamp_indeterminate" }),
  ])("treats unrecognised responses as outcome unknown", async make => {
    const fetch = vi.fn().mockResolvedValue(make());
    await expect(consumeClaudeLimitReset(account, ORG, GRANT, REQ, { fetch })).rejects.toThrow("outcome unknown");
  });

  it("does not retry a network failure", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("sk-ant-oat01-secret"));
    await expect(consumeClaudeLimitReset(account, ORG, GRANT, REQ, { fetch })).rejects.toThrow("outcome unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([["not-a-uuid", GRANT, REQ], [ORG, "Bad Grant", REQ], [ORG, GRANT, "has space"]])
    ("never sends with malformed identifiers", async (org, grant, req) => {
      const fetch = vi.fn();
      await expect(consumeClaudeLimitReset(account, org, grant, req, { fetch })).rejects.toBeInstanceOf(ResetNotSubmittedError);
      expect(fetch).not.toHaveBeenCalled();
    });
});
