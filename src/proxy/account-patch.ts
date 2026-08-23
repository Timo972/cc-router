import type { OpenAIAccount } from "../providers/openai/account-state.js";
import { isValidAccountId } from "./account-rename.js";
import { clampPercent } from "./types.js";

export interface AccountPatch {
  /** New id for the account — a rename. Exclusive with every other field:
   *  a rename re-keys routing state (see account-rename.ts) and runs as its
   *  own transaction, not as a field write. */
  id?: string;
  enabled?: boolean;
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
}

export type AccountPatchValidation =
  | { ok: true; patch: AccountPatch }
  | { ok: false; error: string };

/**
 * Validate a `PATCH /cc-router/accounts/:id` request body. Shared between the
 * Anthropic and OpenAI account branches in server.ts so both providers reject
 * a malformed `enabled`/`sessionLimitPercent`/`weeklyLimitPercent` the same
 * way, before either pool is even consulted.
 */
export function validateAccountPatchBody(body: {
  id?: unknown;
  enabled?: unknown;
  sessionLimitPercent?: unknown;
  weeklyLimitPercent?: unknown;
}): AccountPatchValidation {
  const patch: AccountPatch = {};
  if (body.id !== undefined) {
    if (!isValidAccountId(body.id)) {
      return { ok: false, error: "id must be 1-64 characters: alphanumeric start, then letters, digits, dots, underscores, or dashes" };
    }
    if (body.enabled !== undefined || body.sessionLimitPercent !== undefined || body.weeklyLimitPercent !== undefined) {
      return { ok: false, error: "id (rename) cannot be combined with other fields" };
    }
    patch.id = body.id;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return { ok: false, error: "enabled must be boolean" };
    }
    patch.enabled = body.enabled;
  }
  for (const key of ["sessionLimitPercent", "weeklyLimitPercent"] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
      return { ok: false, error: `${key} must be a number between 0 and 100` };
    }
    patch[key] = v;
  }
  return { ok: true, patch };
}

export interface ApplyOpenAIAccountPatchOptions {
  id: string;
  patch: AccountPatch;
  /** The live array shared by the OpenAI pool/router and refresh loop — mutated in place. */
  accounts: OpenAIAccount[];
  persist(accounts: OpenAIAccount[]): void;
}

/**
 * Apply an already-validated patch to a runtime OpenAI account in place and
 * persist it — the OpenAI counterpart of `TokenPool.updateAccount` for
 * Claude, which `OpenAITokenPool` has no equivalent of.
 *
 * Returns the updated account, or `undefined` if no account with that id
 * exists in `accounts` (the caller should respond 404). On persistence
 * failure the in-memory mutation is rolled back before the error is
 * re-thrown, mirroring `addOpenAIAccountTransaction`'s rollback contract.
 */
export function applyOpenAIAccountPatch(
  options: ApplyOpenAIAccountPatchOptions,
): OpenAIAccount | undefined {
  const account = options.accounts.find(a => a.id === options.id);
  if (!account) return undefined;

  const prev = {
    enabled: account.enabled,
    sessionLimitPercent: account.sessionLimitPercent,
    weeklyLimitPercent: account.weeklyLimitPercent,
  };

  if (options.patch.enabled !== undefined) account.enabled = options.patch.enabled;
  if (options.patch.sessionLimitPercent !== undefined) {
    account.sessionLimitPercent = clampPercent(options.patch.sessionLimitPercent);
  }
  if (options.patch.weeklyLimitPercent !== undefined) {
    account.weeklyLimitPercent = clampPercent(options.patch.weeklyLimitPercent);
  }

  try {
    options.persist(options.accounts);
  } catch (err) {
    account.enabled = prev.enabled;
    account.sessionLimitPercent = prev.sessionLimitPercent;
    account.weeklyLimitPercent = prev.weeklyLimitPercent;
    throw err;
  }
  return account;
}
