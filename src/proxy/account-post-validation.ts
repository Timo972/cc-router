import type { AccountRecord } from "./types.js";

export type ValidatedAccountPost =
  | { ok: true; body: AccountRecord & { replace: boolean } }
  | { ok: false; status: 400; error: string };

/**
 * Field validation for POST /cc-router/accounts, pulled out of the route so
 * the one behavioural exception is testable on its own: an Anthropic record
 * may omit `refreshToken` (a `claude setup-token` credential has none), every
 * other provider must send one.
 */
export function validateAccountPostBody(raw: unknown): ValidatedAccountPost {
  const body = (raw && typeof raw === "object" ? raw : {}) as Partial<AccountRecord> & { replace?: unknown };
  const isAnthropic = body.provider === undefined || body.provider === "anthropic_subscription";
  const required: (keyof AccountRecord)[] = isAnthropic
    ? ["id", "accessToken", "expiresAt"]
    : ["id", "accessToken", "refreshToken", "expiresAt"];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null || body[k] === "") {
      return { ok: false, status: 400, error: `Missing required field: ${k}` };
    }
  }
  if (typeof body.id !== "string" || typeof body.accessToken !== "string" || typeof body.expiresAt !== "number"
    || (body.refreshToken !== undefined && typeof body.refreshToken !== "string")) {
    return { ok: false, status: 400, error: "Invalid field types on account record" };
  }
  return { ok: true, body: { ...(body as AccountRecord), replace: body.replace === true } };
}
