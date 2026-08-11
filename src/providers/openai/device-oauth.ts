import { createOpenAIAccountRecord, type OpenAIAccountRecord } from "./account-record.js";
import {
  SetupDiagnosticError,
  classifyHttpSetupFailure,
  classifyNetworkSetupFailure,
} from "../../telemetry/setup-diagnostics.js";
import type { SetupStage } from "../../telemetry/contracts.js";

const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_SCOPE = "openid profile email offline_access";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

type FetchImpl = typeof fetch;

export interface OpenAIDeviceCode {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalSeconds: number;
}

export interface OpenAIDeviceTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface OpenAIDeviceOAuthOptions {
  issuer?: string;
  clientId?: string;
  fetchImpl?: FetchImpl;
}

interface RequestDeviceCodeResponse {
  device_auth_id: string;
  user_code?: string;
  usercode?: string;
  interval?: string | number;
}

interface PollDeviceCodeResponse {
  authorization_code: string;
  code_challenge: string;
  code_verifier: string;
}

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
}

export interface ExchangeOpenAIDeviceCodeOptions extends OpenAIDeviceOAuthOptions {
  deviceCode: OpenAIDeviceCode;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
  onStageCompleted?: (stage: Extract<SetupStage,
    "authorization_polling" | "token_exchange" | "access_token_parse"
  >) => void;
}

export interface LoginOpenAIWithDeviceCodeOptions extends OpenAIDeviceOAuthOptions {
  accountId: string;
  onDeviceCode?: (code: OpenAIDeviceCode) => void;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
  onStageCompleted?: (stage: Extract<SetupStage,
    "device_code_request" | "authorization_polling" | "token_exchange" | "access_token_parse"
  >) => void;
}

function issuerOf(opts: OpenAIDeviceOAuthOptions): string {
  return (opts.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, "");
}

function clientIdOf(opts: OpenAIDeviceOAuthOptions): string {
  return opts.clientId ?? DEFAULT_CLIENT_ID;
}

function fetchOf(opts: OpenAIDeviceOAuthOptions): FetchImpl {
  return opts.fetchImpl ?? fetch;
}

function parseAccessTokenExpiry(accessToken: string): number {
  const [, payload] = accessToken.split(".");
  if (!payload) {
    throw new SetupDiagnosticError("OpenAI access token is not a JWT", {
      stage: "access_token_parse",
      reason: "unexpected_response_shape",
      expected: false,
    });
  }
  let claims: { exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { exp?: unknown };
  } catch (error) {
    throw new SetupDiagnosticError(`OpenAI access token JWT could not be parsed: ${(error as Error).message}`, {
      stage: "access_token_parse",
      reason: "unexpected_response_shape",
      expected: false,
    }, { cause: error });
  }
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new SetupDiagnosticError("OpenAI access token JWT does not contain a numeric exp claim", {
      stage: "access_token_parse",
      reason: "unexpected_response_shape",
      expected: true,
    });
  }
  return claims.exp * 1000;
}

async function readError(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export async function requestOpenAIDeviceCode(opts: OpenAIDeviceOAuthOptions = {}): Promise<OpenAIDeviceCode> {
  const issuer = issuerOf(opts);
  let res: Response;
  try {
    res = await fetchOf(opts)(`${issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientIdOf(opts) }),
    });
  } catch (error) {
    throw classifyNetworkSetupFailure("device_code_request", error);
  }

  if (!res.ok) {
    const detail = await readError(res);
    throw classifyHttpSetupFailure(
      "device_code_request",
      res.status,
      `OpenAI device code request failed (${res.status}): ${detail}`,
    );
  }

  let body: RequestDeviceCodeResponse;
  try {
    body = await res.json() as RequestDeviceCodeResponse;
  } catch (error) {
    throw new SetupDiagnosticError(`OpenAI device code response could not be parsed: ${(error as Error).message}`, {
      stage: "device_code_request",
      reason: "unexpected_response_shape",
      expected: false,
    }, { cause: error });
  }
  const userCode = body.user_code ?? body.usercode;
  const intervalSeconds = Number(body.interval ?? 5);
  if (typeof body.device_auth_id !== "string"
    || body.device_auth_id.length === 0
    || typeof userCode !== "string"
    || userCode.length === 0
    || !Number.isFinite(intervalSeconds)
    || intervalSeconds <= 0) {
    throw new SetupDiagnosticError("OpenAI device code response is missing device_auth_id or user_code", {
      stage: "device_code_request",
      reason: "unexpected_response_shape",
      expected: true,
    });
  }

  return {
    verificationUrl: `${issuer}/codex/device`,
    userCode,
    deviceAuthId: body.device_auth_id,
    intervalSeconds,
  };
}

async function pollAuthorizationCode(opts: ExchangeOpenAIDeviceCodeOptions): Promise<PollDeviceCodeResponse> {
  const issuer = issuerOf(opts);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = now();

  while (now() - started <= timeoutMs) {
    let res: Response;
    try {
      res = await fetchOf(opts)(`${issuer}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_auth_id: opts.deviceCode.deviceAuthId,
          user_code: opts.deviceCode.userCode,
        }),
      });
    } catch (error) {
      throw classifyNetworkSetupFailure("authorization_polling", error);
    }

    if (res.ok) {
      try {
        const body = await res.json() as PollDeviceCodeResponse;
        if (typeof body.authorization_code !== "string"
          || body.authorization_code.length === 0
          || typeof body.code_challenge !== "string"
          || body.code_challenge.length === 0
          || typeof body.code_verifier !== "string"
          || body.code_verifier.length === 0) {
          throw new SetupDiagnosticError("OpenAI authorization response is missing required fields", {
            stage: "authorization_polling",
            reason: "unexpected_response_shape",
            expected: true,
          });
        }
        return body;
      } catch (error) {
        if (error instanceof SetupDiagnosticError) throw error;
        throw new SetupDiagnosticError(`OpenAI authorization response could not be parsed: ${(error as Error).message}`, {
          stage: "authorization_polling",
          reason: "unexpected_response_shape",
          expected: false,
        }, { cause: error });
      }
    }
    if (res.status !== 403 && res.status !== 404) {
      const detail = await readError(res);
      throw classifyHttpSetupFailure(
        "authorization_polling",
        res.status,
        `OpenAI device authorization failed (${res.status}): ${detail}`,
      );
    }

    await sleep(Math.max(1, opts.deviceCode.intervalSeconds) * 1000);
  }

  throw new SetupDiagnosticError("OpenAI device authorization timed out", {
    stage: "authorization_polling",
    reason: "timeout",
    expected: true,
  });
}

export async function exchangeOpenAIDeviceCodeForTokens(
  opts: ExchangeOpenAIDeviceCodeOptions,
): Promise<OpenAIDeviceTokens> {
  const issuer = issuerOf(opts);
  const code = await pollAuthorizationCode(opts);
  opts.onStageCompleted?.("authorization_polling");
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: code.authorization_code,
    redirect_uri: `${issuer}/deviceauth/callback`,
    client_id: clientIdOf(opts),
    code_verifier: code.code_verifier,
  });

  let res: Response;
  try {
    res = await fetchOf(opts)(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (error) {
    throw classifyNetworkSetupFailure("token_exchange", error);
  }

  if (!res.ok) {
    const detail = await readError(res);
    throw classifyHttpSetupFailure(
      "token_exchange",
      res.status,
      `OpenAI token exchange failed (${res.status}): ${detail}`,
    );
  }

  let tokens: TokenResponse;
  try {
    tokens = await res.json() as TokenResponse;
  } catch (error) {
    throw new SetupDiagnosticError(`OpenAI token response could not be parsed: ${(error as Error).message}`, {
      stage: "token_exchange",
      reason: "unexpected_response_shape",
      expected: false,
    }, { cause: error });
  }
  if (typeof tokens.id_token !== "string" || tokens.id_token.length === 0
    || typeof tokens.access_token !== "string" || tokens.access_token.length === 0
    || typeof tokens.refresh_token !== "string" || tokens.refresh_token.length === 0) {
    throw new SetupDiagnosticError("OpenAI token response is missing required token fields", {
      stage: "token_exchange",
      reason: "unexpected_response_shape",
      expected: true,
    });
  }
  opts.onStageCompleted?.("token_exchange");
  const expiresAt = parseAccessTokenExpiry(tokens.access_token);
  opts.onStageCompleted?.("access_token_parse");
  return {
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
  };
}

export async function loginOpenAIWithDeviceCode(
  opts: LoginOpenAIWithDeviceCodeOptions,
): Promise<OpenAIAccountRecord> {
  const deviceCode = await requestOpenAIDeviceCode(opts);
  opts.onStageCompleted?.("device_code_request");
  opts.onDeviceCode?.(deviceCode);
  const tokens = await exchangeOpenAIDeviceCodeForTokens({ ...opts, deviceCode });
  return createOpenAIAccountRecord({
    id: opts.accountId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes: DEFAULT_SCOPE,
  });
}
