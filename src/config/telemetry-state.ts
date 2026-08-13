import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { ensureConfigDir } from "./directory.js";
import { TELEMETRY_PATH } from "./paths.js";

// This module is imported by cli/bootstrap before the OTel ESM hook is
// registered. Keep its graph limited to Node built-ins and bootstrap-safe
// config primitives; general application modules belong after registration.

// Anonymous telemetry state persisted at ~/.cc-router/telemetry.json.
// The installId is a random UUID with no link to any user identity — it exists
// only so we can count unique installations instead of raw event volume.
export interface TelemetryState {
  enabled: boolean;
  installId: string;
  firstRunAt: string;
  revision: number;
}

export interface TelemetrySnapshot {
  state: TelemetryState;
  environmentDisabled: boolean;
  enabled: boolean;
}

let pendingFirstStartInstallId: string | undefined;
let firstStartClaimedByProcess = false;

function markFreshStateForFirstStart(state: TelemetryState): void {
  if (!firstStartClaimedByProcess) pendingFirstStartInstallId = state.installId;
}

function defaultState(): TelemetryState {
  return {
    enabled: true,
    installId: randomUUID(),
    firstRunAt: new Date().toISOString(),
    revision: 0,
  };
}

interface NormalizedTelemetryState {
  state: TelemetryState;
  createdInstallIdentity: boolean;
  requiresMigration: boolean;
}

function normalizeTelemetryState(raw: unknown): NormalizedTelemetryState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    const state = defaultState();
    return { state, createdInstallIdentity: true, requiresMigration: true };
  }
  const candidate = raw as Partial<TelemetryState>;
  // Fill any missing fields to keep the file forward-compatible. Existing
  // boolean choices are always preserved; an older state without `enabled`
  // migrates to the default-on policy.
  const createdInstallIdentity = !(typeof candidate.installId === "string" && candidate.installId);
  const state: TelemetryState = {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
    installId: typeof candidate.installId === "string" && candidate.installId
      ? candidate.installId
      : randomUUID(),
    firstRunAt: typeof candidate.firstRunAt === "string" && candidate.firstRunAt
      ? candidate.firstRunAt
      : new Date().toISOString(),
    revision: typeof candidate.revision === "number"
      && Number.isSafeInteger(candidate.revision)
      && candidate.revision >= 0
      ? candidate.revision
      : 0,
  };
  const requiresMigration = candidate.enabled !== state.enabled
    || candidate.installId !== state.installId
    || candidate.firstRunAt !== state.firstRunAt
    || candidate.revision !== state.revision;
  return { state, createdInstallIdentity, requiresMigration };
}

function readNormalizedTelemetryState(): NormalizedTelemetryState | undefined {
  try {
    return normalizeTelemetryState(JSON.parse(readFileSync(TELEMETRY_PATH, "utf-8")));
  } catch {
    return undefined;
  }
}

// Atomic durable write: unique owner-only temp file, fsync, then same-directory
// rename. The directory fsync is best effort because Windows does not allow a
// directory descriptor to be opened the same way as macOS/Linux.
function writeTelemetryStateUnlocked(state: TelemetryState): void {
  ensureConfigDir();
  const tmp = `${TELEMETRY_PATH}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tmp, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(state, null, 2), "utf-8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try { chmodSync(tmp, 0o600); } catch { /* best effort on Windows */ }
    renameSync(tmp, TELEMETRY_PATH);
    try { chmodSync(TELEMETRY_PATH, 0o600); } catch { /* best effort on Windows */ }
    try {
      const directory = openSync(dirname(TELEMETRY_PATH), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch {
      // The atomic rename remains authoritative where directory fsync is not supported.
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* retain the original write error */ }
    }
    try { unlinkSync(tmp); } catch { /* the temp may not exist or may already be renamed */ }
    throw error;
  }
}

interface ConsentLockOwner {
  version: 1;
  token: string;
  pid: number;
  createdAt: number;
}

interface ConsentLock {
  owner: ConsentLockOwner;
}

interface ConsentQueueOwner {
  token: string;
  pid: number;
  createdAt: number;
}

interface ConsentQueueEntry extends ConsentQueueOwner {
  name: string;
  phase: "choosing" | "ticket";
  ticket?: number;
}

interface ConsentQueueLock {
  path: string;
}

const CONSENT_LOCK_TIMEOUT_MS = 750;
const CONSENT_LOCK_STALE_AFTER_MS = 250;
const CONSENT_RETRY_MS = 10;
const consentWaitBuffer = new SharedArrayBuffer(4);
const consentWaitView = new Int32Array(consentWaitBuffer);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSENT_QUEUE_ENTRY_PATTERN = new RegExp(
  `^v1\\.(\\d+)\\.(\\d+)\\.(${UUID_PATTERN.source.slice(1, -1)})\\.(choosing|ticket\\.(\\d+))$`,
  "i",
);

function errorCode(error: unknown): unknown {
  return (typeof error === "object" || typeof error === "function") && error !== null
    ? Object.getOwnPropertyDescriptor(error, "code")?.value
    : undefined;
}

function parseConsentLockOwner(raw: string): ConsentLockOwner | undefined {
  try {
    const candidate = JSON.parse(raw) as Record<string, unknown>;
    if (
      candidate["version"] !== 1
      || typeof candidate["token"] !== "string"
      || !UUID_PATTERN.test(candidate["token"])
      || typeof candidate["pid"] !== "number"
      || !Number.isSafeInteger(candidate["pid"])
      || candidate["pid"] <= 0
      || typeof candidate["createdAt"] !== "number"
      || !Number.isSafeInteger(candidate["createdAt"])
      || candidate["createdAt"] < 0
    ) return undefined;
    return candidate as unknown as ConsentLockOwner;
  } catch {
    return undefined;
  }
}

function readConsentLockOwner(): ConsentLockOwner | undefined {
  try {
    return parseConsentLockOwner(readFileSync(`${TELEMETRY_PATH}.lock`, "utf8"));
  } catch {
    return undefined;
  }
}

function sameConsentLockOwner(left: ConsentLockOwner, right: ConsentLockOwner): boolean {
  return left.version === right.version
    && left.token === right.token
    && left.pid === right.pid
    && left.createdAt === right.createdAt;
}

function processIsDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means a process exists but is owned by another principal. Unknown
    // platform errors and PID reuse therefore fail closed as live ownership.
    return errorCode(error) === "ESRCH";
  }
}

function consentLockBusyError(path: string): NodeJS.ErrnoException {
  const error = new Error(
    `EEXIST: telemetry consent lock is busy, open '${path}'`,
  ) as NodeJS.ErrnoException;
  error.code = "EEXIST";
  error.path = path;
  return error;
}

function parseConsentQueueEntry(name: string): ConsentQueueEntry | undefined {
  const match = CONSENT_QUEUE_ENTRY_PATTERN.exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]);
  const createdAt = Number(match[2]);
  const ticket = match[5] === undefined ? undefined : Number(match[5]);
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || !Number.isSafeInteger(createdAt)
    || createdAt < 0
    || (ticket !== undefined && (!Number.isSafeInteger(ticket) || ticket <= 0))
  ) return undefined;
  return {
    name,
    token: match[3]!,
    pid,
    createdAt,
    phase: match[4] === "choosing" ? "choosing" : "ticket",
    ticket,
  };
}

function queueEntryName(owner: ConsentQueueOwner, phase: "choosing" | "ticket", ticket?: number): string {
  const suffix = phase === "choosing" ? phase : `ticket.${String(ticket)}`;
  return `v1.${String(owner.pid)}.${String(owner.createdAt)}.${owner.token}.${suffix}`;
}

/**
 * List immutable contenders and remove only exact, uniquely named entries whose
 * process is definitely dead. Unknown entries fail closed so foreign data is
 * never interpreted as ours or removed.
 */
function listConsentQueueEntries(queuePath: string, now: number): {
  entries: ConsentQueueEntry[];
  hasForeignEntry: boolean;
} {
  const entries: ConsentQueueEntry[] = [];
  let hasForeignEntry = false;
  for (const name of readdirSync(queuePath)) {
    const entry = parseConsentQueueEntry(name);
    if (!entry) {
      hasForeignEntry = true;
      continue;
    }
    if (
      now - entry.createdAt >= CONSENT_LOCK_STALE_AFTER_MS
      && processIsDefinitelyDead(entry.pid)
    ) {
      try {
        unlinkSync(join(queuePath, entry.name));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      continue;
    }
    entries.push(entry);
  }
  return { entries, hasForeignEntry };
}

function compareConsentQueueEntries(left: ConsentQueueEntry, right: ConsentQueueEntry): number {
  const ticketDifference = left.ticket! - right.ticket!;
  if (ticketDifference !== 0) return ticketDifference;
  return left.token.localeCompare(right.token);
}

/**
 * A filesystem form of Lamport's bakery lock. Every contender has an immutable,
 * token-scoped path; crashed entries can therefore be reclaimed without ever
 * unlinking a replacement generation. The choosing phase prevents equal-ticket
 * contenders from entering before the total token ordering is visible.
 */
function acquireConsentQueueLock(): ConsentQueueLock {
  ensureConfigDir();
  const queuePath = `${TELEMETRY_PATH}.lock.queue`;
  try {
    mkdirSync(queuePath, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  const startedAt = Date.now();
  const owner: ConsentQueueOwner = {
    token: randomUUID(),
    pid: process.pid,
    createdAt: startedAt,
  };
  let ownPath = join(queuePath, queueEntryName(owner, "choosing"));
  let descriptor: number | undefined;
  try {
    descriptor = openSync(ownPath, "wx", 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    let ticket: number | undefined;
    while (ticket === undefined) {
      const now = Date.now();
      const snapshot = listConsentQueueEntries(queuePath, now);
      if (!snapshot.hasForeignEntry) {
        const maximum = snapshot.entries.reduce(
          (current, entry) => entry.phase === "ticket" ? Math.max(current, entry.ticket!) : current,
          0,
        );
        if (maximum >= Number.MAX_SAFE_INTEGER) throw new Error("Telemetry consent lock ticket exhausted");
        ticket = maximum + 1;
        const ticketPath = join(queuePath, queueEntryName(owner, "ticket", ticket));
        renameSync(ownPath, ticketPath);
        ownPath = ticketPath;
        break;
      }
      if (now - startedAt >= CONSENT_LOCK_TIMEOUT_MS) throw consentLockBusyError(queuePath);
      Atomics.wait(consentWaitView, 0, 0, CONSENT_RETRY_MS);
    }

    const ownEntry: ConsentQueueEntry = {
      ...owner,
      name: queueEntryName(owner, "ticket", ticket),
      phase: "ticket",
      ticket,
    };
    while (true) {
      const now = Date.now();
      const snapshot = listConsentQueueEntries(queuePath, now);
      const blocked = snapshot.hasForeignEntry || snapshot.entries.some(entry => (
        entry.token !== owner.token
        && (
          entry.phase === "choosing"
          || compareConsentQueueEntries(entry, ownEntry) < 0
        )
      ));
      if (!blocked) return { path: ownPath };
      if (now - startedAt >= CONSENT_LOCK_TIMEOUT_MS) throw consentLockBusyError(queuePath);
      Atomics.wait(consentWaitView, 0, 0, CONSENT_RETRY_MS);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* retain the original error */ }
    }
    try { unlinkSync(ownPath); } catch { /* exact contender may already be absent */ }
    throw error;
  }
}

function releaseConsentQueueLock(lock: ConsentQueueLock): void {
  try {
    unlinkSync(lock.path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function recoverAbandonedConsentLock(now: number): boolean {
  const owner = readConsentLockOwner();
  if (!owner) return false;
  const age = now - owner.createdAt;
  if (age < CONSENT_LOCK_STALE_AFTER_MS || !processIsDefinitelyDead(owner.pid)) return false;

  // Only the elected queue owner reaches this point. Move the authoritative
  // pathname atomically into a freshly created private directory, then validate
  // the exact inode/generation that was moved. A delayed reclaimer cannot move
  // or unlink a subsequently published lock.
  const claimDirectory = `${TELEMETRY_PATH}.lock.reclaim.${String(process.pid)}.${randomUUID()}`;
  mkdirSync(claimDirectory, { mode: 0o700 });
  const claimedPath = join(claimDirectory, "owner");
  try {
    renameSync(`${TELEMETRY_PATH}.lock`, claimedPath);
  } catch (error) {
    try { rmdirSync(claimDirectory); } catch { /* preserve the rename error */ }
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }

  const claimed = (() => {
    try {
      return parseConsentLockOwner(readFileSync(claimedPath, "utf8"));
    } catch {
      return undefined;
    }
  })();
  const stillAbandoned = claimed
    && sameConsentLockOwner(claimed, owner)
    && Date.now() - claimed.createdAt >= CONSENT_LOCK_STALE_AFTER_MS
    && processIsDefinitelyDead(claimed.pid);
  if (!stillAbandoned) {
    // The pathname changed outside the contender protocol. Restore only with
    // atomic no-replace publication and retain the claim on any conflict.
    try {
      linkSync(claimedPath, `${TELEMETRY_PATH}.lock`);
      unlinkSync(claimedPath);
      rmdirSync(claimDirectory);
    } catch {
      // Fail closed: do not delete an unverified generation or another owner.
    }
    return false;
  }

  try { unlinkSync(claimedPath); } catch { /* exact stale quarantine is harmless */ }
  try { rmdirSync(claimDirectory); } catch { /* exact private directory may remain */ }
  return true;
}

function acquireConsentLock(): ConsentLock {
  ensureConfigDir();
  const lockPath = `${TELEMETRY_PATH}.lock`;
  const startedAt = Date.now();
  while (true) {
    let descriptor: number | undefined;
    const owner: ConsentLockOwner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
    };
    const candidatePath = `${lockPath}.${owner.pid}.${owner.token}.candidate`;
    try {
      // Publish only a fully written owner record. Hard-link creation is an
      // atomic no-replace operation on macOS, Linux, and Windows/NTFS, so a
      // kill before publication leaves no malformed authoritative lock.
      descriptor = openSync(candidatePath, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(owner), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try { chmodSync(candidatePath, 0o600); } catch { /* best effort on Windows */ }
      linkSync(candidatePath, lockPath);
      try { unlinkSync(candidatePath); } catch { /* a unique orphan is harmless */ }
      try { chmodSync(lockPath, 0o600); } catch { /* best effort on Windows */ }
      return { owner };
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* retain the original acquisition error */ }
      }
      try { unlinkSync(candidatePath); } catch { /* absent or retained after process death */ }
      const now = Date.now();
      if (errorCode(error) !== "EEXIST") throw error;
      if (recoverAbandonedConsentLock(now)) continue;
      if (now - startedAt >= CONSENT_LOCK_TIMEOUT_MS) throw error;
      Atomics.wait(consentWaitView, 0, 0, CONSENT_RETRY_MS);
    }
  }
}

function withConsentLock<T>(operation: () => T): T {
  const lockPath = `${TELEMETRY_PATH}.lock`;
  const queueLock = acquireConsentQueueLock();
  try {
    const lock = acquireConsentLock();
    try {
      return operation();
    } finally {
      const current = readConsentLockOwner();
      if (current && sameConsentLockOwner(current, lock.owner)) {
        try {
          unlinkSync(lockPath);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      }
    }
  } finally {
    releaseConsentQueueLock(queueLock);
  }
}

function loadTelemetryStateForMutation(): TelemetryState {
  const locked = readNormalizedTelemetryState();
  if (locked && !locked.requiresMigration) return locked.state;
  const normalized = locked ?? {
    state: defaultState(),
    createdInstallIdentity: true,
    requiresMigration: true,
  };
  writeTelemetryStateUnlocked(normalized.state);
  if (normalized.createdInstallIdentity) markFreshStateForFirstStart(normalized.state);
  return normalized.state;
}

export function loadTelemetryState(): TelemetryState {
  // Atomically renamed valid files are immutable snapshots and need no lock.
  // Only creation, corruption recovery, and schema migration are mutations.
  const current = readNormalizedTelemetryState();
  if (current && !current.requiresMigration) return current.state;
  return withConsentLock(loadTelemetryStateForMutation);
}

// Serialize direct state writes with creation, migration, and explicit choices.
export function writeTelemetryState(state: TelemetryState): void {
  withConsentLock(() => writeTelemetryStateUnlocked(state));
}

/** Persist one explicit choice and advance its cross-process generation. */
export function updateTelemetryConsent(enabled: boolean): TelemetryState {
  return withConsentLock(() => {
    const current = loadTelemetryStateForMutation();
    if (current.revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Telemetry consent revision exhausted");
    }
    const next = { ...current, enabled, revision: current.revision + 1 };
    writeTelemetryStateUnlocked(next);
    return next;
  });
}

// Returns persisted state with the one authoritative effective value. Environment
// values only act as kill switches; they cannot turn a persisted opt-out back on.
export function getTelemetrySnapshot(): TelemetrySnapshot {
  const state = loadTelemetryState();
  const environmentDisabled =
    process.env["DO_NOT_TRACK"] === "1" || process.env["CC_ROUTER_TELEMETRY"] === "0";
  const enabled = !environmentDisabled && state.enabled;

  return { state, environmentDisabled, enabled };
}

export interface TelemetryConsentGate {
  readonly acceptedRevision: number;
  readonly latchedDisabled: boolean;
  getSnapshot(): TelemetrySnapshot | undefined;
}

/**
 * Bind a runtime to the consent generation it observed at startup. Any later
 * persisted generation means an explicit choice occurred, so that runtime is
 * permanently disabled and must be restarted before telemetry can resume.
 */
export function createTelemetryConsentGate(
  getSnapshot: () => TelemetrySnapshot = getTelemetrySnapshot,
  initialSnapshot?: TelemetrySnapshot,
  onRevisionMismatch?: () => void,
): TelemetryConsentGate {
  let first = initialSnapshot;
  if (!first) {
    try {
      first = getSnapshot();
    } catch {
      first = undefined;
    }
  }
  const acceptedRevision = first?.state.revision ?? 0;
  let latchedDisabled = first === undefined;
  let mismatchReported = false;

  const disable = (): void => {
    latchedDisabled = true;
    if (mismatchReported) return;
    mismatchReported = true;
    try {
      onRevisionMismatch?.();
    } catch {
      // Consent enforcement never depends on cleanup callbacks.
    }
  };

  return {
    acceptedRevision,
    get latchedDisabled() { return latchedDisabled; },
    getSnapshot(): TelemetrySnapshot | undefined {
      if (latchedDisabled) return undefined;
      try {
        const snapshot = getSnapshot();
        if ((snapshot.state.revision ?? 0) !== acceptedRevision) {
          disable();
          return undefined;
        }
        return snapshot.enabled ? snapshot : undefined;
      } catch {
        disable();
        return undefined;
      }
    },
  };
}

// Claim the one first-start event belonging to fresh state created by this
// process. Reading an existing state file in a later process never qualifies.
export function claimTelemetryFirstStart(): TelemetrySnapshot | undefined {
  const pendingInstallId = pendingFirstStartInstallId;
  if (!pendingInstallId) return undefined;
  pendingFirstStartInstallId = undefined;
  firstStartClaimedByProcess = true;
  try {
    const snapshot = getTelemetrySnapshot();
    return snapshot.state.installId === pendingInstallId ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

// Returns true only if the user has not opted out through any mechanism:
//   - DO_NOT_TRACK=1     (de-facto standard)
//   - CC_ROUTER_TELEMETRY=0  (project-specific override)
//   - `cc-router telemetry off` (persisted enabled: false)
export function isTelemetryEnabled(): boolean {
  try {
    return getTelemetrySnapshot().enabled;
  } catch {
    return false;
  }
}
