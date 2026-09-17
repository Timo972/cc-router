import * as fs from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { addTokens, boundedString, object, TOKEN_KEYS, utcTimestamp, usageProvider, validateAccount, validateObservation, validateRates, validateTokens, zeroTokens } from "./types.js";
import type { Subscription, UsageAccount, UsageAggregate, UsageDelta, UsageObservation, UsageProvider, UsageSnapshot, UsageGap } from "./types.js";
import { endSubscription, setSubscription, validateSubscriptions } from "./subscriptions.js";

const MAX_RECORD_BYTES = 64 * 1024;
interface CompletedAttempt { attemptId: string; revision: number; fingerprint: string }
interface State extends UsageSnapshot { completedAttempts: CompletedAttempt[] }
interface Indexes {
  accounts: Map<string, number>;
  aliases: Map<string, number>;
  observations: Map<string, number>;
  completed: Map<string, CompletedAttempt>;
}
const stateIndexes = new WeakMap<State, Indexes>();
function aliasKey(provider: UsageProvider, alias: string): string { return JSON.stringify([provider, alias]); }
function indexes(state: State): Indexes {
  let result = stateIndexes.get(state);
  if (!result) {
    result = {
      accounts: new Map(state.accounts.map((entry, i) => [entry.key, i])),
      aliases: new Map(state.accounts.flatMap((entry, i) => entry.retired ? [] : [[aliasKey(entry.provider, entry.alias), i] as [string, number]])),
      observations: new Map(state.observations.map((entry, i) => [entry.attemptId, i])),
      completed: new Map(state.completedAttempts.map(entry => [entry.attemptId, entry])),
    };
    stateIndexes.set(state, result);
  }
  return result;
}
interface Manifest { version: 1; state: string; journal: string }
type RecordEntry = { version: 1; type: "observation"; observation: UsageObservation }
  | { version: 1; type: "account"; account: UsageAccount }
  | { version: 1; type: "warning"; warning: string }
  | { version: 1; type: "gap"; gap: UsageGap };

function empty(): State {
  return { version: 1, gaps: [], observations: [], deltas: [], aggregates: [], accounts: [], subscriptions: [], warnings: [], health: { status: "ok", warnings: [] }, completedAttempts: [] };
}
function warn(state: State, message: string): void {
  if (!state.warnings.includes(message)) state.warnings.push(message);
}
function validateGap(value: unknown): UsageGap {
  const input = object(value, ["id", "start", "end", "reason", "provider"]);
  const gap: UsageGap = { id: boundedString(input.id, "gap ID", 128), start: utcTimestamp(input.start), reason: boundedString(input.reason, "gap reason", 512) };
  if (input.provider !== undefined) gap.provider = usageProvider(input.provider);
  if (input.end !== undefined) { gap.end = utcTimestamp(input.end); if (gap.end < gap.start) throw new Error("Invalid collection gap interval"); }
  return gap;
}
function addGap(state: State, gap: UsageGap): void {
  state.gaps ??= [];
  const index = state.gaps.findIndex(entry => entry.id === gap.id);
  if (index < 0) state.gaps.push(gap); else if (!state.gaps[index].end) state.gaps[index] = gap;
  if (!gap.provider) warn(state, gap.reason);
  const open = state.gaps.filter(entry => !entry.end);
  state.health = { status: open.length ? "degraded" : "ok", warnings: [...new Set(open.map(entry => entry.reason))] };
}
function tailGapStart(state: State): string {
  let last = Date.parse(state.trackingSince ?? new Date().toISOString());
  for (const entry of state.observations) last = Math.max(last, Date.parse(entry.ts));
  for (const entry of state.aggregates) last = Math.max(last, Date.parse(entry.start));
  return new Date(Math.min(last, Date.now())).toISOString();
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error("Corrupt usage JSON"); }
}
function fingerprint(value: UsageObservation): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function syncDirectory(directory: string): void {
  if (process.platform === "win32") return; // Windows does not expose POSIX directory fsync.
  const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function createFile(path: string, content: string): void {
  const fd = fs.openSync(path, "wx", 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function atomicWrite(directory: string, name: string, value: unknown): void {
  const temp = join(directory, `.${name}.${randomUUID()}.tmp`);
  try { createFile(temp, JSON.stringify(value) + "\n"); fs.renameSync(temp, join(directory, name)); syncDirectory(directory); }
  finally { try { fs.unlinkSync(temp); } catch (error) { if (!isMissing(error)) throw error; } }
}

/** Each contender owns a unique claim before scanning: two simultaneous contenders
 * can both lose, but cannot both win. Dead claims never reuse a pathname, avoiding
 * the stale-lock unlink race that can remove a newly acquired writer's lock. */
function acquire(directory: string): { claim: string; deadClaims: string[] } {
  const host = Buffer.from(hostname()).toString("hex");
  const name = `writer.${host}.${process.pid}.${randomUUID()}.lock`;
  const claim = join(directory, name); fs.mkdirSync(claim, { mode: 0o700 });
  const deadClaims: string[] = [];
  try {
    for (const entry of fs.readdirSync(directory)) {
      if (entry === name || !entry.startsWith("writer.") || !entry.endsWith(".lock")) continue;
      const match = /^writer\.([a-f0-9]+)\.(\d+)\.[a-zA-Z0-9-]+\.lock$/.exec(entry);
      if (!match || match[1] !== host || !Number.isSafeInteger(+match[2]) || +match[2] <= 0) throw new Error("Usage store locked by another writer (unknown host/owner)");
      let dead = false;
      try { process.kill(+match[2], 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      if (!dead) throw new Error("Usage store locked by another writer");
      deadClaims.push(join(directory, entry));
    }
    return { claim, deadClaims };
  } catch (error) { fs.rmdirSync(claim); throw error; }
}

function manifestFrom(text: string): Manifest {
  const input = object(parse(text), ["version", "state", "journal"]);
  if (input.version !== 1 || typeof input.state !== "string" || typeof input.journal !== "string" || !/^state-[a-f0-9-]+\.json$/.test(input.state) || !/^journal-[a-f0-9-]+\.jsonl$/.test(input.journal)) throw new Error("Invalid usage manifest");
  return input as unknown as Manifest;
}
function accountFor(state: State, accountKey: string, provider: UsageProvider): UsageAccount {
  const index = indexes(state).accounts.get(accountKey);
  const account = index === undefined ? undefined : state.accounts[index];
  if (!account || account.provider !== provider) throw new Error("Invalid usage account reference");
  return account;
}
function ledgerEntry(value: unknown, aggregate: boolean): UsageDelta | UsageAggregate {
  const common = ["accountKey", "provider", "model", "tokens", "rates"];
  const input = object(value, aggregate ? [...common, "start", "end"] : [...common, "attemptId", "ts"]);
  const rates = validateRates(input.rates);
  const entry = { accountKey: boundedString(input.accountKey, "account key", 128), provider: usageProvider(input.provider), model: boundedString(input.model, "model"), tokens: validateTokens(input.tokens), ...(rates ? { rates } : {}) };
  if (!aggregate) return { ...entry, attemptId: boundedString(input.attemptId, "attempt ID", 128), ts: utcTimestamp(input.ts) };
  const start = utcTimestamp(input.start); const end = utcTimestamp(input.end);
  if (Date.parse(start) % 3600000 || Date.parse(end) - Date.parse(start) !== 3600000) throw new Error("Invalid hourly aggregate");
  return { ...entry, start, end };
}
function validateState(value: unknown): State {
  const input = object(value, ["version", "trackingSince", "observations", "deltas", "aggregates", "accounts", "subscriptions", "warnings", "health", "completedAttempts", "gaps"]);
  if (input.version !== 1) throw new Error("Invalid usage state version");
  const state = empty();
  if (input.trackingSince !== undefined) state.trackingSince = utcTimestamp(input.trackingSince);
  for (const name of ["accounts", "observations", "deltas", "aggregates", "warnings", "completedAttempts"] as const) if (!Array.isArray(input[name])) throw new Error(`Invalid usage state ${name}`);
  state.accounts = (input.accounts as unknown[]).map(validateAccount);
  const keys = new Set<string>(); const aliases = new Set<string>();
  for (const account of state.accounts) {
    const alias = JSON.stringify([account.provider, account.alias]);
    if (keys.has(account.key) || (!account.retired && aliases.has(alias))) throw new Error("Invalid duplicate usage account");
    keys.add(account.key); if (!account.retired) aliases.add(alias);
  }
  state.observations = (input.observations as unknown[]).map(validateObservation);
  state.deltas = (input.deltas as unknown[]).map(entry => ledgerEntry(entry, false) as UsageDelta);
  state.aggregates = (input.aggregates as unknown[]).map(entry => ledgerEntry(entry, true) as UsageAggregate);
  const attempts = new Set<string>();
  for (const observation of state.observations) { if (attempts.has(observation.attemptId)) throw new Error("Invalid duplicate attempt"); attempts.add(observation.attemptId); }
  for (const entry of [...state.observations, ...state.deltas, ...state.aggregates]) accountFor(state, entry.accountKey, entry.provider);
  const observations = new Map(state.observations.map(entry => [entry.attemptId, entry]));
  const sums = new Map<string, ReturnType<typeof zeroTokens>>();
  for (const delta of state.deltas) {
    const observation = observations.get(delta.attemptId);
    if (!observation || observation.accountKey !== delta.accountKey || observation.provider !== delta.provider || observation.model !== delta.model || JSON.stringify(observation.rates) !== JSON.stringify(delta.rates) || delta.ts > observation.ts) throw new Error("Invalid delta identity");
    const sum = sums.get(delta.attemptId) ?? zeroTokens(); addTokens(sum, delta.tokens); sums.set(delta.attemptId, sum);
  }
  for (const observation of state.observations) {
    const sum = sums.get(observation.attemptId) ?? zeroTokens();
    if (TOKEN_KEYS.some(key => sum[key] !== observation.tokens[key])) throw new Error("Invalid cumulative delta totals");
  }
  state.completedAttempts = (input.completedAttempts as unknown[]).map(entry => {
    const record = object(entry, ["attemptId", "revision", "fingerprint"]);
    const attemptId = boundedString(record.attemptId, "attempt ID", 128);
    if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1 || typeof record.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.fingerprint) || attempts.has(attemptId)) throw new Error("Invalid completed attempt");
    attempts.add(attemptId); return { attemptId, revision: record.revision as number, fingerprint: record.fingerprint };
  });
  state.subscriptions = validateSubscriptions(input.subscriptions);
  for (const entry of state.subscriptions) accountFor(state, entry.accountKey, entry.provider);
  for (const warning of input.warnings as unknown[]) warn(state, boundedString(warning, "storage warning", 512));
  const health = object(input.health, ["status", "warnings"]);
  if (!["ok", "degraded"].includes(health.status as string) || !Array.isArray(health.warnings)) throw new Error("Invalid usage health");
  if (input.gaps !== undefined) {
    if (!Array.isArray(input.gaps)) throw new Error("Invalid collection gap list");
    for (const gap of input.gaps) addGap(state, validateGap(gap));
  }
  for (const warning of health.warnings) boundedString(warning, "health warning", 512);
  if (health.status === "degraded" && state.health.status !== "degraded") throw new Error("Invalid degraded health without an open collection gap");
  stateIndexes.delete(state);
  return state;
}
function applyObservation(state: State, observation: UsageObservation, commit = true): boolean {
  accountFor(state, observation.accountKey, observation.provider);
  const idx = indexes(state);
  const terminal = idx.completed.get(observation.attemptId);
  if (terminal) {
    if (observation.revision > terminal.revision) throw new Error("Attempt is already complete");
    if (observation.revision === terminal.revision && fingerprint(observation) !== terminal.fingerprint) throw new Error("Conflicting completed revision");
    return false;
  }
  const index = idx.observations.get(observation.attemptId) ?? -1;
  const prior = state.observations[index];
  if (prior) {
    if (prior.accountKey !== observation.accountKey || prior.provider !== observation.provider || prior.model !== observation.model) throw new Error("Attempt identity is immutable");
    if (JSON.stringify(prior.rates) !== JSON.stringify(observation.rates)) throw new Error("Attempt rates are immutable");
    if (observation.revision < prior.revision) return false;
    if (observation.revision === prior.revision) {
      if (fingerprint(prior) !== fingerprint(observation)) throw new Error("Conflicting observation revision");
      return false;
    }
    if (prior.complete || prior.settled) throw new Error("Attempt is already complete or settled");
    if (observation.ts < prior.ts) throw new Error("Observation timestamp cannot decrease");
  }
  const tokens = zeroTokens();
  for (const key of TOKEN_KEYS) {
    tokens[key] = observation.tokens[key] - (prior?.tokens[key] ?? 0);
    if (tokens[key] < 0) throw new Error("Cumulative token counts cannot decrease");
  }
  if (tokens.cacheWrite5m + tokens.cacheWrite1h > tokens.cacheWrite) throw new Error("Cumulative unknown cache-write remainder cannot decrease");
  if (!commit) return true;
  if (index < 0) { idx.observations.set(observation.attemptId, state.observations.length); state.observations.push(observation); }
  else state.observations[index] = observation;
  state.deltas.push({ attemptId: observation.attemptId, ts: observation.ts, accountKey: observation.accountKey, provider: observation.provider, model: observation.model, tokens, ...(observation.rates ? { rates: observation.rates } : {}) });
  return true;
}
function applyRecord(state: State, value: unknown, commit = true): void {
  const input = object(value, ["version", "type", "observation", "account", "warning", "gap"]);
  if (input.version !== 1) throw new Error("Invalid usage record version");
  switch (input.type) {
    case "observation": object(input, ["version", "type", "observation"]); applyObservation(state, validateObservation(input.observation), commit); break;
    case "account": {
      object(input, ["version", "type", "account"]); const account = validateAccount(input.account);
      const idx = indexes(state); const index = idx.accounts.get(account.key) ?? -1;
      const alias = aliasKey(account.provider, account.alias); const occupied = idx.aliases.get(alias);
      if (!account.retired && occupied !== undefined && occupied !== index) throw new Error("Duplicate active usage alias");
      if (index >= 0 && (state.accounts[index].provider !== account.provider || state.accounts[index].retired)) throw new Error("Invalid account lifecycle");
      if (!commit) break;
      if (index < 0) { idx.accounts.set(account.key, state.accounts.length); if (!account.retired) idx.aliases.set(alias, state.accounts.length); state.accounts.push(account); }
      else {
        idx.aliases.delete(aliasKey(state.accounts[index].provider, state.accounts[index].alias));
        if (!account.retired) idx.aliases.set(alias, index);
        state.accounts[index] = account;
      }
      break;
    }
    case "warning": object(input, ["version", "type", "warning"]); boundedString(input.warning, "warning", 512); if (commit) warn(state, input.warning as string); break;
    case "gap": object(input, ["version", "type", "gap"]); { const gap = validateGap(input.gap); if (commit) addGap(state, gap); } break;
    default: throw new Error("Invalid usage record type");
  }
}

/** Bootstrap is a separate transaction: no observation can be accepted until its
 * marker has been retired. Thus only an empty unpublished generation is recoverable. */
function finishInitialization(directory: string, manifest: Manifest, initialState?: State): void {
  const files = fs.readdirSync(directory);
  if (files.some(name => /^(state-|journal-)/.test(name) && name !== manifest.state && name !== manifest.journal)) throw new Error("Unexpected history beside usage initialization");
  const statePath = join(directory, manifest.state);
  if (fs.existsSync(statePath)) {
    const state = validateState(parse(fs.readFileSync(statePath, "utf8")));
    if (state.observations.length || state.deltas.length || state.aggregates.length || state.accounts.length || state.subscriptions.length || state.completedAttempts.length) throw new Error("Refusing to overwrite nonempty usage initialization");
  } else {
    const state = initialState ?? empty(); state.trackingSince ??= new Date().toISOString();
    atomicWrite(directory, manifest.state, state);
  }
  const journalPath = join(directory, manifest.journal);
  if (fs.existsSync(journalPath)) {
    if (fs.statSync(journalPath).size !== 0) throw new Error("Refusing to overwrite initialized usage journal");
  } else createFile(journalPath, "");
  const subscriptionPath = join(directory, "subscriptions.json");
  if (fs.existsSync(subscriptionPath)) {
    const raw = object(parse(fs.readFileSync(subscriptionPath, "utf8")), ["version", "subscriptions"]);
    if (raw.version !== 1 || validateSubscriptions(raw.subscriptions).length) throw new Error("Refusing to overwrite initialized subscriptions");
  } else atomicWrite(directory, "subscriptions.json", { version: 1, subscriptions: [] });
  atomicWrite(directory, "manifest.json", manifest);
}

interface Loaded { state: State; manifest?: Manifest; tornBytes?: number }
function load(directory: string): Loaded {
  for (let retry = 0; retry < 5; retry++) {
    let manifestText: string;
    try { manifestText = fs.readFileSync(join(directory, "manifest.json"), "utf8"); }
    catch (error) {
      if (!isMissing(error)) throw error;
      let entries: string[] = []; try { entries = fs.readdirSync(directory); } catch (e) { if (!isMissing(e)) throw e; }
      if (entries.some(entry => /^(state-|journal-|subscriptions\.json)/.test(entry))) throw new Error("Corrupt usage store: manifest missing; existing history will not be overwritten");
      return { state: empty() };
    }
    try {
      const manifest = manifestFrom(manifestText);
      const state = validateState(parse(fs.readFileSync(join(directory, manifest.state), "utf8")));
      const journal = fs.readFileSync(join(directory, manifest.journal));
      const lastNewline = journal.lastIndexOf(10); const complete = journal.subarray(0, lastNewline + 1);
      if (journal.length - complete.length > MAX_RECORD_BYTES) throw new Error("Oversized unterminated usage record");
      if (!Buffer.from(complete.toString("utf8")).equals(complete)) throw new Error("Corrupt usage journal encoding");
      const text = complete.toString("utf8");
      for (const line of text ? text.slice(0, -1).split("\n") : []) {
        if (!line || Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new Error("Corrupt or oversized usage record");
        applyRecord(state, parse(line));
      }
      let subscriptionsText: string | undefined;
      try { subscriptionsText = fs.readFileSync(join(directory, "subscriptions.json"), "utf8"); } catch (error) { if (isMissing(error)) throw new Error("Corrupt usage store: subscription configuration missing"); throw error; }
      if (subscriptionsText !== undefined) {
        const data = object(parse(subscriptionsText), ["version", "subscriptions"]);
        if (data.version !== 1) throw new Error("Invalid subscription file version");
        state.subscriptions = validateSubscriptions(data.subscriptions);
      }
      if (fs.readFileSync(join(directory, "manifest.json"), "utf8") !== manifestText || fs.statSync(join(directory, manifest.journal)).size !== journal.length) continue;
      let latestSubscriptions: string | undefined;
      try { latestSubscriptions = fs.readFileSync(join(directory, "subscriptions.json"), "utf8"); } catch (error) { if (!isMissing(error)) throw error; }
      if (latestSubscriptions !== subscriptionsText) continue;
      for (const subscription of state.subscriptions) accountFor(state, subscription.accountKey, subscription.provider);
      const tornBytes = journal.length > complete.length ? complete.length : undefined;
      if (tornBytes !== undefined) addGap(state, { id: `torn-${manifest.journal}-${complete.length}`, start: tailGapStart(state), reason: "Torn journal tail: last observation may be lost; history is incomplete." });
      for (const entry of fs.readdirSync(directory)) {
        if (/^gap-[a-f0-9-]+$/.test(entry)) {
          const start = new Date(fs.statSync(join(directory, entry)).mtimeMs).toISOString();
          addGap(state, { id: entry, start, reason: "Usage persistence failure may have lost observations." });
        }
        const match = /^writer\.([a-f0-9]+)\.(\d+)\.[a-zA-Z0-9-]+\.lock$/.exec(entry);
        if (match && match[1] === Buffer.from(hostname()).toString("hex")) {
          try { process.kill(+match[2], 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") addGap(state, { id: `dead-${entry.split(".")[3]}`, start: new Date(fs.statSync(join(directory, entry)).mtimeMs).toISOString(), reason: "Unclean shutdown detected: a dead writer may have lost unrecorded usage." }); }
        }
      }
      return { state, manifest, tornBytes };
    } catch (error) {
      // A reader may race publication + retirement of an immutable generation.
      try { if (fs.readFileSync(join(directory, "manifest.json"), "utf8") !== manifestText) continue; } catch { /* Preserve the original error. */ }
      throw error;
    }
  }
  throw new Error("Usage store changed during read; retry the query");
}

export class UsageStore {
  private fd?: number;
  private closed = false;
  private failed = false;
  private gapId = `gap-${randomUUID()}`;
  private gapStart?: string;
  private constructor(private readonly directory: string, private readonly claim: string, private state: State, private manifest: Manifest) {}

  static open(directory: string): UsageStore {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
    const lock = acquire(directory);
    let store: UsageStore | undefined;
    try {
      const initializing = join(directory, "initializing.json");
      if (fs.existsSync(initializing) && !fs.existsSync(join(directory, "manifest.json"))) {
        finishInitialization(directory, manifestFrom(fs.readFileSync(initializing, "utf8")));
      }
      const loaded = load(directory);
      const state = loaded.state;
      let manifest = loaded.manifest;
      if (!manifest) {
        state.trackingSince = new Date().toISOString();
        const id = randomUUID(); manifest = { version: 1, state: `state-${id}.json`, journal: `journal-${id}.jsonl` };
        atomicWrite(directory, "initializing.json", manifest);
        finishInitialization(directory, manifest, state);
      }
      if (fs.existsSync(initializing)) {
        fs.unlinkSync(initializing); syncDirectory(directory);
      }
      store = new UsageStore(directory, lock.claim, state, manifest);
      if (loaded.tornBytes !== undefined) {
        if (!store.recordGap(tailGapStart(state))) throw new Error("Unable to preserve torn-tail recovery boundary");
        const fd = fs.openSync(join(directory, manifest.journal), "r+");
        try { fs.ftruncateSync(fd, loaded.tornBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      store.fd = fs.openSync(join(directory, manifest.journal), "a", 0o600);
      fs.fchmodSync(store.fd, 0o600);
      const recoveredAt = new Date().toISOString();
      for (const gap of state.gaps ?? []) {
        if (!gap.end) store.append({ version: 1, type: "gap", gap: { ...gap, end: gap.start > recoveredAt ? gap.start : recoveredAt } });
      }
      store.gapId = `gap-${randomUUID()}`; store.gapStart = undefined;
      // Closed gaps are durable before uncertainty markers or dead claims retire.
      for (const entry of fs.readdirSync(directory)) if (/^gap-[a-f0-9-]+$/.test(entry)) fs.rmdirSync(join(directory, entry));
      for (const dead of lock.deadClaims) fs.rmdirSync(dead);
      syncDirectory(directory);
      return store;
    } catch (error) {
      if (store?.fd !== undefined) fs.closeSync(store.fd);
      if (!store || store.recordGap()) fs.rmdirSync(lock.claim);
      throw error;
    }
  }
  static read(directory: string): UsageSnapshot { return UsageStore.publicSnapshot(load(directory).state); }
  private static publicSnapshot(state: State): UsageSnapshot { const { completedAttempts: _, ...snapshot } = state; return structuredClone(snapshot); }
  snapshot(): UsageSnapshot { return UsageStore.publicSnapshot(this.state); }
  private assertWritable(): void {
    if (this.closed) throw new Error("Usage store is closed");
    if (this.failed) throw new Error("Usage persistence failed; reopen the store before writing");
  }
  private recordGap(start = new Date().toISOString()): boolean {
    this.gapStart ??= start;
    addGap(this.state, { id: this.gapId, start: this.gapStart, reason: "Usage persistence failure may have lost observations." });
    try {
      const path = join(this.directory, this.gapId);
      fs.mkdirSync(path, { recursive: true, mode: 0o700 });
      const timestamp = new Date(this.gapStart); fs.utimesSync(path, timestamp, timestamp);
      syncDirectory(this.directory); return true;
    } catch { return false; } // If even the marker fails, retain the writer claim on close.
  }
  private storageFailure(error: unknown, affectedAt?: string): never {
    this.recordGap(affectedAt); this.failed = true; warn(this.state, "Usage persistence failed; history may be incomplete. Reopen the store before writing."); throw error;
  }
  private append(record: RecordEntry): void {
    this.assertWritable();
    // Validate before touching disk. A failed append cannot mutate committed state.
    applyRecord(this.state, record, false);
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    if (bytes.length > MAX_RECORD_BYTES) throw new Error("Usage record exceeds size limit");
    try {
      let written = 0;
      while (written < bytes.length) {
        const count = fs.writeSync(this.fd!, bytes, written, bytes.length - written);
        if (count <= 0) throw new Error("Usage journal write made no progress"); written += count;
      }
      fs.fsyncSync(this.fd!);
    } catch (error) { this.storageFailure(error, record.type === "observation" ? record.observation.ts : undefined); }
    applyRecord(this.state, record);
  }
  observe(value: UsageObservation): void {
    this.assertWritable(); const observation = validateObservation(value);
    if (!applyObservation(this.state, observation, false)) return;
    this.append({ version: 1, type: "observation", observation });
  }
  account(provider: UsageProvider, alias: string): UsageAccount {
    this.assertWritable(); usageProvider(provider); boundedString(alias, "account alias", 128);
    const index = indexes(this.state).aliases.get(aliasKey(provider, alias));
    const account = index === undefined ? undefined : this.state.accounts[index];
    if (account) return structuredClone(account);
    const created = { key: randomUUID(), provider, alias };
    this.append({ version: 1, type: "account", account: created }); return structuredClone(created);
  }
  rename(provider: UsageProvider, oldAlias: string, newAlias: string): UsageAccount {
    this.assertWritable(); usageProvider(provider); boundedString(oldAlias, "account alias", 128); boundedString(newAlias, "account alias", 128);
    const index = indexes(this.state).aliases.get(aliasKey(provider, oldAlias));
    const account = index === undefined ? undefined : this.state.accounts[index];
    if (!account) throw new Error("Unknown active usage account");
    if (oldAlias === newAlias) return structuredClone(account);
    const renamed = { ...account, alias: newAlias }; this.append({ version: 1, type: "account", account: renamed }); return structuredClone(renamed);
  }
  retire(provider: UsageProvider, alias: string): void {
    this.assertWritable(); usageProvider(provider); boundedString(alias, "account alias", 128);
    const index = indexes(this.state).aliases.get(aliasKey(provider, alias));
    const account = index === undefined ? undefined : this.state.accounts[index];
    if (!account) throw new Error("Unknown active usage account");
    this.append({ version: 1, type: "account", account: { ...account, retired: true } });
  }
  private resolve(alias: string): UsageAccount {
    boundedString(alias, "account alias or key", 128);
    const key = this.state.accounts.find(entry => entry.key === alias); if (key) return key;
    const active = this.state.accounts.filter(entry => entry.alias === alias && !entry.retired);
    const matches = active.length ? active : this.state.accounts.filter(entry => entry.alias === alias);
    if (matches.length !== 1) throw new Error("Unknown or ambiguous usage account; use its opaque account key");
    return matches[0];
  }
  private writeSubscriptions(subscriptions: Subscription[]): void {
    this.assertWritable();
    try { atomicWrite(this.directory, "subscriptions.json", { version: 1, subscriptions }); }
    catch (error) { this.storageFailure(error); }
    this.state.subscriptions = subscriptions;
  }
  setSubscription(alias: string, amount: number, from: string): Subscription {
    this.assertWritable(); const next = setSubscription(this.state.subscriptions, this.resolve(alias), amount, from);
    this.writeSubscriptions(next); return structuredClone(next.at(-1)!);
  }
  endSubscription(alias: string, on: string): Subscription {
    this.assertWritable(); const account = this.resolve(alias);
    const next = endSubscription(this.state.subscriptions, account.key, on); this.writeSubscriptions(next);
    return structuredClone(next.filter(entry => entry.accountKey === account.key).sort((a,b) => a.from.localeCompare(b.from)).at(-1)!);
  }
  compact(): void {
    this.assertWritable(); const next = structuredClone(this.state);
    const completed = new Set(next.observations.filter(entry => entry.complete || entry.settled).map(entry => entry.attemptId));
    const groups = new Map<string, UsageAggregate>();
    const merge = (entry: UsageAggregate) => {
      const key = JSON.stringify([entry.start, entry.accountKey, entry.provider, entry.model, entry.rates]);
      const prior = groups.get(key);
      if (prior) addTokens(prior.tokens, entry.tokens); else groups.set(key, structuredClone(entry));
    };
    const partial = new Set(next.observations.filter(entry => entry.settled && !entry.complete).map(entry => entry.attemptId));
    for (const entry of next.aggregates) merge(entry);
    for (const delta of next.deltas) {
      if (!completed.has(delta.attemptId)) continue;
      if (partial.has(delta.attemptId)) {
        const day = Math.floor(Date.parse(delta.ts) / 86_400_000) * 86_400_000;
        addGap(next, { id: `partial-${delta.provider}-${new Date(day).toISOString().slice(0, 10)}`, start: new Date(day).toISOString(), end: new Date(day + 86_400_000).toISOString(), provider: delta.provider, reason: "Ended attempts have incomplete token observations." });
      }
      const hour = Math.floor(Date.parse(delta.ts) / 3600000) * 3600000;
      merge({ start: new Date(hour).toISOString(), end: new Date(hour + 3600000).toISOString(), accountKey: delta.accountKey, provider: delta.provider, model: delta.model, tokens: delta.tokens, ...(delta.rates ? { rates: delta.rates } : {}) });
    }
    for (const observation of next.observations) if (observation.complete || observation.settled) next.completedAttempts.push({ attemptId: observation.attemptId, revision: observation.revision, fingerprint: fingerprint(observation) });
    next.observations = next.observations.filter(entry => !entry.complete && !entry.settled);
    next.deltas = next.deltas.filter(entry => !completed.has(entry.attemptId)); next.aggregates = [...groups.values()];
    const id = randomUUID(); const manifest: Manifest = { version: 1, state: `state-${id}.json`, journal: `journal-${id}.jsonl` };
    const previous = this.manifest; let nextFd: number | undefined;
    try {
      createFile(join(this.directory, manifest.state), JSON.stringify(next)); createFile(join(this.directory, manifest.journal), "");
      nextFd = fs.openSync(join(this.directory, manifest.journal), "a");
      atomicWrite(this.directory, "manifest.json", manifest);
      fs.closeSync(this.fd!); this.fd = nextFd; nextFd = undefined; this.state = next; this.manifest = manifest;
      // Publication is committed. Leftover old generations are harmless on crash.
      fs.unlinkSync(join(this.directory, previous.state)); fs.unlinkSync(join(this.directory, previous.journal)); syncDirectory(this.directory);
    } catch (error) { if (nextFd !== undefined) fs.closeSync(nextFd); this.storageFailure(error); }
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    try { if (this.fd !== undefined) fs.fsyncSync(this.fd); }
    catch { this.failed = true; this.recordGap(); warn(this.state, "Usage shutdown sync failed; history may be incomplete."); }
    finally {
      try { if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; } }
      finally { if (!this.failed || this.recordGap()) fs.rmdirSync(this.claim); }
    }
  }
}
