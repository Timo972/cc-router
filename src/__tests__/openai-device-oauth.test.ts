import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async input => {
    const url = input instanceof Request ? input.url : String(input);
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (!hostname.startsWith("127.") && hostname !== "::1") {
      throw new Error(`Task 9 test blocked non-loopback fetch: ${hostname}`);
    }
    throw new Error("Task 9 test requires an injected loopback transport");
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
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
      verificationUrl: "https://auth.openai.com/codex/device",
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

    expect(prompts).toEqual([{ url: "https://auth.openai.com/codex/device", code: "ABCD-1234" }]);
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

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [418, "upstream_4xx"],
    [503, "upstream_5xx"],
  ] as const)("classifies device-code HTTP %i without retaining its raw body in telemetry fields", async (status, reason) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("PRIVATE response body", { status }));

    const error = await requestOpenAIDeviceCode({ fetchImpl }).catch(value => value);

    expect(error).toBeInstanceOf(SetupDiagnosticError);
    expect(error.message).toContain("PRIVATE response body");
    expect(error.classification).toEqual({
      stage: "device_code_request",
      reason,
      expected: true,
      httpStatusCode: status,
    });
    expect(JSON.stringify(error.classification)).not.toContain("PRIVATE");
  });

  it("classifies authorization timeout at the polling failure site", async () => {
    let now = 0;
    const error = await exchangeOpenAIDeviceCodeForTokens({
      fetchImpl: vi.fn().mockResolvedValue(new Response("pending", { status: 403 })),
      sleep: async () => { now += 2_000; },
      now: () => now,
      timeoutMs: 1_000,
      deviceCode: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "PRIVATE-CODE",
        deviceAuthId: "PRIVATE-ID",
        intervalSeconds: 1,
      },
    }).catch(value => value);

    expect(error).toBeInstanceOf(SetupDiagnosticError);
    expect(error.classification).toEqual({
      stage: "authorization_polling",
      reason: "timeout",
      expected: true,
    });
  });

  it("reports malformed access-token parsing as an unexpected sanitized issue", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_code: "PRIVATE-auth",
        code_challenge: "PRIVATE-challenge",
        code_verifier: "PRIVATE-verifier",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id_token: "PRIVATE-id",
        access_token: "not-a-jwt",
        refresh_token: "PRIVATE-refresh",
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const error = await exchangeOpenAIDeviceCodeForTokens({
      fetchImpl,
      sleep: async () => undefined,
      deviceCode: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "PRIVATE-CODE",
        deviceAuthId: "PRIVATE-ID",
        intervalSeconds: 1,
      },
    }).catch(value => value);

    expect(error).toBeInstanceOf(SetupDiagnosticError);
    expect(error.classification).toEqual({
      stage: "access_token_parse",
      reason: "unexpected_response_shape",
      expected: false,
      httpStatusCode: 200,
    });
    expect(JSON.stringify(error.classification)).not.toContain("PRIVATE");
  });

  it("reports completed device OAuth stages without exposing device values", async () => {
    const accessToken = jwtWithExp(2_000_000_000);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_auth_id: "PRIVATE-device",
        user_code: "PRIVATE-code",
        interval: 1,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_code: "PRIVATE-auth",
        code_challenge: "PRIVATE-challenge",
        code_verifier: "PRIVATE-verifier",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id_token: "PRIVATE-id",
        access_token: accessToken,
        refresh_token: "PRIVATE-refresh",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const stages: string[] = [];

    await loginOpenAIWithDeviceCode({
      accountId: "local-account-id",
      fetchImpl,
      sleep: async () => undefined,
      onStageCompleted: stage => stages.push(stage),
    });

    expect(stages).toEqual([
      "device_code_request",
      "authorization_polling",
      "token_exchange",
      "access_token_parse",
    ]);
    expect(JSON.stringify(stages)).not.toContain("PRIVATE");
  });

  it("rejects a non-numeric device polling interval at the response-shape boundary", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      device_auth_id: "PRIVATE-device",
      user_code: "PRIVATE-code",
      interval: "not-a-number",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const error = await requestOpenAIDeviceCode({ fetchImpl }).catch(value => value);

    expect(error).toBeInstanceOf(SetupDiagnosticError);
    expect(error.classification).toEqual({
      stage: "device_code_request",
      reason: "unexpected_response_shape",
      expected: true,
      httpStatusCode: 200,
    });
  });

  it("rejects an incomplete authorization response before token exchange", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      authorization_code: "PRIVATE-auth",
      code_verifier: "PRIVATE-verifier",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const error = await exchangeOpenAIDeviceCodeForTokens({
      fetchImpl,
      sleep: async () => undefined,
      deviceCode: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "PRIVATE-CODE",
        deviceAuthId: "PRIVATE-ID",
        intervalSeconds: 1,
      },
    }).catch(value => value);

    expect(error).toBeInstanceOf(SetupDiagnosticError);
    expect(error.classification).toEqual({
      stage: "authorization_polling",
      reason: "unexpected_response_shape",
      expected: true,
      httpStatusCode: 200,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ["device JSON", "device_code_request", async () => requestOpenAIDeviceCode({
      fetchImpl: vi.fn().mockResolvedValue(new Response("{PRIVATE", { status: 207 })),
    })],
    ["device shape", "device_code_request", async () => requestOpenAIDeviceCode({
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ user_code: "PRIVATE" }), {
        status: 207,
        headers: { "content-type": "application/json" },
      })),
    })],
    ["device null", "device_code_request", async () => requestOpenAIDeviceCode({
      fetchImpl: vi.fn().mockResolvedValue(new Response("null", {
        status: 207,
        headers: { "content-type": "application/json" },
      })),
    })],
    ["authorization JSON", "authorization_polling", async () => exchangeOpenAIDeviceCodeForTokens({
      fetchImpl: vi.fn().mockResolvedValue(new Response("{PRIVATE", { status: 207 })),
      sleep: async () => undefined,
      deviceCode: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "PRIVATE",
        deviceAuthId: "PRIVATE",
        intervalSeconds: 1,
      },
    })],
    ["authorization shape", "authorization_polling", async () => exchangeOpenAIDeviceCodeForTokens({
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        authorization_code: "PRIVATE",
      }), { status: 207, headers: { "content-type": "application/json" } })),
      sleep: async () => undefined,
      deviceCode: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "PRIVATE",
        deviceAuthId: "PRIVATE",
        intervalSeconds: 1,
      },
    })],
    ["token JSON", "token_exchange", async () => exchangeOpenAIDeviceCodeForTokens({
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          authorization_code: "PRIVATE",
          code_challenge: "PRIVATE",
          code_verifier: "PRIVATE",
        }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response("{PRIVATE", { status: 207 })),
      sleep: async () => undefined,
      deviceCode: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "PRIVATE",
        deviceAuthId: "PRIVATE",
        intervalSeconds: 1,
      },
    })],
    ["token shape", "token_exchange", async () => exchangeOpenAIDeviceCodeForTokens({
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          authorization_code: "PRIVATE",
          code_challenge: "PRIVATE",
          code_verifier: "PRIVATE",
        }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "PRIVATE" }), {
          status: 207,
          headers: { "content-type": "application/json" },
        })),
      sleep: async () => undefined,
      deviceCode: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "PRIVATE",
        deviceAuthId: "PRIVATE",
        intervalSeconds: 1,
      },
    })],
    ["token null", "token_exchange", async () => exchangeOpenAIDeviceCodeForTokens({
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          authorization_code: "PRIVATE",
          code_challenge: "PRIVATE",
          code_verifier: "PRIVATE",
        }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response("null", {
          status: 207,
          headers: { "content-type": "application/json" },
        })),
      sleep: async () => undefined,
      deviceCode: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "PRIVATE",
        deviceAuthId: "PRIVATE",
        intervalSeconds: 1,
      },
    })],
    ["access-token parse", "access_token_parse", async () => exchangeOpenAIDeviceCodeForTokens({
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          authorization_code: "PRIVATE",
          code_challenge: "PRIVATE",
          code_verifier: "PRIVATE",
        }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id_token: "PRIVATE",
          access_token: "not-a-jwt",
          refresh_token: "PRIVATE",
        }), { status: 207, headers: { "content-type": "application/json" } })),
      sleep: async () => undefined,
      deviceCode: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "PRIVATE",
        deviceAuthId: "PRIVATE",
        intervalSeconds: 1,
      },
    })],
    ["access-token null claims", "access_token_parse", async () => exchangeOpenAIDeviceCodeForTokens({
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          authorization_code: "PRIVATE",
          code_challenge: "PRIVATE",
          code_verifier: "PRIVATE",
        }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id_token: "PRIVATE",
          access_token: `header.${Buffer.from("null").toString("base64url")}.signature`,
          refresh_token: "PRIVATE",
        }), { status: 207, headers: { "content-type": "application/json" } })),
      sleep: async () => undefined,
      deviceCode: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "PRIVATE",
        deviceAuthId: "PRIVATE",
        intervalSeconds: 1,
      },
    })],
  ] as const)("carries the successful HTTP status through malformed %s", async (_label, stage, operation) => {
    const error = await operation().catch(value => value);

    expect(error).toBeInstanceOf(SetupDiagnosticError);
    expect(error.classification).toEqual(expect.objectContaining({
      stage,
      reason: "unexpected_response_shape",
      httpStatusCode: 207,
    }));
    expect(JSON.stringify(error.classification)).not.toContain("PRIVATE");
  });
});
