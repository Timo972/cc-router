import { createOpenAIAccount, type OpenAIAccount } from "../providers/openai/account-state.js";

export interface AddOpenAIAccountInput {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  enabled?: boolean;
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
}

export interface AddOpenAIAccountOptions {
  record: AddOpenAIAccountInput;
  /** The live array shared by the OpenAI pool/router and refresh loop — mutated in place. */
  accounts: OpenAIAccount[];
  persist(accounts: OpenAIAccount[]): void;
}

/**
 * Append an OpenAI subscription account to the running pool and persist it.
 *
 * The account is pushed IN PLACE (as a full runtime `OpenAIAccount`, so the
 * `OpenAITokenPool`/`SessionRouter` — which close over the same array
 * reference — can route to it immediately without a restart, mirroring
 * `TokenPool.addAccount` for Claude. If persistence throws, the in-place
 * append is rolled back so the live routing state never diverges from disk.
 */
export function addOpenAIAccountTransaction(
  options: AddOpenAIAccountOptions,
): OpenAIAccount {
  const account = createOpenAIAccount({
    id: options.record.id,
    provider: "openai_subscription",
    accessToken: options.record.accessToken,
    refreshToken: options.record.refreshToken,
    expiresAt: options.record.expiresAt,
    enabled: options.record.enabled !== false,
    sessionLimitPercent: options.record.sessionLimitPercent,
    weeklyLimitPercent: options.record.weeklyLimitPercent,
  });

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
