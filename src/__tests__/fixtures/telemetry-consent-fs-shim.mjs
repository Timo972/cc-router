import {
  appendFileSync as nativeAppendFileSync,
  chmodSync,
  closeSync,
  existsSync as nativeExistsSync,
  fsyncSync,
  linkSync as nativeLinkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync as nativeOpenSync,
  readFileSync as nativeReadFileSync,
  readdirSync,
  renameSync as nativeRenameSync,
  rmdirSync,
  unlinkSync as nativeUnlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readdirSync,
  rmdirSync,
  writeFileSync,
};

const barrier = process.env.CC_ROUTER_TEST_CONSENT_RACE_BARRIER;
const worker = process.env.CC_ROUTER_TEST_CONSENT_RACE_WORKER;
const telemetryPath = process.env.TELEMETRY_PATH;
const lockPath = telemetryPath ? `${telemetryPath}.lock` : undefined;
const auditPath = barrier ? join(barrier, "lock-audit.jsonl") : undefined;
const waitBuffer = new SharedArrayBuffer(4);
const waitView = new Int32Array(waitBuffer);
let authoritativeLockReads = 0;
let heldFirstStateRead = false;
let pausedValidation = false;
let signalledQueueEntry = false;

function enabled() {
  return process.env.NODE_ENV === "test" && barrier && worker && telemetryPath && lockPath;
}

function marker(name) {
  return join(barrier, `${worker}.${name}`);
}

function signal(name) {
  writeFileSync(marker(name), "", { flag: "wx", mode: 0o600 });
}

function waitFor(name) {
  const path = marker(name);
  const deadline = Date.now() + 5_000;
  while (!nativeExistsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    Atomics.wait(waitView, 0, 0, 5);
  }
}

function lockToken(path) {
  try {
    const parsed = JSON.parse(nativeReadFileSync(path, "utf8"));
    return typeof parsed.token === "string" ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

function audit(type, path) {
  if (!enabled() || !auditPath) return;
  nativeAppendFileSync(auditPath, `${JSON.stringify({ type, worker, token: lockToken(path) })}\n`);
}

function pauseAfterStaleValidation() {
  if (pausedValidation) return;
  pausedValidation = true;
  signal("validated-stale");
  waitFor("release-validation");
}

export function readFileSync(path, ...args) {
  const value = nativeReadFileSync(path, ...args);
  if (!enabled()) return value;
  if (String(path) === lockPath) {
    authoritativeLockReads += 1;
    if (authoritativeLockReads === 2 && worker !== "reclaimer") {
      pauseAfterStaleValidation();
    }
  } else if (String(path) === telemetryPath && worker === "first" && !heldFirstStateRead) {
    heldFirstStateRead = true;
    signal("read-state");
    waitFor("release-state");
  }
  return value;
}

export function openSync(path, ...args) {
  const descriptor = nativeOpenSync(path, ...args);
  if (
    enabled()
    && worker === "second"
    && !signalledQueueEntry
    && String(path).includes(`${lockPath}.queue`)
  ) {
    signalledQueueEntry = true;
    signal("queued");
  }
  return descriptor;
}

export function renameSync(oldPath, newPath) {
  if (
    enabled()
    && String(oldPath) === lockPath
    && String(newPath).includes(`${lockPath}.reclaim.`)
  ) {
    if (worker !== "reclaimer") pauseAfterStaleValidation();
    const result = nativeRenameSync(oldPath, newPath);
    if (worker === "reclaimer") {
      signal("renamed-quarantine");
      waitFor("release-reclaimer");
    }
    return result;
  }
  return nativeRenameSync(oldPath, newPath);
}

export function linkSync(existingPath, newPath) {
  nativeLinkSync(existingPath, newPath);
  if (String(newPath) === lockPath) audit("acquired", newPath);
}

export function unlinkSync(path) {
  if (String(path) === lockPath) audit("unlinked-authoritative", path);
  return nativeUnlinkSync(path);
}
