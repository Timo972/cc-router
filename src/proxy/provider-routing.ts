export type ManagedProvider = "anthropic_subscription" | "openai_subscription";

export interface PersistProviderEnabledStateOptions<T> {
  provider: ManagedProvider;
  enabled: boolean;
  accountIds: Iterable<string>;
  persist(): T;
  invalidateAccount(accountId: string): unknown;
}

/**
 * Persist a provider toggle before discarding that provider's session
 * affinity. If persistence throws, the caller can roll back runtime
 * enablement without losing bindings that still point at valid accounts.
 *
 * Invalidation is provider-agnostic: the caller supplies the account ids and
 * the invalidator belonging to `provider`, so both the Anthropic and the
 * OpenAI router drop bindings when their provider is disabled.
 */
export function persistProviderEnabledState<T>(
  options: PersistProviderEnabledStateOptions<T>,
): T {
  const result = options.persist();

  if (!options.enabled) {
    for (const accountId of options.accountIds) {
      options.invalidateAccount(accountId);
    }
  }

  return result;
}
