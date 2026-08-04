import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

export interface AddOpenAIAccountInput {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  enabled?: boolean;
}

export interface AddOpenAIAccountOptions {
  record: AddOpenAIAccountInput;
  /** The live array shared by the OpenAI picker and refresh loop — mutated in place. */
  accounts: OpenAISubscriptionAccount[];
  persist(accounts: OpenAISubscriptionAccount[]): void;
}

/**
 * Append an OpenAI subscription account to the running pool and persist it.
 *
 * The account is pushed IN PLACE so the picker (`createOpenAIAccountPicker`) and
 * the refresh loop — both of which close over the same array reference — pick it
 * up immediately without a restart, mirroring `TokenPool.addAccount` for Claude.
 * If persistence throws, the in-place append is rolled back so the live routing
 * state never diverges from disk.
 */
export function addOpenAIAccountTransaction(
  options: AddOpenAIAccountOptions,
): OpenAISubscriptionAccount {
  const account: OpenAISubscriptionAccount = {
    id: options.record.id,
    provider: "openai_subscription",
    accessToken: options.record.accessToken,
    refreshToken: options.record.refreshToken,
    expiresAt: options.record.expiresAt,
    enabled: options.record.enabled !== false,
  };

  options.accounts.push(account);
  try {
    options.persist(options.accounts);
  } catch (err) {
    const index = options.accounts.indexOf(account);
    if (index >= 0) options.accounts.splice(index, 1);
    throw err;
  }
  return account;
}
