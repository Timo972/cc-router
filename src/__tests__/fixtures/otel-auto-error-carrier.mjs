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
const originalOnEnd = BatchSpanProcessor.prototype.onEnd;

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
  await runtime.flushProxyTelemetryWithin(8_000);
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
