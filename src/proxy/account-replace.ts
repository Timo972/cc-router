import type { TokenPool } from "./token-pool.js";
import type { Account, AccountRecord } from "./types.js";
import { reserveAccountForDeletion } from "./token-refresher.js";
import { createOpenAIAccount, type OpenAIAccount } from "../providers/openai/account-state.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

/**
 * Replacing an account's credentials in the live pool — what re-authenticating
 * an existing account id does.
 *
 * This exists because a terminally rejected refresh token has exactly one
 * recovery: install new credentials under the same id. Adding was previously
 * the only live write, and it refused an id already in the pool, so the OAuth
 * login the operator had just completed was discarded and its brand-new
 * refresh token lost. Replacement closes that path.
 *
 * Both transactions mutate the live array and persist, rolling the mutation
 * back if the write throws — the same shape as `addOpenAIAccountTransaction`.
 * Leaving the pool ahead of disk would let a later whole-pool write persist
 * credentials the operator never installed.
 */

export class AccountReplacementConflictError extends Error {
  constructor(id: string) {
    super(`Account "${id}" changed during replacement`);
    this.name = "AccountReplacementConflictError";
  }
}

export function accountReplacementStatusCode(error: unknown): 409 | 500 {
  return error instanceof AccountReplacementConflictError ? 409 : 500;
}

export interface ReplaceAnthropicAccountOptions {
  record: AccountRecord;
  pool: TokenPool;
  sessionRouter: { invalidateAccount(id: string): void };
  persist(accounts: Account[]): void;
  /** Seam for tests; production uses the refresher's deletion reservation. */
  reserve?(account: Account): Promise<() => void>;
}

/**
 * Swap new credentials in under an existing id.
 *
 * The reservation is the load-bearing part. A refresh already in flight holds
 * the *old* refresh token, and on success it writes the rotated result onto
 * its account object and persists the whole pool. Replacing without waiting
 * would let that completion land after the swap and put dead credentials back
 * over the ones just installed. `reserveAccountForDeletion` both waits for
 * that work and blocks new refreshes for the old object, so the window closes.
 */
export async function replaceAnthropicAccountTransaction(
  options: ReplaceAnthropicAccountOptions,
): Promise<Account> {
  const { id } = options.record;
  const previous = options.pool.findById(id);
  if (!previous) throw new Error(`Account "${id}" not found`);

  const release = await (options.reserve ?? reserveAccountForDeletion)(previous);
  try {
    // Re-check after the await: a concurrent delete or replace may have landed
    // while this one waited for the in-flight refresh to settle.
    if (options.pool.findById(id) !== previous) {
      throw new AccountReplacementConflictError(id);
    }

    // One pool operation rather than remove-then-add: the swap discards the
    // old incarnation's in-flight count and cooldowns (the replacement must
    // not inherit a bench it never earned) and hands back a rollback that
    // restores every bit of it if the write below fails.
    const { added, rollback } = options.pool.replaceAccount(options.record);
    try {
      options.persist(options.pool.getAll());
    } catch (error) {
      rollback();
      throw error;
    }

    // Only after the swap is durable: sticky sessions pinned to the dead
    // incarnation would otherwise keep routing at an object out of the pool.
    options.sessionRouter.invalidateAccount(id);
    return added;
  } finally {
    release();
  }
}

export interface ReplaceOpenAIAccountOptions<
  TAccount extends OpenAISubscriptionAccount = OpenAIAccount,
> {
  record: {
    id: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    enabled?: boolean;
    sessionLimitPercent?: number;
    weeklyLimitPercent?: number;
  };
  accounts: TAccount[];
  persist(accounts: TAccount[]): void;
  /** Drop the replaced account's pool-side routing state (cooldowns, counts). */
  forgetAccount?(account: TAccount): void;
  /** Discard sticky session bindings still pointing at the replaced account. */
  invalidateAccount?(id: string): void;
}

/**
 * OpenAI counterpart. No reservation is needed: refresh locks are keyed by
 * object identity, so a refresh still running against the replaced object
 * mutates an object no longer in the array — it cannot overwrite the new
 * credentials, and the whole-pool write it may trigger sees the new ones.
 */
export function replaceOpenAIAccountTransaction(
  options: ReplaceOpenAIAccountOptions,
): OpenAIAccount {
  const index = options.accounts.findIndex(candidate => candidate.id === options.record.id);
  if (index < 0) throw new Error(`Account "${options.record.id}" not found`);
  const previous = options.accounts[index]!;

  const account = createOpenAIAccount({
    id: options.record.id,
    provider: "openai_subscription",
    accessToken: options.record.accessToken,
    refreshToken: options.record.refreshToken,
    expiresAt: options.record.expiresAt,
    enabled: options.record.enabled !== false,
    ...(options.record.sessionLimitPercent !== undefined
      ? { sessionLimitPercent: options.record.sessionLimitPercent }
      : {}),
    ...(options.record.weeklyLimitPercent !== undefined
      ? { weeklyLimitPercent: options.record.weeklyLimitPercent }
      : {}),
  });

  // Splice in place so the replacement keeps the old account's position; the
  // array reference is the one the pool, router, and refresh loop all hold.
  options.accounts.splice(index, 1, account);
  try {
    options.persist(options.accounts);
  } catch (error) {
    options.accounts.splice(index, 1, previous);
    throw error;
  }

  options.forgetAccount?.(previous);
  options.invalidateAccount?.(options.record.id);
  return account;
}
