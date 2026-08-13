import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
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

// Read the telemetry state, creating and persisting a fresh one on first run.
// Malformed files are treated as missing so a corrupted file can't crash the CLI.
function loadTelemetryStateUnlocked(): TelemetryState {
  if (!existsSync(TELEMETRY_PATH)) {
    const state = defaultState();
    writeTelemetryStateUnlocked(state);
    markFreshStateForFirstStart(state);
    return state;
  }
  try {
    const raw = JSON.parse(readFileSync(TELEMETRY_PATH, "utf-8")) as Partial<TelemetryState>;
    // Fill any missing fields to keep the file forward-compatible. Existing
    // boolean choices are always preserved; an older state without `enabled`
    // migrates to the default-on policy.
    const createdInstallIdentity = !(typeof raw.installId === "string" && raw.installId);
    const state: TelemetryState = {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      installId: typeof raw.installId === "string" && raw.installId ? raw.installId : randomUUID(),
      firstRunAt: typeof raw.firstRunAt === "string" && raw.firstRunAt
        ? raw.firstRunAt
        : new Date().toISOString(),
      revision: typeof raw.revision === "number"
        && Number.isSafeInteger(raw.revision)
        && raw.revision >= 0
        ? raw.revision
        : 0,
    };
    if (
      raw.enabled !== state.enabled ||
      raw.installId !== state.installId ||
      raw.firstRunAt !== state.firstRunAt ||
      raw.revision !== state.revision
    ) {
      writeTelemetryStateUnlocked(state);
    }
    if (createdInstallIdentity) markFreshStateForFirstStart(state);
    return state;
  } catch {
    const state = defaultState();
    writeTelemetryStateUnlocked(state);
    markFreshStateForFirstStart(state);
    return state;
  }
}

// Atomic write: .tmp + rename, same pattern as writeAccountsAtomic
function writeTelemetryStateUnlocked(state: TelemetryState): void {
  ensureConfigDir();
  const tmp = `${TELEMETRY_PATH}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, TELEMETRY_PATH);
}

const CONSENT_LOCK_TIMEOUT_MS = 2_000;
const CONSENT_RETRY_MS = 10;
const consentWaitBuffer = new SharedArrayBuffer(4);
const consentWaitView = new Int32Array(consentWaitBuffer);

function acquireConsentLock(): number {
  ensureConfigDir();
  const lockPath = `${TELEMETRY_PATH}.lock`;
  const startedAt = Date.now();
  while (true) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (error) {
      const code = typeof error === "object" && error !== null
        ? Object.getOwnPropertyDescriptor(error, "code")?.value
        : undefined;
      if (code !== "EEXIST" || Date.now() - startedAt >= CONSENT_LOCK_TIMEOUT_MS) throw error;
      Atomics.wait(consentWaitView, 0, 0, CONSENT_RETRY_MS);
    }
  }
}

function withConsentLock<T>(operation: () => T): T {
  const lockPath = `${TELEMETRY_PATH}.lock`;
  const lock = acquireConsentLock();
  try {
    return operation();
  } finally {
    closeSync(lock);
    try {
      unlinkSync(lockPath);
    } catch {
      // A missing lock is already released.
    }
  }
}

export function loadTelemetryState(): TelemetryState {
  return withConsentLock(loadTelemetryStateUnlocked);
}

// Serialize direct state writes with creation, migration, and explicit choices.
export function writeTelemetryState(state: TelemetryState): void {
  withConsentLock(() => writeTelemetryStateUnlocked(state));
}

/** Persist one explicit choice and advance its cross-process generation. */
export function updateTelemetryConsent(enabled: boolean): TelemetryState {
  return withConsentLock(() => {
    const current = loadTelemetryStateUnlocked();
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
