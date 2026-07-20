import type { SessionRouter } from "./session-router.js";
import type { TokenPool } from "./token-pool.js";
import type { Account } from "./types.js";
import { waitForAccountRefresh } from "./token-refresher.js";

export class LastAccountDeletionError extends Error {
  constructor() {
    super("Cannot remove the last account — at least one must remain");
    this.name = "LastAccountDeletionError";
  }
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

  await waitForAccountRefresh(account);
  if (options.pool.findById(options.id) !== account) {
    throw new Error(`Account "${options.id}" changed during deletion`);
  }
  if (options.pool.getAll().length <= 1) {
    throw new LastAccountDeletionError();
  }

  const prospective = options.pool.getAll().filter(candidate => candidate !== account);
  options.persist(prospective);

  if (!options.pool.removeAccount(options.id)) {
    throw new Error(`Account "${options.id}" disappeared during deletion`);
  }
  options.sessionRouter.invalidateAccount(options.id);
  return account;
}
