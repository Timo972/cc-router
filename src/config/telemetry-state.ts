import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  opendirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { basename, dirname, join } from "path";
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
    try { fchmodSync(descriptor, 0o600); } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmp, TELEMETRY_PATH);
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

interface ConsentQueueEntry extends ConsentLockOwner {
  name: string;
  phase: "choosing" | "ticket";
  ticket?: number;
}

interface ConsentQueueLock {
  path: string;
  owner: ConsentLockOwner;
}

interface ConsentOwnerFile {
  owner: ConsentLockOwner;
}

interface ConsentArtifactOwners {
  reclaimer: ConsentLockOwner;
  owner: ConsentLockOwner;
  cleanup: boolean;
}

const CONSENT_LOCK_TIMEOUT_MS = 750;
const CONSENT_LOCK_STALE_AFTER_MS = 250;
const CONSENT_RETRY_MS = 10;
const CONSENT_ARTIFACT_DIRECTORY_SCAN_LIMIT = 256;
const CONSENT_ARTIFACT_CANDIDATE_LIMIT = 32;
const CONSENT_OWNER_SIZE_LIMIT = 4_096;
const consentWaitBuffer = new SharedArrayBuffer(4);
const consentWaitView = new Int32Array(consentWaitBuffer);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSENT_QUEUE_ENTRY_PATTERN = new RegExp(
  `^v1\\.(\\d+)\\.(\\d+)\\.(${UUID_PATTERN.source.slice(1, -1)})\\.(choosing|ticket\\.(\\d+))$`,
  "i",
);
const CONSENT_CLEANUP_SUFFIX_PATTERN = new RegExp(
  `^(.*)\\.cleanup\\.(${UUID_PATTERN.source.slice(1, -1)})$`,
  "i",
);

function errorCode(error: unknown): unknown {
  return (typeof error === "object" || typeof error === "function") && error !== null
    ? Object.getOwnPropertyDescriptor(error, "code")?.value
    : undefined;
}

function validateConsentLockOwner(candidate: Record<string, unknown>): ConsentLockOwner | undefined {
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
}

function parseConsentLockOwner(raw: string): ConsentLockOwner | undefined {
  try {
    return validateConsentLockOwner(JSON.parse(raw) as Record<string, unknown>);
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

function ownedByCurrentUser(uid: number): boolean {
  const getuid = Object.getOwnPropertyDescriptor(process, "getuid")?.value as (() => number) | undefined;
  return getuid === undefined || uid === getuid();
}

/**
 * Open the exact file without following a final symlink, then validate the
 * opened inode. Node has no cross-platform openat/unlinkat API, so all consent
 * artifacts are regular files directly under the already trusted, user-owned
 * config parent; no mutation traverses a replaceable child directory.
 */
function readConsentOwnerFile(path: string): ConsentOwnerFile | undefined {
  let descriptor: number | undefined;
  try {
    const linkedStatus = lstatSync(path);
    if (
      linkedStatus.isSymbolicLink()
      || !linkedStatus.isFile()
      || linkedStatus.nlink !== 1
      || !ownedByCurrentUser(linkedStatus.uid)
      || linkedStatus.size > CONSENT_OWNER_SIZE_LIMIT
      || (process.platform !== "win32" && (linkedStatus.mode & 0o777) !== 0o600)
    ) return undefined;
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (
      !status.isFile()
      || status.dev !== linkedStatus.dev
      || status.ino !== linkedStatus.ino
      || status.nlink !== 1
      || !ownedByCurrentUser(status.uid)
      || status.size > CONSENT_OWNER_SIZE_LIMIT
      || (process.platform !== "win32" && (status.mode & 0o777) !== 0o600)
    ) return undefined;
    const owner = parseConsentLockOwner(readFileSync(descriptor, "utf8"));
    return owner ? { owner } : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* a closed read handle changes no path */ }
    }
  }
}

function readConsentLockOwner(): ConsentLockOwner | undefined {
  return readConsentOwnerFile(`${TELEMETRY_PATH}.lock`)?.owner;
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

function consentPathError(code: string, path: string, message: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${message}, '${path}'`) as NodeJS.ErrnoException;
  error.code = code;
  error.path = path;
  return error;
}

function consentQueuePrefix(): string {
  return `${basename(TELEMETRY_PATH)}.lock.queue.`;
}

function consentQueueCleanupPrefix(): string {
  return `${basename(TELEMETRY_PATH)}.lock.queue-cleanup.v1.`;
}

function consentQuarantinePrefix(): string {
  return `${basename(TELEMETRY_PATH)}.lock.reclaim.v1.`;
}

function queueEntryName(owner: ConsentLockOwner, phase: "choosing" | "ticket", ticket?: number): string {
  const suffix = phase === "choosing" ? phase : `ticket.${String(ticket)}`;
  return `${consentQueuePrefix()}v1.${String(owner.pid)}.${String(owner.createdAt)}.${owner.token}.${suffix}`;
}

function parseConsentQueueEntry(name: string): ConsentQueueEntry | undefined {
  const prefix = consentQueuePrefix();
  if (!name.startsWith(prefix)) return undefined;
  const match = CONSENT_QUEUE_ENTRY_PATTERN.exec(name.slice(prefix.length));
  if (!match) return undefined;
  const owner = validateConsentLockOwner({
    version: 1,
    pid: Number(match[1]),
    createdAt: Number(match[2]),
    token: match[3],
  });
  const ticket = match[5] === undefined ? undefined : Number(match[5]);
  if (!owner || (ticket !== undefined && (!Number.isSafeInteger(ticket) || ticket <= 0))) return undefined;
  return {
    ...owner,
    name,
    phase: match[4] === "choosing" ? "choosing" : "ticket",
    ticket,
  };
}

function consentArtifactName(
  prefix: string,
  reclaimer: ConsentLockOwner,
  owner: ConsentLockOwner,
): string {
  return `${prefix}${String(reclaimer.pid)}.${String(reclaimer.createdAt)}.${reclaimer.token}.${
    String(owner.pid)
  }.${String(owner.createdAt)}.${owner.token}`;
}

function consentQueueCleanupName(reclaimer: ConsentLockOwner, owner: ConsentLockOwner): string {
  return consentArtifactName(consentQueueCleanupPrefix(), reclaimer, owner);
}

function consentQuarantineName(reclaimer: ConsentLockOwner, owner: ConsentLockOwner): string {
  return consentArtifactName(consentQuarantinePrefix(), reclaimer, owner);
}

function parseConsentArtifactOwners(name: string, prefix: string): ConsentArtifactOwners | undefined {
  if (!name.startsWith(prefix)) return undefined;
  let encoded = name.slice(prefix.length);
  let cleanup = false;
  const cleanupMatch = CONSENT_CLEANUP_SUFFIX_PATTERN.exec(encoded);
  if (cleanupMatch) {
    cleanup = true;
    encoded = cleanupMatch[1]!;
  }
  const fields = encoded.split(".");
  if (fields.length !== 6) return undefined;
  const reclaimer = validateConsentLockOwner({
    version: 1,
    pid: Number(fields[0]),
    createdAt: Number(fields[1]),
    token: fields[2],
  });
  const owner = validateConsentLockOwner({
    version: 1,
    pid: Number(fields[3]),
    createdAt: Number(fields[4]),
    token: fields[5],
  });
  return reclaimer && owner ? { reclaimer, owner, cleanup } : undefined;
}

function consentOwnersAreAbandoned(expected: ConsentArtifactOwners, now: number): boolean {
  return now - expected.reclaimer.createdAt >= CONSENT_LOCK_STALE_AFTER_MS
    && processIsDefinitelyDead(expected.reclaimer.pid)
    && now - expected.owner.createdAt >= CONSENT_LOCK_STALE_AFTER_MS
    && processIsDefinitelyDead(expected.owner.pid);
}

function retireStaleQueueEntry(
  path: string,
  reclaimer: ConsentLockOwner,
  owner: ConsentLockOwner,
  now: number,
): void {
  const cleanupPath = join(
    dirname(TELEMETRY_PATH),
    `${consentQueueCleanupName(reclaimer, owner)}.cleanup.${randomUUID()}`,
  );
  try {
    renameSync(path, cleanupPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const claimed = readConsentOwnerFile(cleanupPath);
  if (
    !claimed
    || !sameConsentLockOwner(claimed.owner, owner)
    || now - claimed.owner.createdAt < CONSENT_LOCK_STALE_AFTER_MS
    || !processIsDefinitelyDead(claimed.owner.pid)
  ) {
    throw consentPathError("EAGAIN", cleanupPath, "stale consent queue record changed");
  }
  try {
    unlinkSync(cleanupPath);
  } catch (error) {
    throw consentPathError(
      String(errorCode(error) ?? "EAGAIN"),
      cleanupPath,
      "stale consent queue cleanup failed",
    );
  }
}

function listConsentQueueEntries(reclaimer: ConsentLockOwner, now: number): {
  entries: ConsentQueueEntry[];
  hasForeignEntry: boolean;
} {
  const configDirectory = dirname(TELEMETRY_PATH);
  const prefix = consentQueuePrefix();
  const entries: ConsentQueueEntry[] = [];
  let hasForeignEntry = false;
  for (const name of readdirSync(configDirectory)) {
    if (!name.startsWith(prefix)) continue;
    const entry = parseConsentQueueEntry(name);
    if (!entry) {
      hasForeignEntry = true;
      continue;
    }
    const path = join(configDirectory, name);
    const record = readConsentOwnerFile(path);
    if (!record || !sameConsentLockOwner(record.owner, entry)) {
      hasForeignEntry = true;
      continue;
    }
    if (
      now - entry.createdAt >= CONSENT_LOCK_STALE_AFTER_MS
      && processIsDefinitelyDead(entry.pid)
    ) {
      retireStaleQueueEntry(path, reclaimer, entry, now);
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
 * Same-parent regular files implement Lamport's bakery lock. There is no
 * replaceable queue directory: every contender path contains an unpredictable
 * token and is opened without replacement, while malformed/symlinked/hardlinked
 * matching entries block boundedly and remain untouched.
 */
function acquireConsentQueueLock(): ConsentQueueLock {
  ensureConfigDir();
  const configDirectory = dirname(TELEMETRY_PATH);
  const startedAt = Date.now();
  const owner: ConsentLockOwner = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    createdAt: startedAt,
  };
  let ownPath = join(configDirectory, queueEntryName(owner, "choosing"));
  let descriptor: number | undefined;
  try {
    descriptor = openSync(ownPath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(owner), "utf8");
    try { fchmodSync(descriptor, 0o600); } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    let ticket: number | undefined;
    while (ticket === undefined) {
      const now = Date.now();
      const snapshot = listConsentQueueEntries(owner, now);
      if (!snapshot.hasForeignEntry) {
        const maximum = snapshot.entries.reduce(
          (current, entry) => entry.phase === "ticket" ? Math.max(current, entry.ticket!) : current,
          0,
        );
        if (maximum >= Number.MAX_SAFE_INTEGER) throw new Error("Telemetry consent lock ticket exhausted");
        ticket = maximum + 1;
        const ticketPath = join(configDirectory, queueEntryName(owner, "ticket", ticket));
        renameSync(ownPath, ticketPath);
        ownPath = ticketPath;
        const published = readConsentOwnerFile(ownPath);
        if (!published || !sameConsentLockOwner(published.owner, owner)) {
          throw consentPathError("EAGAIN", ownPath, "consent queue contender changed");
        }
        break;
      }
      if (now - startedAt >= CONSENT_LOCK_TIMEOUT_MS) {
        throw consentLockBusyError(`${TELEMETRY_PATH}.lock.queue`);
      }
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
      const snapshot = listConsentQueueEntries(owner, now);
      const blocked = snapshot.hasForeignEntry || snapshot.entries.some(entry => (
        entry.token !== owner.token
        && (
          entry.phase === "choosing"
          || compareConsentQueueEntries(entry, ownEntry) < 0
        )
      ));
      if (!blocked) return { path: ownPath, owner };
      if (now - startedAt >= CONSENT_LOCK_TIMEOUT_MS) {
        throw consentLockBusyError(`${TELEMETRY_PATH}.lock.queue`);
      }
      Atomics.wait(consentWaitView, 0, 0, CONSENT_RETRY_MS);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* retain the original error */ }
    }
    try { unlinkSync(ownPath); } catch { /* unique path removal follows no symlink target */ }
    throw error;
  }
}

function releaseConsentQueueLock(lock: ConsentQueueLock): void {
  const current = readConsentOwnerFile(lock.path);
  if (!current || !sameConsentLockOwner(current.owner, lock.owner)) {
    throw consentPathError("EAGAIN", lock.path, "consent queue owner changed");
  }
  try {
    unlinkSync(lock.path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function removeAbandonedConsentArtifact(
  path: string,
  expected: ConsentArtifactOwners,
  now: number,
  retireBeforeRemoval: boolean,
): void {
  if (!consentOwnersAreAbandoned(expected, now)) return;
  const original = readConsentOwnerFile(path);
  if (!original || !sameConsentLockOwner(original.owner, expected.owner)) return;

  let removalPath = path;
  if (retireBeforeRemoval) {
    removalPath = `${path}.cleanup.${randomUUID()}`;
    try {
      renameSync(path, removalPath);
    } catch {
      return;
    }
    const retired = readConsentOwnerFile(removalPath);
    if (!retired || !sameConsentLockOwner(retired.owner, expected.owner)) return;
  }
  try { unlinkSync(removalPath); } catch { /* ambiguous cleanup remains inert */ }
}

function cleanupAbandonedConsentArtifacts(now: number): void {
  const configDirectory = dirname(TELEMETRY_PATH);
  const quarantinePrefix = consentQuarantinePrefix();
  const queueCleanupPrefix = consentQueueCleanupPrefix();
  let directory;
  let scanned = 0;
  let candidates = 0;
  try {
    directory = opendirSync(configDirectory);
    while (
      scanned < CONSENT_ARTIFACT_DIRECTORY_SCAN_LIMIT
      && candidates < CONSENT_ARTIFACT_CANDIDATE_LIMIT
    ) {
      const entry = directory.readSync();
      if (!entry) break;
      scanned += 1;
      const isQuarantine = entry.name.startsWith(quarantinePrefix);
      const isQueueCleanup = entry.name.startsWith(queueCleanupPrefix);
      if (!isQuarantine && !isQueueCleanup) continue;
      candidates += 1;
      const expected = parseConsentArtifactOwners(
        entry.name,
        isQuarantine ? quarantinePrefix : queueCleanupPrefix,
      );
      if (!expected) continue;
      removeAbandonedConsentArtifact(
        join(configDirectory, entry.name),
        expected,
        now,
        isQuarantine && !expected.cleanup,
      );
    }
  } catch {
    // Hygiene is conservative; queue/write-lock ownership remains authoritative.
  } finally {
    try { directory?.closeSync(); } catch { /* no path mutation on close failure */ }
  }
}

function recoverAbandonedConsentLock(now: number, reclaimer: ConsentLockOwner): boolean {
  const owner = readConsentLockOwner();
  if (!owner) return false;
  if (now - owner.createdAt < CONSENT_LOCK_STALE_AFTER_MS || !processIsDefinitelyDead(owner.pid)) {
    return false;
  }

  // The bakery election guarantees only one legitimate reclaimer. Moving the
  // authoritative name to an unpredictable same-parent regular-file claim is
  // atomic and never traverses a mutable child directory.
  const claimedPath = join(dirname(TELEMETRY_PATH), consentQuarantineName(reclaimer, owner));
  try {
    renameSync(`${TELEMETRY_PATH}.lock`, claimedPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }

  const claimed = readConsentOwnerFile(claimedPath);
  const stillAbandoned = claimed
    && sameConsentLockOwner(claimed.owner, owner)
    && Date.now() - claimed.owner.createdAt >= CONSENT_LOCK_STALE_AFTER_MS
    && processIsDefinitelyDead(claimed.owner.pid);
  if (!stillAbandoned) {
    if (claimed) {
      try {
        linkSync(claimedPath, `${TELEMETRY_PATH}.lock`);
        unlinkSync(claimedPath);
      } catch {
        // Preserve an unverified generation and fail this explicit mutation.
      }
    }
    throw consentLockBusyError(`${TELEMETRY_PATH}.lock`);
  }

  try { unlinkSync(claimedPath); } catch { /* exact stale single-file claim is inert */ }
  return true;
}

function acquireConsentLock(reclaimer: ConsentLockOwner): ConsentLock {
  ensureConfigDir();
  cleanupAbandonedConsentArtifacts(Date.now());
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
      descriptor = openSync(candidatePath, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(owner), "utf8");
      try { fchmodSync(descriptor, 0o600); } catch (error) {
        if (process.platform !== "win32") throw error;
      }
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      linkSync(candidatePath, lockPath);
      try { unlinkSync(candidatePath); } catch { /* a unique orphan is inert */ }
      return { owner };
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* retain the original acquisition error */ }
      }
      try { unlinkSync(candidatePath); } catch { /* no symlink target is followed */ }
      const currentTime = Date.now();
      if (errorCode(error) !== "EEXIST") throw error;
      if (recoverAbandonedConsentLock(currentTime, reclaimer)) continue;
      if (currentTime - startedAt >= CONSENT_LOCK_TIMEOUT_MS) throw error;
      Atomics.wait(consentWaitView, 0, 0, CONSENT_RETRY_MS);
    }
  }
}

function withConsentLock<T>(operation: () => T): T {
  const lockPath = `${TELEMETRY_PATH}.lock`;
  const queueLock = acquireConsentQueueLock();
  try {
    const lock = acquireConsentLock(queueLock.owner);
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
