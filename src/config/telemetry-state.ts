import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createHash, randomUUID } from "crypto";
import { dirname } from "path";
import { ensureConfigDir } from "./directory.js";
import { TELEMETRY_PATH } from "./paths.js";

// This module is imported by cli/bootstrap before the OTel ESM hook is
// registered. Keep its graph limited to Node built-ins and bootstrap-safe
// config primitives; general application modules belong after registration.

// Anonymous telemetry state persisted at ~/.cc-router/telemetry.json.
// The installId is a random UUID with no link to any user identity. The
// consentGeneration is a fresh UUID for every explicit telemetry on/off choice
// and lets already-running telemetry components latch off after any change.
export interface TelemetryState {
  enabled: boolean;
  installId: string;
  firstRunAt: string;
  consentGeneration: string;
  /** Informational only. Consent safety never depends on this counter. */
  revision: number;
}

export interface TelemetrySnapshot {
  state: TelemetryState;
  environmentDisabled: boolean;
  enabled: boolean;
}

type TelemetryStateInput = Omit<TelemetryState, "consentGeneration" | "revision"> & {
  consentGeneration?: string;
  revision?: number;
};

interface NormalizedTelemetryState {
  state: TelemetryState;
  legacy: boolean;
}

type StateRead =
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "state"; normalized: NormalizedTelemetryState };

let pendingFirstStartInstallId: string | undefined;
let firstStartClaimedByProcess = false;
const renameRetryWait = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_RENAME_RETRY_MS = 1_000;

function uuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function markFreshStateForFirstStart(state: TelemetryState): void {
  if (!firstStartClaimedByProcess) pendingFirstStartInstallId = state.installId;
}

function defaultState(): TelemetryState {
  return {
    enabled: true,
    installId: randomUUID(),
    firstRunAt: new Date().toISOString(),
    consentGeneration: randomUUID(),
    revision: 0,
  };
}

function legacyConsentGeneration(installId: string, firstRunAt: string, revision: number): string {
  const digest = createHash("sha256")
    .update("cc-router:legacy-consent-generation:v1\0")
    .update(installId)
    .update("\0")
    .update(firstRunAt)
    .update("\0")
    .update(String(revision))
    .digest("hex");
  const variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${
    digest.slice(17, 20)
  }-${digest.slice(20, 32)}`;
}

function normalizeTelemetryState(raw: unknown): NormalizedTelemetryState | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const candidate = raw as Partial<TelemetryState>;
  const installId = typeof candidate.installId === "string" && candidate.installId
    ? candidate.installId
    : undefined;
  const firstRunAt = typeof candidate.firstRunAt === "string" && candidate.firstRunAt
    ? candidate.firstRunAt
    : undefined;
  const hasConsentGeneration = Object.prototype.hasOwnProperty.call(candidate, "consentGeneration");
  const generation = uuid(candidate.consentGeneration);
  const revision = typeof candidate.revision === "number"
    && Number.isSafeInteger(candidate.revision)
    && candidate.revision >= 0
    ? candidate.revision
    : 0;

  // A complete pre-generation record is a supported legacy state. Arbitrary
  // partial current records fail closed on normal reads and are repaired only
  // by explicit initialization/update APIs.
  const legacy = !hasConsentGeneration
    && installId !== undefined
    && firstRunAt !== undefined
    && (candidate.enabled === undefined || typeof candidate.enabled === "boolean")
    && (candidate.revision === undefined || revision === candidate.revision);
  const current = generation !== undefined
    && installId !== undefined
    && firstRunAt !== undefined
    && typeof candidate.enabled === "boolean"
    && revision === candidate.revision;
  if (!legacy && !current) return undefined;

  const state: TelemetryState = {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
    installId,
    firstRunAt,
    consentGeneration: generation ?? legacyConsentGeneration(installId, firstRunAt, revision),
    revision,
  };
  return {
    state,
    legacy: !current,
  };
}

function readTelemetryState(): StateRead {
  let serialized: string;
  try {
    serialized = readFileSync(TELEMETRY_PATH, "utf8");
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "malformed" };
  }
  try {
    const normalized = normalizeTelemetryState(JSON.parse(serialized));
    return normalized ? { kind: "state", normalized } : { kind: "malformed" };
  } catch {
    return { kind: "malformed" };
  }
}

function writeCandidate(path: string, state: TelemetryState): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(state, null, 2), "utf8");
    try { fchmodSync(descriptor, 0o600); } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* retain the original error */ }
    }
    try { unlinkSync(path); } catch { /* clean only this operation's unique candidate */ }
    throw error;
  }
}

function fsyncConfigDirectoryBestEffort(): void {
  try {
    const descriptor = openSync(dirname(TELEMETRY_PATH), "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  } catch {
    // The state publication is still atomic where directory fsync is unsupported.
  }
}

function renamePublishedState(candidate: string): void {
  const retryUntil = Date.now() + WINDOWS_RENAME_RETRY_MS;
  let retryDelayMs = 0;
  while (true) {
    try {
      renameSync(candidate, TELEMETRY_PATH);
      return;
    } catch (error) {
      const code = errorCode(error);
      const retryable = process.platform === "win32"
        && (code === "EACCES" || code === "EPERM" || code === "EBUSY")
        && Date.now() < retryUntil;
      if (!retryable) throw error;
      Atomics.wait(renameRetryWait, 0, 0, retryDelayMs);
      retryDelayMs = Math.min(100, retryDelayMs + 10);
    }
  }
}

function publishTelemetryState(state: TelemetryState): void {
  ensureConfigDir();
  const candidate = `${TELEMETRY_PATH}.${process.pid}.${randomUUID()}.tmp`;
  writeCandidate(candidate, state);
  try {
    renamePublishedState(candidate);
    fsyncConfigDirectoryBestEffort();
  } catch (error) {
    try { unlinkSync(candidate); } catch { /* renamed or already absent */ }
    throw error;
  }
}

function invalidStateError(): Error {
  return new Error(`Telemetry state is malformed: ${TELEMETRY_PATH}`);
}

/**
 * Publish the first complete record without replacement. Every initializer
 * writes and fsyncs its own candidate; one hard-link publication wins and all
 * losers read that authoritative winner. No incomplete final file is visible.
 */
function initializeAbsentState(): TelemetryState {
  ensureConfigDir();
  const state = defaultState();
  const candidate = `${TELEMETRY_PATH}.${process.pid}.${randomUUID()}.init.tmp`;
  writeCandidate(candidate, state);
  try {
    linkSync(candidate, TELEMETRY_PATH);
    try { unlinkSync(candidate); } catch { /* the unique orphan is inert */ }
    fsyncConfigDirectoryBestEffort();
    markFreshStateForFirstStart(state);
    return state;
  } catch (error) {
    try { unlinkSync(candidate); } catch { /* clean only our unique candidate */ }
    if (errorCode(error) !== "EEXIST") throw error;
    const winner = readTelemetryState();
    if (winner.kind !== "state" || winner.normalized.legacy) throw invalidStateError();
    return winner.normalized.state;
  }
}

function initializeOrRepairState(read: Extract<StateRead, { kind: "missing" | "malformed" }>): TelemetryState {
  if (read.kind === "missing") return initializeAbsentState();
  const state = defaultState();
  publishTelemetryState(state);
  markFreshStateForFirstStart(state);
  return state;
}

/** Initialize or explicitly repair telemetry state; legacy reads stay side-effect-free. */
export function loadTelemetryState(): TelemetryState {
  const read = readTelemetryState();
  return read.kind === "state" ? read.normalized.state : initializeOrRepairState(read);
}

/** Atomic direct state publication retained for the configuration boundary. */
export function writeTelemetryState(input: TelemetryStateInput): void {
  const normalized = normalizeTelemetryState(input);
  const state = normalized?.state ?? {
    ...input,
    consentGeneration: randomUUID(),
    revision: typeof input.revision === "number"
      && Number.isSafeInteger(input.revision)
      && input.revision >= 0
      ? input.revision
      : 0,
  };
  publishTelemetryState(state);
}

/**
 * Persist one explicit choice. The fresh UUID is the consent authority;
 * revision is only an informational best-effort counter. Concurrent writers
 * are linearized by the final successful same-directory rename.
 */
export function updateTelemetryConsent(enabled: boolean): TelemetryState {
  const read = readTelemetryState();
  const current = read.kind === "missing"
    ? initializeAbsentState()
    : read.kind === "state"
      ? read.normalized.state
      : defaultState();
  const next: TelemetryState = {
    ...current,
    enabled,
    consentGeneration: randomUUID(),
    revision: current.revision < Number.MAX_SAFE_INTEGER ? current.revision + 1 : current.revision,
  };
  publishTelemetryState(next);
  return next;
}

// Returns persisted state with the one authoritative effective value. Current
// complete records are read without mutation. Missing state is initialized,
// supported legacy state is normalized without mutation, and malformed/partial
// state fails closed.
export function getTelemetrySnapshot(): TelemetrySnapshot {
  const read = readTelemetryState();
  const state = read.kind === "missing"
    ? initializeAbsentState()
    : read.kind === "state"
      ? read.normalized.state
      : (() => { throw invalidStateError(); })();
  const environmentDisabled =
    process.env["DO_NOT_TRACK"] === "1" || process.env["CC_ROUTER_TELEMETRY"] === "0";
  return { state, environmentDisabled, enabled: !environmentDisabled && state.enabled };
}

export interface TelemetryConsentGate {
  readonly acceptedGeneration: string | undefined;
  readonly latchedDisabled: boolean;
  getSnapshot(): TelemetrySnapshot | undefined;
}

/**
 * Bind a runtime to the consent generation observed at startup. Any later
 * generation means an explicit choice occurred, so the runtime permanently
 * disables itself and must be restarted before telemetry can resume.
 */
export function createTelemetryConsentGate(
  getSnapshot: () => TelemetrySnapshot = getTelemetrySnapshot,
  initialSnapshot?: TelemetrySnapshot,
  onGenerationMismatch?: () => void,
): TelemetryConsentGate {
  let first = initialSnapshot;
  if (!first) {
    try { first = getSnapshot(); } catch { first = undefined; }
  }
  const acceptedGeneration = first?.state.consentGeneration;
  let latchedDisabled = first === undefined || acceptedGeneration === undefined;
  let mismatchReported = false;

  const disable = (): void => {
    latchedDisabled = true;
    if (mismatchReported) return;
    mismatchReported = true;
    try { onGenerationMismatch?.(); } catch {
      // Consent enforcement never depends on cleanup callbacks.
    }
  };

  return {
    acceptedGeneration,
    get latchedDisabled() { return latchedDisabled; },
    getSnapshot(): TelemetrySnapshot | undefined {
      if (latchedDisabled) return undefined;
      try {
        const snapshot = getSnapshot();
        if (snapshot.state.consentGeneration !== acceptedGeneration) {
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

// Returns true only if the user has not opted out through any mechanism.
export function isTelemetryEnabled(): boolean {
  try { return getTelemetrySnapshot().enabled; } catch { return false; }
}
