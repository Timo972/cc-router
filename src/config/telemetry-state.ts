import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
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
  };
}

// Read the telemetry state, creating and persisting a fresh one on first run.
// Malformed files are treated as missing so a corrupted file can't crash the CLI.
export function loadTelemetryState(): TelemetryState {
  if (!existsSync(TELEMETRY_PATH)) {
    const state = defaultState();
    writeTelemetryState(state);
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
    };
    if (
      raw.enabled !== state.enabled ||
      raw.installId !== state.installId ||
      raw.firstRunAt !== state.firstRunAt
    ) {
      writeTelemetryState(state);
    }
    if (createdInstallIdentity) markFreshStateForFirstStart(state);
    return state;
  } catch {
    const state = defaultState();
    writeTelemetryState(state);
    markFreshStateForFirstStart(state);
    return state;
  }
}

// Atomic write: .tmp + rename, same pattern as writeAccountsAtomic
export function writeTelemetryState(state: TelemetryState): void {
  ensureConfigDir();
  const tmp = TELEMETRY_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, TELEMETRY_PATH);
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
