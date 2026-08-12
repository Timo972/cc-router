import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { Account } from "./types.js";

export interface ShutdownPersistenceDependencies {
  saveAnthropic: (accounts: Account[]) => void;
  saveOpenAI: (accounts: OpenAISubscriptionAccount[]) => void;
}

/** Best-effort final saves are isolated so one provider cannot skip the other. */
export function saveProviderAccountsOnShutdown(
  anthropicAccounts: Account[],
  openAIAccounts: OpenAISubscriptionAccount[],
  dependencies: ShutdownPersistenceDependencies,
): void {
  try {
    dependencies.saveAnthropic(anthropicAccounts);
  } catch {
    // Preserve shutdown behavior while still attempting the other provider.
  }
  try {
    dependencies.saveOpenAI(openAIAccounts);
  } catch {
    // Final persistence remains best effort.
  }
}
