import type { Account } from "../../proxy/types.js";
import { ResetNotSubmittedError, RESET_OUTCOME_UNKNOWN } from "../../proxy/reset-errors.js";
import { CLAUDE_CODE_USER_AGENT, OAUTH_BETA_HEADER } from "./usage.js";

export type ClaudeResetCode = "reset" | "already_used" | "not_limited" | "cooldown" | "ineligible" | "unavailable";
export interface ClaudeResetResult { code: ClaudeResetCode; resetsLeft?: number }

const CODES: readonly ClaudeResetCode[] = ["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"];
const ORG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function consumeClaudeLimitReset(
  account: Pick<Account, "tokens">,
  orgUuid: string,
  grantId: string,
  requestId: string,
  options: { fetch?: typeof globalThis.fetch } = {},
): Promise<ClaudeResetResult> {
  // Contract: Claude Code 2.1.280 `/limit-reset` (program "cedar_ember").
  // Undocumented; reverse-engineered from the CLI bundle on 2026-09-23.
  if (!ORG_UUID.test(orgUuid) || !GRANT_ID.test(grantId) || !REQUEST_ID.test(requestId)) {
    throw new ResetNotSubmittedError(503, "Reset request malformed; reset not submitted");
  }
  const request = options.fetch ?? globalThis.fetch;
  // Never retry a spend with a fresh ID: a lost response may have consumed it.
  try {
    const response = await request(`https://api.anthropic.com/api/organizations/${orgUuid}/reset_rate_limits`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${account.tokens.accessToken}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "user-agent": CLAUDE_CODE_USER_AGENT,
        "content-type": "application/json",
      },
      body: JSON.stringify({ program: "cedar_ember", grant_id: grantId, request_id: requestId }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) {
      throw new ResetNotSubmittedError(503, "Account credentials rejected; reset not submitted");
    }
    if (response.ok) {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "result" in body) {
        const code = (body as { result: unknown }).result;
        const left = (body as { resets_left?: unknown }).resets_left;
        if (CODES.includes(code as ClaudeResetCode)) {
          return {
            code: code as ClaudeResetCode,
            ...(typeof left === "number" && Number.isInteger(left) && left >= 0 ? { resetsLeft: left } : {}),
          };
        }
      }
    }
  } catch (error) {
    if (error instanceof ResetNotSubmittedError) throw error;
    // Do not relay upstream bodies, credentials, or network error details.
  }
  throw new Error(RESET_OUTCOME_UNKNOWN);
}
