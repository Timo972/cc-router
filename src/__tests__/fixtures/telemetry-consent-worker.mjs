import { existsSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
const telemetryPath = process.env.TELEMETRY_PATH;

if (!mode) throw new Error("missing worker mode");
if (!telemetryPath) throw new Error("missing TELEMETRY_PATH");
if (process.env.NODE_ENV === "test" && process.env.CC_ROUTER_TEST_PLATFORM === "win32") {
  Object.defineProperty(process, "platform", { value: "win32" });
}

const waitBuffer = new SharedArrayBuffer(4);
const waitView = new Int32Array(waitBuffer);

function waitForPath(path) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    Atomics.wait(waitView, 0, 0, 5);
  }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorCode(error) {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

const telemetry = await import("../../config/telemetry-state.ts");
const startedAt = Date.now();
try {
  if (mode === "initialize") {
    emit({ ok: true, elapsedMs: Date.now() - startedAt, state: telemetry.loadTelemetryState() });
  } else if (mode === "watch-gate") {
    const readyPath = process.argv[3];
    const releasePath = process.argv[4];
    if (!readyPath || !releasePath) throw new Error("missing gate barrier paths");
    const gate = telemetry.createTelemetryConsentGate();
    writeFileSync(readyPath, "", { flag: "wx", mode: 0o600 });
    waitForPath(releasePath);
    emit({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      enabled: gate.getSnapshot()?.enabled ?? false,
      latchedDisabled: gate.latchedDisabled,
      acceptedGeneration: gate.acceptedGeneration,
    });
  } else if (mode === "snapshot") {
    emit({ ok: true, elapsedMs: Date.now() - startedAt, snapshot: telemetry.getTelemetrySnapshot() });
  } else if (mode === "gate") {
    emit({ ok: true, elapsedMs: Date.now() - startedAt, enabled: telemetry.isTelemetryEnabled() });
  } else if (mode === "update") {
    const requested = process.argv[3] === "true";
    emit({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      requested,
      state: telemetry.updateTelemetryConsent(requested),
    });
  } else if (mode === "update-many") {
    const count = Number(process.argv[3]);
    const pauseMs = Number(process.argv[4] ?? "0");
    const states = [];
    for (let index = 0; index < count; index += 1) {
      states.push(telemetry.updateTelemetryConsent(index % 2 === 0));
      if (pauseMs > 0) Atomics.wait(waitView, 0, 0, pauseMs);
    }
    emit({ ok: true, elapsedMs: Date.now() - startedAt, states });
  } else if (mode === "read-many") {
    const count = Number(process.argv[3]);
    const snapshots = [];
    for (let index = 0; index < count; index += 1) {
      snapshots.push(telemetry.getTelemetrySnapshot());
    }
    emit({ ok: true, elapsedMs: Date.now() - startedAt, snapshots });
  } else {
    throw new Error(`unknown worker mode: ${mode}`);
  }
} catch (error) {
  emit({
    ok: false,
    elapsedMs: Date.now() - startedAt,
    error: { code: errorCode(error), name: error?.name, message: error?.message },
  });
}
