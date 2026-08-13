import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[2];
const evidencePath = process.argv[3];
if (!packageRoot || !evidencePath) throw new Error("synthetic child requires package root and evidence path");

const sourceSelfTest = process.env.CC_ROUTER_EU_SYNTHETIC_SOURCE_SELF_TEST === "1"
  && process.env.NODE_ENV === "test";
const importFromPackage = relative => import(pathToFileURL(`${packageRoot}/${relative}`).href);
const { reconstructAnalyticsEvent, sanitizeException } = await importFromPackage(
  sourceSelfTest ? "src/telemetry/privacy.ts" : "dist/telemetry/privacy.js",
);
const { createPostHogTelemetryClient } = await importFromPackage(
  sourceSelfTest ? "src/telemetry/posthog-client.ts" : "dist/telemetry/posthog-client.js",
);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const client = createPostHogTelemetryClient();
const runtime = {
  serviceVersion: evidence.packageVersion,
  osFamily: "other",
  runtimeMode: "foreground",
  accountPoolSize: 1,
};

async function analytics(event, properties, diagnosticId) {
  const safe = reconstructAnalyticsEvent({
    event,
    properties: { ...properties, forbiddenCandidate: evidence.canaries.arbitraryProperty },
  }, {
    installationId: evidence.installationId,
    ...(diagnosticId ? { diagnosticId } : {}),
  });
  if (!safe) throw new Error(`closed contract rejected ${event}`);
  await client.captureAnalyticsImmediate(safe);
}

const methods = [
  { provider: "anthropic", method: "macos_keychain", stages: ["credential_source_selection", "credential_read", "credential_parse", "token_validation", "persistence"], reason: "not_found" },
  { provider: "anthropic", method: "claude_credentials_file", stages: ["credential_source_selection", "credential_read", "credential_parse", "token_validation", "persistence"], reason: "malformed_credentials" },
  { provider: "anthropic", method: "manual_token", stages: ["credential_source_selection", "credential_read", "credential_parse", "token_validation", "persistence"], reason: "invalid_token" },
  { provider: "openai", method: "manual_token", stages: ["credential_source_selection", "credential_read", "credential_parse", "token_validation", "persistence"], reason: "unauthorized" },
  { provider: "openai", method: "device_oauth", stages: ["credential_source_selection", "device_code_request", "authorization_polling", "token_exchange", "access_token_parse", "token_validation", "persistence"], reason: "timeout" },
];

evidence.setupAttempts = [];
for (const entry of methods) {
  const successId = randomUUID();
  const base = { ...runtime, provider: entry.provider, method: entry.method, durationBucket: "under_1s" };
  await analytics("account_setup.started", { ...base, stage: "attempt_start" }, successId);
  for (const stage of entry.stages) {
    await analytics("account_setup.stage_completed", { ...base, stage }, successId);
  }
  await analytics("account_setup.succeeded", { ...base, stage: "success" }, successId);

  const failureId = randomUUID();
  await analytics("account_setup.started", { ...base, stage: "attempt_start" }, failureId);
  await analytics("account_setup.failed", { ...base, stage: "failure", reason: entry.reason }, failureId);
  evidence.setupAttempts.push({
    provider: entry.provider,
    method: entry.method,
    successDiagnosticId: successId,
    failureDiagnosticId: failureId,
    failureReason: entry.reason,
  });
}

const cancellationId = randomUUID();
await analytics("account_setup.cancelled", {
  ...runtime,
  provider: "openai",
  method: "device_oauth",
  stage: "cancellation",
  reason: "user_cancelled",
  durationBucket: "under_1s",
}, cancellationId);

await analytics("app.first_start", runtime);
await analytics("proxy.started", runtime);
await analytics("proxy.heartbeat", runtime);

const exceptionContext = {
  category: "runtime",
  reason: "other",
  operation: "proxy.request",
  provider: "openai",
  runtimeMode: "foreground",
};
const exceptions = [];
for (const message of [evidence.canaries.exceptionOne, evidence.canaries.exceptionTwo]) {
  const diagnosticId = randomUUID();
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at synthetic (${packageRoot}/dist/telemetry/facade.js:1:1)`;
  Object.defineProperty(error, "privateCandidate", { value: evidence.canaries.arbitraryProperty, enumerable: true });
  const safe = sanitizeException(error, exceptionContext, {
    installationId: evidence.installationId,
    diagnosticId,
  }, { projectRoot: packageRoot });
  if (!safe) throw new Error("closed contract rejected synthetic exception");
  await client.captureExceptionImmediate(safe);
  exceptions.push({ diagnosticId, fingerprint: safe.fingerprint });
}
if (exceptions[0].fingerprint !== exceptions[1].fingerprint) {
  throw new Error("repeated safe exception context did not produce one fingerprint");
}
evidence.exceptions = exceptions;
evidence.finishedAt = new Date().toISOString();
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
await client.flushWithin(2_000);
await client.shutdownWithin(2_000);
