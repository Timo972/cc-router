/**
 * Validate an OAuth access token against the Anthropic API.
 *
 * Uses GET /v1/models — lightweight call that doesn't create any resources.
 * Required header: anthropic-version (per API spec).
 * Auth: Authorization: Bearer <token> (OAuth tokens use Bearer, not x-api-key).
 */
import {
  classifyHttpSetupFailure,
  classifyNetworkSetupFailure,
  type SetupDiagnosticError,
} from "../telemetry/setup-diagnostics.js";

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string; diagnostic: SetupDiagnosticError };

export interface TokenValidationOptions {
  fetchImpl?: typeof fetch;
}

export async function validateToken(
  accessToken: string,
  options: TokenValidationOptions = {},
): Promise<ValidationResult> {
  try {
    const res = await (options.fetchImpl ?? fetch)("https://api.anthropic.com/v1/models", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
        // Required for api.anthropic.com to accept OAuth tokens (sk-ant-oat01-*)
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (res.ok) return { valid: true };

    const reason = res.status === 401
      ? "Token invalid or expired (401)"
      : res.status === 403
        ? "Token lacks required scopes (403) — needs user:inference"
        : `Unexpected HTTP ${res.status}`;
    return {
      valid: false,
      reason,
      diagnostic: classifyHttpSetupFailure("token_validation", res.status, reason),
    };
  } catch (err) {
    // Network error — can't validate, let user decide
    const reason = `Network error: ${err instanceof Error ? err.message : String(err)}`;
    return {
      valid: false,
      reason,
      diagnostic: classifyNetworkSetupFailure("token_validation", err, reason),
    };
  }
}
