import type { AccountRecord } from "../../proxy/types.js";
import { SetupDiagnosticError } from "../../telemetry/setup-diagnostics.js";

export type OpenAIAccountRecord = AccountRecord & {
  provider: "openai_subscription";
  enabled: boolean;
};

export interface CreateOpenAIAccountRecordInput {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string | number;
  scopes?: string[] | string;
  enabled?: boolean;
}

function parseExpiresAt(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SetupDiagnosticError("expiresAt must be a positive Unix timestamp in milliseconds", {
      stage: "credential_parse",
      reason: "malformed_credentials",
      expected: true,
    });
  }
  return parsed;
}

function parseScopes(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return ["openid", "profile", "email", "offline_access"];
}

export function createOpenAIAccountRecord(input: CreateOpenAIAccountRecordInput): OpenAIAccountRecord {
  const id = input.id.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new SetupDiagnosticError("Only letters, numbers, _ and - allowed in account ID", {
      stage: "credential_parse",
      reason: "malformed_credentials",
      expected: true,
    });
  }
  if (!input.accessToken.trim()) {
    throw new SetupDiagnosticError("Access token is required", {
      stage: "credential_parse",
      reason: "invalid_token",
      expected: true,
    });
  }
  if (!input.refreshToken.trim()) {
    throw new SetupDiagnosticError("Refresh token is required", {
      stage: "credential_parse",
      reason: "invalid_token",
      expected: true,
    });
  }

  return {
    id,
    provider: "openai_subscription",
    accessToken: input.accessToken.trim(),
    refreshToken: input.refreshToken.trim(),
    expiresAt: parseExpiresAt(input.expiresAt),
    scopes: parseScopes(input.scopes),
    enabled: input.enabled ?? true,
  };
}
