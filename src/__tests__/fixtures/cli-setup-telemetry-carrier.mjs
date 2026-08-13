const installRoot = process.env.CC_ROUTER_COMPILED_PACKAGE_ROOT;
const packageRoot = process.argv[2]
  ?? (installRoot ? `${installRoot}/node_modules/@timo972/cc-router` : undefined);
if (!packageRoot) throw new Error("compiled package root is required");

const runtime = await import(`${packageRoot}/dist/telemetry/cli-runtime.js`);
const diagnostics = await import(`${packageRoot}/dist/telemetry/setup-diagnostics.js`);

if (!runtime.startCliTelemetry("foreground")) {
  if (process.env.CC_ROUTER_EXPECT_TELEMETRY_DISABLED === "1") process.exit(0);
  throw new Error("CLI telemetry runtime did not start");
}

const attempts = [
  ["anthropic", "macos_keychain", ["credential_source_selection", "credential_read"]],
  ["anthropic", "claude_credentials_file", ["credential_source_selection", "credential_parse"]],
  ["anthropic", "manual_token", ["credential_source_selection", "token_validation"]],
  ["openai", "manual_token", ["credential_source_selection", "persistence"]],
  ["openai", "device_oauth", ["device_code_request", "authorization_polling", "token_exchange"]],
];

for (const [provider, method, stages] of attempts) {
  const attempt = diagnostics.createSetupAttempt({ provider, method });
  for (const stage of stages) attempt.stageCompleted(stage);
  attempt.succeeded();
}

const failed = diagnostics.createSetupAttempt({ provider: "openai", method: "device_oauth" });
const privateError = new Error("CLI_SETUP_PRIVATE_EXCEPTION");
privateError.stack = `Error: CLI_SETUP_PRIVATE_EXCEPTION\n    at fixture (${packageRoot}/dist/cli/index.js:1:1)`;
failed.failed(privateError, "token_exchange");

await runtime.shutdownCliTelemetryWithin(750);
