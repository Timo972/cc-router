import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenAIDeviceVerificationUrl,
  exchangeOpenAIDeviceCodeForTokens,
  loginOpenAIWithDeviceCode,
  requestOpenAIDeviceCode,
} from "../providers/openai/device-oauth.js";
import { SetupDiagnosticError } from "../telemetry/setup-diagnostics.js";

function jwtWithExp(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.signature`;
}

// No test in this file may reach the real browser opener.
beforeEach(() => {
  vi.stubEnv("CC_ROUTER_NO_BROWSER", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildOpenAIDeviceVerificationUrl", () => {
  it("carries the user code", () => {
    expect(buildOpenAIDeviceVerificationUrl("https://auth.openai.com", "ABCD-EFGH"))
      .toBe("https://auth.openai.com/codex/device?user_code=ABCD-EFGH");
  });

  it("adds the email as login_hint when known", () => {
    expect(buildOpenAIDeviceVerificationUrl("https://auth.openai.com", "ABCD-EFGH", "me@example.com"))
      .toBe("https://auth.openai.com/codex/device?user_code=ABCD-EFGH&login_hint=me%40example.com");
  });

  it("does not double the slash when the issuer has a trailing one", () => {
    expect(buildOpenAIDeviceVerificationUrl("https://auth.openai.com/", "ABCD-EFGH"))
      .toBe("https://auth.openai.com/codex/device?user_code=ABCD-EFGH");
  });
});

describe("OpenAI device OAuth", () => {
  it("requests a device code from the OpenAI Codex auth endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        device_auth_id: "dev_123",
        user_code: "ABCD-1234",
        interval: "2",
      }),
    } as Response);

    const code = await requestOpenAIDeviceCode({ fetchImpl });

    expect(code).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device?user_code=ABCD-1234",
      userCode: "ABCD-1234",
      deviceAuthId: "dev_123",
      intervalSeconds: 2,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" }),
      }),
    );
  });

  it("polls for authorization code and exchanges it for tokens", async () => {
    const accessToken = jwtWithExp(2_000_000_000);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_code: "auth_code",
          code_challenge: "challenge",
          code_verifier: "verifier",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id_token: "id.jwt.token",
          access_token: accessToken,
          refresh_token: "refresh",
        }),
      } as Response);

    const tokens = await exchangeOpenAIDeviceCodeForTokens({
      fetchImpl,
      sleep: async () => {},
      deviceCode: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        deviceAuthId: "dev_123",
        intervalSeconds: 1,
      },
    });

    expect(tokens).toEqual({
      idToken: "id.jwt.token",
      accessToken,
      refreshToken: "refresh",
      expiresAt: 2_000_000_000_000,
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
  });

  it("logs in with device code and returns an OpenAI subscription account record", async () => {
    const accessToken = jwtWithExp(2_000_000_000);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_auth_id: "dev_123",
          user_code: "ABCD-1234",
          interval: "1",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_code: "auth_code",
          code_challenge: "challenge",
          code_verifier: "verifier",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id_token: "id.jwt.token",
          access_token: accessToken,
          refresh_token: "refresh",
        }),
      } as Response);

    const prompts: Array<{ url: string; code: string }> = [];
    const record = await loginOpenAIWithDeviceCode({
      accountId: "openai-primary",
      fetchImpl,
      sleep: async () => {},
      onDeviceCode: (code) => prompts.push({ url: code.verificationUrl, code: code.userCode }),
    });

    expect(prompts).toEqual([
      { url: "https://auth.openai.com/codex/device?user_code=ABCD-1234", code: "ABCD-1234" },
    ]);
    expect(record).toEqual({
      id: "openai-primary",
      provider: "openai_subscription",
      accessToken,
      refreshToken: "refresh",
      expiresAt: 2_000_000_000_000,
      scopes: ["openid", "profile", "email", "offline_access"],
      enabled: true,
    });
  });

  it("attributes a malformed token-exchange body to the token_exchange stage", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ authorization_code: "code", code_verifier: "v" }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
      } as unknown as Response);

    const failure = await exchangeOpenAIDeviceCodeForTokens({
      fetchImpl,
      deviceCode: { verificationUrl: "u", userCode: "c", deviceAuthId: "d", intervalSeconds: 0 },
      sleep: async () => undefined,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SetupDiagnosticError);
    expect((failure as SetupDiagnosticError).message).toBe("Unexpected token < in JSON");
    expect((failure as SetupDiagnosticError).classification).toMatchObject({
      stage: "token_exchange",
      reason: "unexpected_response_shape",
      expected: true,
    });
  });
});

describe("loginOpenAIWithDeviceCode browser opening", () => {
  function deviceFlowFetch(): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/deviceauth/usercode")) {
        return Response.json({ device_auth_id: "d", user_code: "CODE", interval: 0 });
      }
      if (url.endsWith("/deviceauth/token")) {
        return Response.json({ authorization_code: "c", code_challenge: "x", code_verifier: "y" });
      }
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
      return Response.json({ id_token: "i", access_token: jwt, refresh_token: "r" });
    }) as unknown as typeof fetch;
  }

  it("opens the verification URL once, after reporting the device code", async () => {
    const calls: string[] = [];
    const openBrowser = vi.fn(async (url: string) => {
      calls.push(url);
      return true;
    });

    await loginOpenAIWithDeviceCode({
      accountId: "o",
      fetchImpl: deviceFlowFetch(),
      loginHint: "me@example.com",
      openBrowser,
      onDeviceCode: () => calls.push("printed"),
      sleep: async () => {},
    });

    expect(calls).toEqual([
      "printed",
      "https://auth.openai.com/codex/device?user_code=CODE&login_hint=me%40example.com",
    ]);
    expect(openBrowser).toHaveBeenCalledTimes(1);
  });

  it("omits login_hint when no email is known", async () => {
    const opened: string[] = [];
    await loginOpenAIWithDeviceCode({
      accountId: "o",
      fetchImpl: deviceFlowFetch(),
      openBrowser: async (url: string) => {
        opened.push(url);
        return true;
      },
      sleep: async () => {},
    });

    expect(opened).toEqual(["https://auth.openai.com/codex/device?user_code=CODE"]);
  });

  it("completes the login even when the browser cannot be opened", async () => {
    const record = await loginOpenAIWithDeviceCode({
      accountId: "o",
      fetchImpl: deviceFlowFetch(),
      openBrowser: async () => false,
      sleep: async () => {},
    });

    expect(record.id).toBe("o");
  });

  it("completes the login even when the opener rejects", async () => {
    const record = await loginOpenAIWithDeviceCode({
      accountId: "o",
      fetchImpl: deviceFlowFetch(),
      openBrowser: async () => {
        throw new Error("spawn xdg-open ENOENT");
      },
      sleep: async () => {},
    });

    expect(record.id).toBe("o");
  });
});
