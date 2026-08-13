import { register } from "node:module";
import { appendFileSync } from "node:fs";

register("./cli-start-cancellation-loader.mjs", import.meta.url);

process.once("beforeExit", async () => {
  const installRoot = process.env.CC_ROUTER_COMPILED_PACKAGE_ROOT;
  const marker = process.env.CC_ROUTER_TEST_CLI_RUNTIME_MARKER;
  if (!installRoot || !marker) return;
  const runtime = await import(`${installRoot}/node_modules/@timo972/cc-router/dist/telemetry/cli-runtime.js`);
  appendFileSync(marker, runtime.isCliTelemetryActive() ? "active\n" : "inactive\n");
});
