import type { SessionRouter } from "./session-router.js";
import type { TokenPool } from "./token-pool.js";
import type { Account } from "./types.js";
import { reserveAccountForDeletion } from "./token-refresher.js";

export class AccountDeletionConflictError extends Error {
  constructor(id: string) {
    super(`Account "${id}" changed during deletion`);
    this.name = "AccountDeletionConflictError";
  }
}

export class LastAccountDeletionError extends Error {
  constructor() {
    super("Cannot remove the last account — at least one must remain");
    this.name = "LastAccountDeletionError";
  }
}

export function accountDeletionStatusCode(error: unknown): 409 | 500 {
  return error instanceof AccountDeletionConflictError ||
    error instanceof LastAccountDeletionError
    ? 409
    : 500;
}

export interface DeleteAnthropicAccountOptions {
  id: string;
  pool: TokenPool;
  sessionRouter: SessionRouter;
  persist(accounts: Account[]): void;
}

/** Persist prospective state before irreversibly removing runtime routing state. */
export async function deleteAnthropicAccountTransaction(
  options: DeleteAnthropicAccountOptions,
): Promise<Account> {
  const account = options.pool.findById(options.id);
  if (!account) throw new Error(`Account "${options.id}" not found`);

  const releaseReservation = await reserveAccountForDeletion(account);
  try {
    if (options.pool.findById(options.id) !== account) {
      throw new AccountDeletionConflictError(options.id);
    }
    if (options.pool.getAll().length <= 1) {
      throw new LastAccountDeletionError();
    }

    const prospective = options.pool.getAll().filter(candidate => candidate !== account);
    options.persist(prospective);

    if (!options.pool.removeAccount(options.id)) {
      throw new AccountDeletionConflictError(options.id);
    }
    options.sessionRouter.invalidateAccount(options.id);
    return account;
  } finally {
    releaseReservation();
  }
}
