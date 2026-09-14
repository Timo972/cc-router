import type { AccountRecord } from "../../proxy/types.js";

export const XAI_PROVIDER = "xai_subscription" as const;
export const XAI_DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
];

export type XaiAccountRecord = AccountRecord & {
  provider: typeof XAI_PROVIDER;
  enabled: boolean;
};

export interface CreateXaiAccountRecordInput {
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
    throw new Error("expiresAt must be a positive Unix timestamp in milliseconds");
  }
  return parsed;
}

function parseScopes(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [...XAI_DEFAULT_SCOPES];
}

export function createXaiAccountRecord(input: CreateXaiAccountRecordInput): XaiAccountRecord {
  const id = input.id.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("Only letters, numbers, _ and - allowed in account ID");
  }
  if (!input.accessToken.trim()) throw new Error("Access token is required");
  if (!input.refreshToken.trim()) throw new Error("Refresh token is required");

  return {
    id,
    provider: XAI_PROVIDER,
    accessToken: input.accessToken.trim(),
    refreshToken: input.refreshToken.trim(),
    expiresAt: parseExpiresAt(input.expiresAt),
    scopes: parseScopes(input.scopes),
    enabled: input.enabled ?? true,
  };
}
