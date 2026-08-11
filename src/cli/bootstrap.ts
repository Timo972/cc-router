#!/usr/bin/env node
import { register } from "node:module";
import { getTelemetrySnapshot } from "../config/telemetry.js";

function shouldPrepareProxyTelemetry(argv: readonly string[]): boolean {
  if (argv[2] !== "start") return false;
  try {
    return getTelemetrySnapshot().enabled;
  } catch {
    return false;
  }
}

const proxyTelemetryPrepared = shouldPrepareProxyTelemetry(process.argv);
if (proxyTelemetryPrepared) {
  try {
    register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  } catch {
    // Instrumentation is strictly best effort; CLI startup must continue.
  }
}

try {
  const { runCli } = await import("./index.js");
  await runCli();
} finally {
  const commandExitCode = process.exitCode;
  if (proxyTelemetryPrepared) {
    try {
      const { flushProxyTelemetryWithin } = await import("../telemetry/runtime.js");
      await flushProxyTelemetryWithin(250);
    } catch {
      // A flush failure must not change the command's exit status.
    }
  }
  process.exitCode = commandExitCode;
}
