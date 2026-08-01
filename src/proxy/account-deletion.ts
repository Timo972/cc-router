import type { SessionRouter } from "./session-router.js";
import type { TokenPool } from "./token-pool.js";
import type { Account } from "./types.js";
import { reserveAccountForDeletion } from "./token-refresher.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

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

export interface DeleteOpenAIAccountOptions {
  id: string;
  accounts: OpenAISubscriptionAccount[];
  otherAccountCount: number;
  persist(accounts: OpenAISubscriptionAccount[]): void;
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

/** Persist prospective OpenAI state before removing it from the live picker array. */
export function deleteOpenAIAccountTransaction(
  options: DeleteOpenAIAccountOptions,
): OpenAISubscriptionAccount {
  const account = options.accounts.find(candidate => candidate.id === options.id);
  if (!account) throw new Error(`Account "${options.id}" not found`);
  if (options.accounts.length + options.otherAccountCount <= 1) {
    throw new LastAccountDeletionError();
  }

  const prospective = options.accounts.filter(candidate => candidate !== account);
  options.persist(prospective);

  const index = options.accounts.indexOf(account);
  if (index < 0) throw new AccountDeletionConflictError(options.id);
  options.accounts.splice(index, 1);
  return account;
}
