/**
 * Terminal auth state, shared across providers.
 *
 * Each provider records "this credential is dead" differently — Anthropic
 * persists `authExpired` after an `invalid_grant`, OpenAI quarantines the
 * account and tags `authFailure: "permanent"` — but for an operator the two
 * mean one thing: the refresh loop has stopped retrying and only
 * re-authentication brings the account back. Keeping that equivalence in one
 * place is what stops a display or a health check from handling one provider
 * and silently missing the other.
 */
export interface TerminalAuthStateView {
  /** Anthropic: refresh token terminally rejected (`invalid_grant`). */
  authExpired?: boolean;
  /** OpenAI: whether the last auth failure can be retried. */
  authFailure?: string;
  /** OpenAI: whether the account is currently held out of rotation. */
  authState?: string;
}

/**
 * True when an account can only be restored by re-authenticating it.
 *
 * A bare quarantine is deliberately not enough: a transient rejection also
 * quarantines, and the next refresh tick can clear it on its own.
 */
export function needsReauthentication(account: TerminalAuthStateView): boolean {
  return account.authExpired === true || account.authFailure === "permanent";
}
