/** Credential-free coordination between accounts.json and the usage identity journal.
 * Import direction deliberately excludes config/manager and runtime. */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { UsageStore } from "./store.js";
import { boundedString, object, usageProvider, type UsageProvider } from "./types.js";

export interface AccountAlias { id: string; provider?: UsageProvider }
interface Transition {
  version: 1;
  before: AccountAlias[];
  after: AccountAlias[];
  /** Older transition files always came from an existing accounts.json. */
  previousFileExisted?: boolean;
  rename?: { oldId: string; newId: string };
}
const writers = new Map<string, { store: UsageStore; failed?: () => void }>();
const renameHints = new Map<string, { oldId: string; newId: string }>();
export function usageDirectoryForAccounts(accountsPath: string): string { return process.env.USAGE_DIR ?? join(dirname(accountsPath), "usage"); }
export function registerUsageWriter(directory: string, store: UsageStore, failed?: () => void): () => void {
  const key = resolve(directory); const owner = { store, failed };
  if (writers.has(key)) throw new Error("Usage writer already registered");
  writers.set(key, owner); return () => { if (writers.get(key) === owner) writers.delete(key); };
}
function aliases(records: readonly { id: string; provider?: string }[]): AccountAlias[] {
  return records.filter(r => r.provider !== "openai_api_key").map(r => ({ id: boundedString(r.id, "account alias", 128), provider: usageProvider(r.provider ?? "anthropic_subscription") })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
const equal = (a: readonly { id: string; provider?: string }[], b: readonly { id: string; provider?: string }[]) => JSON.stringify(aliases(a)) === JSON.stringify(aliases(b));
function syncDirectory(directory: string): void { if (process.platform === "win32") return; const fd = openSync(directory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function atomicPrivate(file: string, text: string): void {
  const tmp = `${file}.usage-tmp`; const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file); syncDirectory(dirname(file));
}
function clearTransition(directory: string): void { unlinkSync(join(directory, "account-transition.json")); syncDirectory(directory); }
function readTransition(directory: string): Transition | undefined {
  const file = join(directory, "account-transition.json"); if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8"); if (text.length > 4 * 1024 * 1024) throw new Error("Invalid account transition size");
  const raw = object(JSON.parse(text), ["version", "before", "after", "previousFileExisted", "rename"]);
  if (raw.version !== 1 || !Array.isArray(raw.before) || !Array.isArray(raw.after)) throw new Error("Invalid account transition");
  if (raw.previousFileExisted !== undefined && typeof raw.previousFileExisted !== "boolean") throw new Error("Invalid account transition");
  const parse = (list: unknown[]): AccountAlias[] => aliases(list.map(row => { const r = object(row, ["id", "provider"]); return { id: boundedString(r.id, "alias", 128), provider: usageProvider(r.provider) }; }));
  const result: Transition = {
    version: 1,
    before: parse(raw.before),
    after: parse(raw.after),
    ...(raw.previousFileExisted === false ? { previousFileExisted: false } : {}),
  };
  if (raw.rename !== undefined) { const r = object(raw.rename, ["oldId", "newId"]); result.rename = { oldId: boundedString(r.oldId, "old alias", 128), newId: boundedString(r.newId, "new alias", 128) }; }
  return result;
}
export function reconcileUsageAccounts(store: UsageStore, records: readonly AccountAlias[]): void {
  const current = aliases(records);
  for (const account of store.snapshot().accounts) {
    if (!account.retired && !current.some(r => r.id === account.alias && r.provider === account.provider)) store.retire(account.provider, account.alias);
  }
  for (const account of current) store.account(account.provider!, account.id);
}
function applyRename(store: UsageStore, transition: Transition, committed: boolean): void {
  if (!transition.rename) return;
  const { oldId, newId } = transition.rename;
  const source = transition.before.find(a => a.id === oldId);
  if (!source || !transition.after.some(a => a.id === newId && a.provider === source.provider)) throw new Error("Invalid rename transition");
  const from = committed ? oldId : newId; const to = committed ? newId : oldId;
  const accounts = store.snapshot().accounts;
  const old = accounts.find(a => !a.retired && a.provider === source.provider && a.alias === from);
  const next = accounts.find(a => !a.retired && a.provider === source.provider && a.alias === to);
  if (old && next && old.key !== next.key) throw new Error("Conflicting identity transition");
  if (old) store.rename(source.provider!, from, to);
  else if (!next) throw new Error("Missing identity for account transition");
}
export function recoverAccountTransition(store: UsageStore, directory: string, records: readonly AccountAlias[]): void {
  const transition = readTransition(directory); if (!transition) return;
  const committed = equal(records, transition.after);
  if (!committed && !equal(records, transition.before)) throw new Error("Account transition cannot be resolved against configured aliases");
  applyRename(store, transition, committed);
  reconcileUsageAccounts(store, records);
  clearTransition(directory);
}
/** Supply explicit rename intent: never infer identity from tokens, profiles, or one add+delete. */
export function withUsageRename<T>(accountsPath: string, oldId: string, newId: string, persist: () => T): T {
  const key = resolve(accountsPath); if (renameHints.has(key)) throw new Error("Account rename already in progress");
  renameHints.set(key, { oldId, newId }); try { return persist(); } finally { renameHints.delete(key); }
}
export function coordinateAccountWrite(accountsPath: string, previous: readonly { id: string; provider?: string }[], next: readonly { id: string; provider?: string }[], persist: () => void): void {
  const directory = usageDirectoryForAccounts(accountsPath);
  // Ordinary rotating-token writes have no identity effects and never depend on history availability.
  if (equal(previous, next) || !existsSync(directory)) { persist(); return; }
  const registered = writers.get(resolve(directory)); const store = registered?.store ?? UsageStore.open(directory);
  try {
    recoverAccountTransition(store, directory, aliases(previous));
    reconcileUsageAccounts(store, aliases(previous));
    const previousFileExisted = existsSync(accountsPath);
    const transition: Transition = {
      version: 1,
      before: aliases(previous),
      after: aliases(next),
      ...(previousFileExisted ? {} : { previousFileExisted: false }),
      ...(renameHints.has(resolve(accountsPath)) ? { rename: renameHints.get(resolve(accountsPath))! } : {}),
    };
    // Memory only. Credentials are never written into the transition sidecar.
    const previousText = previousFileExisted ? readFileSync(accountsPath, "utf8") : undefined;
    atomicPrivate(join(directory, "account-transition.json"), JSON.stringify(transition));
    try {
      applyRename(store, transition, true);
      persist();
    } catch (error) {
      // A writer can throw after publication (directory fsync). Restore credentials before the alias.
      try {
        if (existsSync(accountsPath) && equal(JSON.parse(readFileSync(accountsPath, "utf8")) as AccountAlias[], next)) {
          if (previousFileExisted) {
            atomicPrivate(accountsPath, previousText!);
          } else {
            unlinkSync(accountsPath);
            syncDirectory(dirname(accountsPath));
          }
        }
        if (store.snapshot().health.status !== "ok") throw new Error("Usage transition needs recovery");
        applyRename(store, transition, false);
        clearTransition(directory);
      } catch { registered?.failed?.(); /* Retain pending intent for deterministic restart recovery. */ }
      throw error;
    }
    // Credential publication is committed. Do not tell callers to roll their pools back if
    // retirement/addition fails: retain the pending record and expose unavailable history.
    try { reconcileUsageAccounts(store, aliases(next)); clearTransition(directory); }
    catch { registered?.failed?.(); }
  } finally { if (!registered) store.close(); }
}
