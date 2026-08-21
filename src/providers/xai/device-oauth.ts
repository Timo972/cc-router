import { createXaiAccountRecord, XAI_DEFAULT_SCOPES, type XaiAccountRecord } from "./account-record.js";

const DEFAULT_ISSUER = "https://auth.x.ai";
const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

type FetchImpl = typeof fetch;

export interface XaiDeviceCode {
  verificationUrl: string;
  userCode: string;
  deviceCode: string;
  intervalSeconds: number;
}

export interface XaiDeviceOAuthOptions {
  issuer?: string;
  clientId?: string;
  fetchImpl?: FetchImpl;
}

export interface ExchangeXaiDeviceCodeOptions extends XaiDeviceOAuthOptions {
  deviceCode: XaiDeviceCode;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}

export interface LoginXaiWithDeviceCodeOptions extends XaiDeviceOAuthOptions {
  accountId: string;
  onDeviceCode?: (code: XaiDeviceCode) => void;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function issuerOf(opts: XaiDeviceOAuthOptions): string {
  return (opts.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, "");
}

function clientIdOf(opts: XaiDeviceOAuthOptions): string {
  return opts.clientId ?? DEFAULT_CLIENT_ID;
}

function fetchOf(opts: XaiDeviceOAuthOptions): FetchImpl {
  return opts.fetchImpl ?? fetch;
}

async function readError(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function parseAccessTokenExpiry(accessToken: string, expiresIn?: number, now = Date.now()): number {
  const parts = accessToken.split(".");
  if (parts[1]) {
    try {
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as { exp?: unknown };
      if (typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > 0) {
        return claims.exp * 1000;
      }
    } catch { /* fall through */ }
  }
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return now + expiresIn * 1000;
  }
  throw new Error("xAI access token has no usable expiry");
}

export async function requestXaiDeviceCode(opts: XaiDeviceOAuthOptions = {}): Promise<XaiDeviceCode> {
  const issuer = issuerOf(opts);
  const form = new URLSearchParams({
    client_id: clientIdOf(opts),
    scope: XAI_DEFAULT_SCOPES.join(" "),
  });
  const res = await fetchOf(opts)(`${issuer}/oauth2/device/code`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });
  if (!res.ok) {
    throw new Error(`xAI device code request failed (${res.status}): ${await readError(res)}`);
  }
  const body = await res.json() as DeviceCodeResponse;
  if (!body.device_code || !body.user_code || !body.verification_uri) {
    throw new Error("xAI device code response is missing device_code, user_code, or verification_uri");
  }
  return {
    verificationUrl: body.verification_uri_complete ?? body.verification_uri,
    userCode: body.user_code,
    deviceCode: body.device_code,
    intervalSeconds: Number(body.interval ?? 5),
  };
}

export async function exchangeXaiDeviceCodeForTokens(
  opts: ExchangeXaiDeviceCodeOptions,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const issuer = issuerOf(opts);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = now();

  while (now() - started <= timeoutMs) {
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: opts.deviceCode.deviceCode,
      client_id: clientIdOf(opts),
    });
    const res = await fetchOf(opts)(`${issuer}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    const body = await res.json().catch(() => ({})) as TokenResponse;
    if (res.ok && body.access_token && body.refresh_token) {
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: parseAccessTokenExpiry(body.access_token, body.expires_in, now()),
      };
    }
    const error = body.error ?? "";
    if (error === "authorization_pending" || error === "slow_down" || res.status === 400 && !error) {
      const wait = error === "slow_down"
        ? Math.max(1, opts.deviceCode.intervalSeconds) + 5
        : Math.max(1, opts.deviceCode.intervalSeconds);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(`xAI device authorization failed (${res.status}): ${body.error_description ?? (error || await readError(res))}`);
  }

  throw new Error("xAI device authorization timed out");
}

export async function loginXaiWithDeviceCode(
  opts: LoginXaiWithDeviceCodeOptions,
): Promise<XaiAccountRecord> {
  const deviceCode = await requestXaiDeviceCode(opts);
  opts.onDeviceCode?.(deviceCode);
  const tokens = await exchangeXaiDeviceCodeForTokens({ ...opts, deviceCode });
  return createXaiAccountRecord({
    id: opts.accountId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });
}
