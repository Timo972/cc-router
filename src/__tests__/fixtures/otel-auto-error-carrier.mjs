import { writeFileSync } from "node:fs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const markerPath = requiredEnvironment("CC_ROUTER_TEST_CANDIDATE_MARKER");
const hostileMessage = requiredEnvironment("CC_ROUTER_TEST_HOSTILE_MESSAGE");
const hostileStackPath = requiredEnvironment("CC_ROUTER_TEST_HOSTILE_STACK_PATH");
const networkGuardMarker = requiredEnvironment("CC_ROUTER_TEST_NETWORK_GUARD_MARKER");
const originalOnEnd = BatchSpanProcessor.prototype.onEnd;

function withinDeadline(promise, context) {
  let deadline;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`${context} after 8000ms`)), 8_000);
    }),
  ]).finally(() => clearTimeout(deadline));
}

// Observe the exact candidate accepted by the production processor, immediately
// before its production reconstructive exporter receives the span.
BatchSpanProcessor.prototype.onEnd = function observeCandidate(span) {
  if (span.status.message === hostileMessage) {
    writeFileSync(markerPath, JSON.stringify({
      scope: span.instrumentationScope.name,
      status: span.status,
      events: span.events,
      attributes: span.attributes,
    }));
  }
  originalOnEnd.call(this, span);
};

const runtime = await import("../../../dist/telemetry/runtime.js");
if (!runtime.startProxyTelemetry("foreground")) {
  throw new Error("production telemetry runtime did not start");
}

let server;
try {
  const express = (await import("express")).default;
  const app = express();
  const carrierError = new Error(hostileMessage);
  carrierError.stack = [
    `Error: ${hostileMessage}`,
    `    at instrumentedHandler (${hostileStackPath}/private-handler.js:1:2)`,
  ].join("\n");
  app.post("/v1/responses", () => {
    throw carrierError;
  });
  app.use((_error, _request, response, _next) => response.status(500).end());
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolveListen, reject) => {
    server.once("listening", resolveListen);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("carrier server did not expose a port");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: "POST" });
  if (response.status !== 500) throw new Error(`unexpected carrier response ${response.status}`);
  await response.arrayBuffer();

  const fatalError = new Error(requiredEnvironment("CC_ROUTER_TEST_FATAL_MESSAGE"));
  fatalError.stack = [
    `Error: ${fatalError.message}`,
    `    at fatal (${process.cwd()}/dist/proxy/server.js:10:20)`,
  ].join("\n");
  let resolveFatal;
  let rejectFatal;
  const fatalCaptured = new Promise((resolve, reject) => {
    resolveFatal = resolve;
    rejectFatal = reject;
  });
  process.setUncaughtExceptionCaptureCallback(error => {
    if (error === fatalError) resolveFatal();
    else rejectFatal(error);
  });
  setImmediate(() => { throw fatalError; });
  try {
    await withinDeadline(fatalCaptured, "fatal exception capture callback did not run");
    await withinDeadline(
      globalThis.__ccRouterTestNetworkGuard.postHogCaptured,
      "fatal monitor did not send the immediate PostHog exception",
    );
  } finally {
    process.setUncaughtExceptionCaptureCallback(null);
  }

  let externalBlocked = false;
  try {
    await fetch("https://external.invalid/forbidden", { method: "POST" });
  } catch (error) {
    externalBlocked = String(error).includes("blocked before socket creation");
  }
  if (!externalBlocked) throw new Error("network guard allowed an external fetch");
  await runtime.flushProxyTelemetryWithin(8_000);
  writeFileSync(networkGuardMarker, JSON.stringify({
    blocked: globalThis.__ccRouterTestNetworkGuard.blocked,
    redirected: globalThis.__ccRouterTestNetworkGuard.redirected,
    fatalCaptured: true,
  }));
} finally {
  if (server) {
    await new Promise((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
      server.closeAllConnections();
    });
  }
  await runtime.shutdownProxyTelemetryWithin(8_000);
  BatchSpanProcessor.prototype.onEnd = originalOnEnd;
}
