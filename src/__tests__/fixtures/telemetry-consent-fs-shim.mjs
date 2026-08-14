import * as fs from "node:fs";
import { join } from "node:path";

export * from "node:fs";

const barrier = process.env.CC_ROUTER_TEST_CONSENT_PUBLISH_BARRIER;
const phase = process.env.CC_ROUTER_TEST_CONSENT_PUBLISH_PHASE;
const telemetryPath = process.env.TELEMETRY_PATH;
const waitBuffer = new SharedArrayBuffer(4);
const waitView = new Int32Array(waitBuffer);
let paused = false;

function enabled() {
  return process.env.NODE_ENV === "test" && barrier && phase && telemetryPath;
}

function signalAndWait() {
  if (!barrier || !phase || paused) return;
  paused = true;
  fs.writeFileSync(join(barrier, `${phase}.ready`), "", { flag: "wx", mode: 0o600 });
  const release = join(barrier, `${phase}.release`);
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(release)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${release}`);
    Atomics.wait(waitView, 0, 0, 5);
  }
}

export function readFileSync(path, ...args) {
  const result = fs.readFileSync(path, ...args);
  if (enabled() && String(path) === telemetryPath && phase === "after-read") signalAndWait();
  return result;
}

export function renameSync(oldPath, newPath) {
  if (enabled() && String(newPath) === telemetryPath && phase === "before-publish") signalAndWait();
  const result = fs.renameSync(oldPath, newPath);
  if (enabled() && String(newPath) === telemetryPath && phase === "after-publish") signalAndWait();
  return result;
}
