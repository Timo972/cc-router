import { describe, expect, it, vi } from "vitest";
import {
  exchangeXaiDeviceCodeForTokens,
  requestXaiDeviceCode,
} from "../providers/xai/device-oauth.js";

function jwtWithExp(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("xAI device OAuth", () => {
  it("requests an RFC 8628 device code", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        device_code: "dev-1",
        user_code: "ABCD-1234",
        verification_uri: "https://accounts.x.ai/oauth2/device",
        verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
        interval: 5,
      }),
    } as Response);

    const code = await requestXaiDeviceCode({ fetchImpl });
    expect(code).toEqual({
      verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
      userCode: "ABCD-1234",
      deviceCode: "dev-1",
      intervalSeconds: 5,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://auth.x.ai/oauth2/device/code",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("polls through authorization_pending then exchanges tokens", async () => {
    const accessToken = jwtWithExp(2_000_000_000);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: "authorization_pending" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: accessToken,
          refresh_token: "refresh",
        }),
      } as Response);

    const tokens = await exchangeXaiDeviceCodeForTokens({
      fetchImpl,
      sleep: async () => {},
      deviceCode: {
        verificationUrl: "https://accounts.x.ai/oauth2/device",
        userCode: "ABCD-1234",
        deviceCode: "dev-1",
        intervalSeconds: 1,
      },
    });

    expect(tokens).toEqual({
      accessToken,
      refreshToken: "refresh",
      expiresAt: 2_000_000_000_000,
    });
  });
});
