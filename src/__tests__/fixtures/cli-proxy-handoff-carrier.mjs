import { join } from "node:path";
import { pathToFileURL } from "node:url";

const installRoot = process.env.CC_ROUTER_COMPILED_PACKAGE_ROOT;
const packageRoot = installRoot
  ? join(installRoot, "node_modules", "@timo972", "cc-router")
  : process.argv[2];
if (!packageRoot) throw new Error("compiled package root is required");
const importFromPackage = relative => import(pathToFileURL(join(packageRoot, relative)).href);

const cliRuntime = await importFromPackage("dist/telemetry/cli-runtime.js");
const proxyRuntime = await importFromPackage("dist/telemetry/runtime.js");
const diagnostics = await importFromPackage("dist/telemetry/setup-diagnostics.js");
const facade = await importFromPackage("dist/telemetry/facade.js");
const { trace } = await import("@opentelemetry/api");
const tracerProviderBefore = trace.getTracerProvider();

if (!cliRuntime.startCliTelemetry("foreground")) {
  if (process.env.CC_ROUTER_EXPECT_TELEMETRY_DISABLED === "1") process.exit(0);
  throw new Error("fresh-start CLI telemetry runtime did not start");
}

const attempt = diagnostics.createSetupAttempt({
  provider: "anthropic",
  method: "manual_token",
});
attempt.stageCompleted("credential_source_selection");
attempt.stageCompleted("credential_read");
attempt.stageCompleted("credential_parse");
attempt.stageCompleted("token_validation");
attempt.succeeded();

await facade.handoffCliTelemetryToProxyWithin(750);
if (cliRuntime.isCliTelemetryActive()) throw new Error("CLI logger survived proxy handoff");
if (!proxyRuntime.startProxyTelemetry("foreground")) throw new Error("proxy telemetry did not start after handoff");
if (trace.getTracerProvider() === tracerProviderBefore) {
  throw new Error("proxy handoff did not replace the tracer provider");
}
const directSpan = trace.getTracer("cc-router").startSpan("proxy.request", {
  attributes: { "cc_router.operation": "proxy.request", "cc_router.runtime_mode": "foreground" },
});
if ((directSpan.spanContext().traceFlags & 1) === 0) throw new Error("direct proxy span was not sampled");
directSpan.end();

await facade.withTelemetrySpan("proxy.request", {
  runtimeMode: "foreground",
  route: "messages",
  requestSource: "cli",
  outcome: "complete",
}, async () => {
  const active = trace.getActiveSpan();
  if (!active) throw new Error("proxy handoff did not install an active tracer");
  if ((active.spanContext().traceFlags & 1) === 0) throw new Error("proxy handoff tracer was not sampled");
  facade.recordSafeLog({
    operation: "proxy.request",
    reason: "other",
    severity: "warn",
    outcome: "other",
  });
});

await proxyRuntime.flushProxyTelemetryWithin(1_000);
await facade.shutdownTelemetryWithin(1_000);
