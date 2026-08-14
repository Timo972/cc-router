import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { Account } from "./types.js";

export interface ShutdownPersistenceDependencies {
  saveAnthropic: (accounts: Account[]) => void;
  saveOpenAI: (accounts: OpenAISubscriptionAccount[]) => void;
}

export interface ProxyExitDependencies {
  stopAccepting(): void;
  stopUsageRefresh(): void;
  removePid(): void;
  drainRefresh(): Promise<void>;
  persistAccounts(): void;
  shutdownTelemetry(): Promise<void>;
}

export interface ProxyExitCoordinator {
  finish(finalAction: () => void): Promise<void>;
}

/** Run bounded proxy quiescence once, then invoke the first requested exit action. */
export function createProxyExitCoordinator(
  dependencies: ProxyExitDependencies,
): ProxyExitCoordinator {
  let completion: Promise<void> | undefined;

  return {
    finish(finalAction) {
      if (completion) return completion;
      completion = (async () => {
        try { dependencies.stopAccepting(); } catch { /* best effort */ }
        try { dependencies.stopUsageRefresh(); } catch { /* best effort */ }
        try { dependencies.removePid(); } catch { /* best effort */ }
        try {
          await dependencies.drainRefresh();
        } catch {
          // Refresh drainage is bounded and never changes the exit path.
        }
        try { dependencies.persistAccounts(); } catch { /* best effort */ }
        try {
          await dependencies.shutdownTelemetry();
        } catch {
          // Telemetry shutdown never changes the exit path.
        }
        finalAction();
      })();
      return completion;
    },
  };
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
