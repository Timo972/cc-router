import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[2];
const evidencePath = process.argv[3];
if (!packageRoot || !evidencePath) throw new Error("synthetic child requires package root and evidence path");

const sourceSelfTest = process.env.CC_ROUTER_EU_SYNTHETIC_SOURCE_SELF_TEST === "1"
  && process.env.NODE_ENV === "test";
const modulePath = relative => sourceSelfTest
  ? `src/${relative}.ts`
  : `dist/${relative}.js`;
const importFromPackage = relative => import(pathToFileURL(`${packageRoot}/${modulePath(relative)}`).href);
const [{ startCliTelemetry }, diagnostics, facade, { sanitizeException }] = await Promise.all([
  importFromPackage("telemetry/cli-runtime"),
  importFromPackage("telemetry/setup-diagnostics"),
  importFromPackage("telemetry/facade"),
  importFromPackage("telemetry/privacy"),
]);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));

function writeEvidence(contents) {
  const before = lstatSync(evidencePath);
  if (!before.isFile()) throw new Error("evidence path is not a regular file");
  chmodSync(evidencePath, 0o600);
  writeFileSync(evidencePath, contents, { flag: "w", mode: 0o600 });
  chmodSync(evidencePath, 0o600);
  if ((lstatSync(evidencePath).mode & 0o777) !== 0o600) {
    throw new Error("evidence file permissions changed during synthetic validation");
  }
}

if (!startCliTelemetry("foreground")) throw new Error("synthetic CLI telemetry runtime did not start");

const methods = [
  { provider: "anthropic", method: "macos_keychain", stages: ["credential_source_selection", "credential_read", "credential_parse", "token_validation", "persistence"], reason: "not_found" },
  { provider: "anthropic", method: "claude_credentials_file", stages: ["credential_source_selection", "credential_read", "credential_parse", "token_validation", "persistence"], reason: "malformed_credentials" },
  { provider: "anthropic", method: "manual_token", stages: ["credential_source_selection", "credential_read", "credential_parse", "token_validation", "persistence"], reason: "invalid_token" },
  { provider: "openai", method: "manual_token", stages: ["credential_source_selection", "credential_read", "credential_parse", "token_validation", "persistence"], reason: "unauthorized" },
  { provider: "openai", method: "device_oauth", stages: ["credential_source_selection", "device_code_request", "authorization_polling", "token_exchange", "access_token_parse", "token_validation", "persistence"], reason: "timeout" },
];

evidence.setupAttempts = [];
for (const entry of methods) {
  const successful = diagnostics.createSetupAttempt({ provider: entry.provider, method: entry.method });
  for (const stage of entry.stages) successful.stageCompleted(stage);
  successful.succeeded();

  const failed = diagnostics.createSetupAttempt({ provider: entry.provider, method: entry.method });
  failed.failed(new diagnostics.SetupDiagnosticError("synthetic closed failure", {
    stage: "failure",
    reason: entry.reason,
    expected: true,
  }), "failure");
  evidence.setupAttempts.push({
    provider: entry.provider,
    method: entry.method,
    successDiagnosticId: successful.diagnosticId,
    failureDiagnosticId: failed.diagnosticId,
    failureReason: entry.reason,
  });
}

const cancelled = diagnostics.createSetupAttempt({ provider: "openai", method: "device_oauth" });
cancelled.cancelled();
facade.recordApplicationStart();
facade.recordProxyStarted(1);

const exceptionContext = {
  category: "setup",
  provider: "openai",
  setupStage: "token_exchange",
  reason: "other",
};
const exceptions = [];
for (const message of [evidence.canaries.exceptionOne, evidence.canaries.exceptionTwo]) {
  const attempt = diagnostics.createSetupAttempt({ provider: "openai", method: "device_oauth" });
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at synthetic (${packageRoot}/${modulePath("telemetry/facade")}:1:1)`;
  Object.defineProperty(error, "privateCandidate", {
    value: evidence.canaries.arbitraryProperty,
    enumerable: true,
  });
  attempt.failed(error, "token_exchange");
  const safe = sanitizeException(error, exceptionContext, {
    installationId: evidence.installationId,
    diagnosticId: attempt.diagnosticId,
  }, { projectRoot: packageRoot });
  if (!safe) throw new Error("closed contract rejected synthetic exception");
  exceptions.push({ diagnosticId: attempt.diagnosticId, fingerprint: safe.fingerprint });
}
if (exceptions[0].fingerprint !== exceptions[1].fingerprint) {
  throw new Error("repeated safe exception context did not produce one fingerprint");
}
evidence.exceptions = exceptions;
evidence.finishedAt = new Date().toISOString();
writeEvidence(`${JSON.stringify(evidence, null, 2)}\n`);
await facade.shutdownTelemetryWithin(2_000);
