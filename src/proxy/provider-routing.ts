export type ManagedProvider = "anthropic_subscription" | "openai_subscription";

export interface PersistProviderEnabledStateOptions<T> {
  provider: ManagedProvider;
  enabled: boolean;
  accountIds: Iterable<string>;
  persist(): T;
  invalidateAccount(accountId: string): unknown;
}

/**
 * Persist a provider toggle before discarding any Anthropic affinity. If
 * persistence throws, the caller can roll back runtime enablement without
 * losing bindings that still point at valid accounts.
 */
export function persistProviderEnabledState<T>(
  options: PersistProviderEnabledStateOptions<T>,
): T {
  const result = options.persist();

  if (options.provider === "anthropic_subscription" && !options.enabled) {
    for (const accountId of options.accountIds) {
      options.invalidateAccount(accountId);
    }
  }

  return result;
}
