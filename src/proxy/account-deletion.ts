import type { SessionRouter } from "./session-router.js";
import type { TokenPool } from "./token-pool.js";
import type { Account } from "./types.js";

export interface DeleteAnthropicAccountOptions {
  id: string;
  pool: TokenPool;
  sessionRouter: SessionRouter;
  persist(accounts: Account[]): void;
}

/** Persist prospective state before irreversibly removing runtime routing state. */
export function deleteAnthropicAccountTransaction(
  options: DeleteAnthropicAccountOptions,
): Account {
  const account = options.pool.findById(options.id);
  if (!account) throw new Error(`Account "${options.id}" not found`);

  const prospective = options.pool.getAll().filter(candidate => candidate !== account);
  options.persist(prospective);

  if (!options.pool.removeAccount(options.id)) {
    throw new Error(`Account "${options.id}" disappeared during deletion`);
  }
  options.sessionRouter.invalidateAccount(options.id);
  return account;
}
