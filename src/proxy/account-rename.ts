/**
 * Renaming an account changes the key that routing state hangs off: the
 * pool's in-flight counters and the session router's sticky bindings are
 * both id-keyed, so a rename is a transaction over pool + router + disk —
 * not a field write. Mirrors account-deletion.ts in shape: the provider
 * branches in server.ts supply their pool/router/persist as ports, and the
 * CLI shares the id rules from here.
 */

/**
 * An account id ends up in URL paths (`/cc-router/accounts/:id`), fixed-width
 * dashboard columns, and accounts.json — allow one conservative shape
 * everywhere: alphanumeric start, then dots/underscores/dashes, 64 max.
 */
const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_RE.test(value);
}

export class AccountRenameConflictError extends Error {
  constructor(id: string) {
    super(`An account named "${id}" already exists`);
    this.name = "AccountRenameConflictError";
  }
}

export interface RenameAccountPorts {
  /** Rename in the owning pool (id field + id-keyed load counters).
   *  Returns false when the pool has no account with `oldId`. */
  rename(oldId: string, newId: string): boolean;
  /** Re-point sticky session bindings at the new id. */
  renameSessions(oldId: string, newId: string): void;
  /** Persist the (already renamed) live state to disk. */
  persist(): void;
}

/**
 * Rename an account atomically with respect to disk: runtime state is only
 * left renamed if persistence succeeded, otherwise it is renamed back so
 * memory keeps matching accounts.json. `takenIds` must cover every live id
 * across ALL providers — the two pools share one id namespace (one URL
 * space, one accounts.json).
 */
export function renameAccountTransaction(
  oldId: string,
  newId: string,
  takenIds: ReadonlySet<string>,
  ports: RenameAccountPorts,
): "renamed" | "not_found" {
  if (newId === oldId) return "renamed";
  if (takenIds.has(newId)) throw new AccountRenameConflictError(newId);

  if (!ports.rename(oldId, newId)) return "not_found";
  ports.renameSessions(oldId, newId);
  try {
    ports.persist();
  } catch (error) {
    ports.rename(newId, oldId);
    ports.renameSessions(newId, oldId);
    throw error;
  }
  return "renamed";
}
