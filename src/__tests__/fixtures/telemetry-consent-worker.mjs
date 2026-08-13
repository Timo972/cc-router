import { randomUUID } from "node:crypto";
import { fsyncSync, openSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
const telemetryPath = process.env.TELEMETRY_PATH;

if (!mode) throw new Error("missing worker mode");
if (!telemetryPath) throw new Error("missing TELEMETRY_PATH");

const waitBuffer = new SharedArrayBuffer(4);
const waitView = new Int32Array(waitBuffer);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorCode(error) {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

if (mode === "hold-lock") {
  const owner = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    createdAt: Date.now(),
  };
  const descriptor = openSync(`${telemetryPath}.lock`, "wx", 0o600);
  writeFileSync(descriptor, JSON.stringify(owner), "utf8");
  fsyncSync(descriptor);
  emit({ ok: true, owner });
  setInterval(() => undefined, 1_000);
} else {
  const telemetry = await import("../../config/telemetry-state.ts");
  const startedAt = Date.now();
  try {
    if (mode === "snapshot") {
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
}
