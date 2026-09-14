import { randomUUID } from "crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { ensureConfigDir } from "./directory.js";
import { TELEMETRY_PATH } from "./paths.js";

// Anonymous telemetry state persisted at ~/.cc-router/telemetry.json. The
// installId is a random UUID with no link to any user identity. The
// consentGeneration is a fresh UUID for every explicit telemetry on/off choice
// and lets already-running telemetry components latch off after any change.
export interface TelemetryState {
  enabled: boolean;
  installId: string;
  firstRunAt: string;
  consentGeneration: string;
}

export interface TelemetrySnapshot {
  state: TelemetryState;
  environmentDisabled: boolean;
  enabled: boolean;
}

/** Records written before consent generations existed keep this fixed marker. */
const LEGACY_GENERATION = "legacy";

let pendingFirstStartInstallId: string | undefined;
let firstStartClaimed = false;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function defaultState(): TelemetryState {
  return {
    enabled: true,
    installId: randomUUID(),
    firstRunAt: new Date().toISOString(),
    consentGeneration: randomUUID(),
  };
}

function parseState(raw: unknown): TelemetryState | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const candidate = raw as Partial<TelemetryState>;
  if (typeof candidate.installId !== "string" || candidate.installId.length === 0) return undefined;
  if (typeof candidate.firstRunAt !== "string" || candidate.firstRunAt.length === 0) return undefined;
  if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") return undefined;
  const hasGeneration = Object.prototype.hasOwnProperty.call(candidate, "consentGeneration");
  if (hasGeneration && (typeof candidate.consentGeneration !== "string" || !candidate.consentGeneration)) {
    return undefined;
  }
  return {
    enabled: candidate.enabled ?? true,
    installId: candidate.installId,
    firstRunAt: candidate.firstRunAt,
    // A complete pre-generation record is supported and never rewritten on read.
    consentGeneration: hasGeneration ? candidate.consentGeneration as string : LEGACY_GENERATION,
  };
}

/** undefined means missing or malformed (both repairable); an unreadable file throws. */
function readState(): TelemetryState | undefined {
  let raw: string;
  try {
    raw = readFileSync(TELEMETRY_PATH, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    // Fail closed: a record we cannot read may hold an opt-out, so it is
    // never replaced with an enabled default. Callers treat this as disabled.
    throw new Error(`Telemetry state is unreadable: ${TELEMETRY_PATH}`, { cause: error });
  }
  try {
    return parseState(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Publish atomically: nobody ever reads a partially written state file. */
function writeState(state: TelemetryState): void {
  ensureConfigDir();
  const candidate = `${TELEMETRY_PATH}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(candidate, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    renameSync(candidate, TELEMETRY_PATH);
  } catch (error) {
    const code = errorCode(error);
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
      try { unlinkSync(candidate); } catch { /* the unique candidate is inert */ }
      throw error;
    }
    renameSync(candidate, TELEMETRY_PATH);
  }
}

function createState(): TelemetryState {
  const state = defaultState();
  writeState(state);
  if (!firstStartClaimed) pendingFirstStartInstallId = state.installId;
  return state;
}

// Missing or malformed state is (re)initialized enabled; a supported legacy
// record is normalized in memory only; an unreadable file throws (see readState).
export function getTelemetrySnapshot(): TelemetrySnapshot {
  const state = readState() ?? createState();
  const environmentDisabled =
    process.env["DO_NOT_TRACK"] === "1" || process.env["CC_ROUTER_TELEMETRY"] === "0";
  return { state, environmentDisabled, enabled: !environmentDisabled && state.enabled };
}

/** Persist one explicit choice. The fresh UUID is the consent authority. */
export function updateTelemetryConsent(enabled: boolean): TelemetryState {
  const current = readState() ?? defaultState();
  const next: TelemetryState = { ...current, enabled, consentGeneration: randomUUID() };
  writeState(next);
  return next;
}

/** True only if the user has not opted out through any mechanism. */
export function isTelemetryEnabled(): boolean {
  try {
    return getTelemetrySnapshot().enabled;
  } catch {
    return false;
  }
}

export interface TelemetryConsentGate {
  getSnapshot(): TelemetrySnapshot | undefined;
  readonly latched: boolean;
}

/**
 * Bind a runtime to the consent generation observed at startup. Any later
 * generation means an explicit choice occurred, so the runtime permanently
 * disables itself and must be restarted before telemetry can resume.
 */
export function createTelemetryConsentGate(
  getSnapshot: () => TelemetrySnapshot = getTelemetrySnapshot,
  onLatch?: () => void,
): TelemetryConsentGate {
  let first: TelemetrySnapshot | undefined;
  try { first = getSnapshot(); } catch { first = undefined; }
  const acceptedGeneration = first?.state.consentGeneration;
  let latched = acceptedGeneration === undefined;
  let latchReported = false;

  const latch = (): undefined => {
    latched = true;
    if (latchReported) return undefined;
    latchReported = true;
    try { onLatch?.(); } catch { /* consent never depends on cleanup callbacks */ }
    return undefined;
  };

  return {
    get latched() { return latched; },
    getSnapshot() {
      if (latched) return undefined;
      let snapshot: TelemetrySnapshot;
      try { snapshot = getSnapshot(); } catch { return latch(); }
      if (snapshot.state.consentGeneration !== acceptedGeneration) return latch();
      return snapshot.enabled ? snapshot : undefined;
    },
  };
}

// Claim the one first-start event belonging to fresh state created by this
// process. Reading an existing state file in a later process never qualifies.
export function claimTelemetryFirstStart(): TelemetrySnapshot | undefined {
  const pending = pendingFirstStartInstallId;
  if (!pending) return undefined;
  pendingFirstStartInstallId = undefined;
  firstStartClaimed = true;
  try {
    const snapshot = getTelemetrySnapshot();
    return snapshot.state.installId === pending ? snapshot : undefined;
  } catch {
    return undefined;
  }
}
