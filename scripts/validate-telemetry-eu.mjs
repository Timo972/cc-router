import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guardPath = join(repositoryRoot, "scripts", "telemetry-eu-network-guard.mjs");
const syntheticChildPath = join(repositoryRoot, "scripts", "telemetry-eu-synthetic-child.mjs");
const approvalPhrase = "I_UNDERSTAND_SYNTHETIC_TELEMETRY_WILL_BE_SENT";

const dryRunPlan = `
CC-Router personal EU telemetry validation

DRY RUN — no network requests were made.

This harness installs and executes the exact packed artifact with synthetic data only.
Approved remote ingestion paths:
  https://eu.i.posthog.com/batch/
  https://eu.i.posthog.com/i/v1/traces
  https://eu.i.posthog.com/i/v1/logs

Provider traffic is redirected to a literal 127.0.0.1 fixture. All other remote
fetch, HTTP(S), and socket attempts are blocked by a preload guard.

Synthetic setup funnels:
  anthropic/macos_keychain
  anthropic/claude_credentials_file
  anthropic/manual_token
  openai/manual_token
  openai/device_oauth

The live run also emits a deterministic sampled packaged-ESM waterfall with a
correlated safe runtime log. The packed log-only CLI runtime drives real setup
attempt helpers for each method, producing account.setup.diagnostic logs,
closed funnels, repeated sanitized exceptions from setup, and runtime-generated
canaries for absence searches.

Before live mode, use project read/config access to enable Logs PII scrubbing,
confirm the personal EU cc-router project, copy its public project token hash,
and record the current Person count. Never select a Droidrun or other project.

Invocation:
  CC_ROUTER_EU_LIVE_VALIDATION=${approvalPhrase} \\
  CC_ROUTER_EU_PROJECT_CONFIGURED=personal-eu-cc-router \\
  CC_ROUTER_EU_PROJECT_TOKEN_SHA256=<sha256-of-public-project-token> \\
  node scripts/validate-telemetry-eu.mjs --live --tarball /absolute/path/to/package.tgz
`;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function offlinePostHogPins() {
  const postHogPackageJson = realpathSync(join(repositoryRoot, "node_modules", "posthog-node", "package.json"));
  const postHogPackage = JSON.parse(readFileSync(postHogPackageJson, "utf8"));
  const requireFromPostHog = createRequire(postHogPackageJson);
  const versionFor = entry => {
    let directory = dirname(entry);
    while (directory !== dirname(directory)) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")).version;
      directory = dirname(directory);
    }
    throw new Error(`cannot resolve package version for ${entry}`);
  };
  return [
    `posthog-node@${postHogPackage.version}`,
    `@posthog/core@${versionFor(requireFromPostHog.resolve("@posthog/core"))}`,
    `@posthog/types@${versionFor(requireFromPostHog.resolve("@posthog/types"))}`,
  ];
}

function listen(server) {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePort(server.address().port);
    });
  });
}

function close(server) {
  return new Promise(resolveClose => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
}

function reservePort() {
  const server = createServer();
  return listen(server).then(async port => {
    await close(server);
    return port;
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("validation child timed out")), timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      code === 0 ? resolveExit() : reject(new Error(`validation child exited ${String(code)} (${String(signal)})`));
    });
  });
}

async function waitForProxy(port, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`packaged proxy exited early\n${output()}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/cc-router/health`)).ok) return;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`packaged proxy was not ready\n${output()}`);
}

function scanPackagedArtifact(packageRoot) {
  for (const required of ["dist/cli/bootstrap.js", "docs/telemetry.md", "docs/security.md", "docs/troubleshooting.md"]) {
    if (!existsSync(join(packageRoot, required))) throw new Error(`packed artifact is missing ${required}`);
  }
  if (existsSync(join(packageRoot, "dist", "utils", "telemetry.js"))) {
    throw new Error("packed artifact contains legacy dist/utils/telemetry.js");
  }
  const javascript = readdirSync(join(packageRoot, "dist"), { recursive: true, encoding: "utf8" })
    .filter(path => path.endsWith(".js"))
    .map(path => readFileSync(join(packageRoot, "dist", path), "utf8"))
    .join("\n");
  if (/aptabase/i.test(javascript)) throw new Error("packed artifact contains legacy telemetry code");
}

function guardEnvironment(providerOrigin, networkLog) {
  return {
    CC_ROUTER_EU_GUARD_MODE: "validation",
    CC_ROUTER_EU_LOOPBACK_PROVIDER_ORIGIN: providerOrigin,
    CC_ROUTER_EU_NETWORK_LOG: networkLog,
    NODE_OPTIONS: `--import=${pathToFileURL(guardPath).href}`,
  };
}

function assertMode(path, expected, kind) {
  const stat = lstatSync(path);
  if ((stat.mode & 0o777) !== expected) {
    throw new Error(`${kind} permissions must be ${expected.toString(8)}`);
  }
  if (kind === "evidence directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`${kind} has the wrong filesystem type`);
  }
}

function createEvidenceRoot(override) {
  if (!override) {
    const created = mkdtempSync(join(tmpdir(), "cc-router-eu-validation-evidence-"));
    chmodSync(created, 0o700);
    assertMode(created, 0o700, "evidence directory");
    return created;
  }
  const target = resolve(override);
  if (existsSync(target)) throw new Error("evidence target must not already exist");
  mkdirSync(target, { recursive: false, mode: 0o700 });
  chmodSync(target, 0o700);
  assertMode(target, 0o700, "evidence directory");
  return target;
}

function secureWrite(path, contents, firstWrite = false) {
  writeFileSync(path, contents, { flag: firstWrite ? "wx" : "w", mode: 0o600 });
  chmodSync(path, 0o600);
  assertMode(path, 0o600, "evidence file");
}

function readNetworkEntries(networkLog) {
  return existsSync(networkLog)
    ? readFileSync(networkLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    : [];
}

function assertNoBlockedAttempts(networkLog) {
  const entries = readNetworkEntries(networkLog);
  if (entries.some(entry => String(entry.kind).includes("blocked"))) {
    throw new Error("network guard recorded a blocked egress attempt");
  }
  return entries;
}

if (process.argv.includes("--test-audit-network-log")) {
  if (process.env.NODE_ENV !== "test") throw new Error("network-log audit mode is test-only");
  const path = argument("--network-log");
  if (!path) throw new Error("test network-log audit requires --network-log");
  assertNoBlockedAttempts(resolve(path));
  process.exit(0);
}

if (!process.argv.includes("--live")) {
  process.stdout.write(dryRunPlan);
  process.exit(0);
}

if (process.env.CC_ROUTER_EU_LIVE_VALIDATION !== approvalPhrase) {
  throw new Error(`live mode requires CC_ROUTER_EU_LIVE_VALIDATION=${approvalPhrase}`);
}
if (process.env.CC_ROUTER_EU_PROJECT_CONFIGURED !== "personal-eu-cc-router") {
  throw new Error("live mode requires CC_ROUTER_EU_PROJECT_CONFIGURED=personal-eu-cc-router after PII/profile/GeoIP review");
}
if (!/^[0-9a-f]{64}$/i.test(process.env.CC_ROUTER_EU_PROJECT_TOKEN_SHA256 ?? "")) {
  throw new Error("live mode requires CC_ROUTER_EU_PROJECT_TOKEN_SHA256 for the selected personal project public token");
}
if ((process.env.NODE_OPTIONS ?? "").trim() !== "") {
  throw new Error("live mode rejects non-empty inherited NODE_OPTIONS");
}

const tarballArgument = argument("--tarball");
if (!tarballArgument) throw new Error("live mode requires --tarball /absolute/path/to/package.tgz");
const tarball = resolve(tarballArgument);
if (!tarballArgument.startsWith("/") || !existsSync(tarball) || !lstatSync(tarball).isFile() || !tarball.endsWith(".tgz")) {
  throw new Error("--tarball must name an existing absolute .tgz regular file");
}

const evidenceRoot = createEvidenceRoot(process.env.CC_ROUTER_EU_EVIDENCE_DIR);
const evidencePath = join(evidenceRoot, "evidence.json");
const networkLog = join(evidenceRoot, "network.jsonl");
const installationId = randomUUID();
const canaryPrefix = `ccr-${randomUUID()}`;
const evidence = {
  startedAt: new Date().toISOString(),
  installationId,
  canaries: {
    prompt: `${canaryPrefix}-prompt`,
    bearer: `${canaryPrefix}-bearer`,
    account: `${canaryPrefix}-account`,
    session: `${canaryPrefix}-session`,
    email: `${canaryPrefix}@invalid.example`,
    hostname: `${canaryPrefix}.invalid`,
    query: `${canaryPrefix}-query`,
    path: `/private/${canaryPrefix}/fixture`,
    providerBody: `${canaryPrefix}-provider-body`,
    exceptionOne: `${canaryPrefix}-exception-one`,
    exceptionTwo: `${canaryPrefix}-exception-two`,
    arbitraryProperty: `${canaryPrefix}-arbitrary-property`,
  },
};
secureWrite(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, true);
secureWrite(networkLog, "", true);

let proxy;
let provider;
const workRoot = mkdtempSync(join(tmpdir(), "cc-router-eu-validation-work-"));
try {
  const installRoot = join(workRoot, "installed");
  mkdirSync(installRoot, { recursive: true });
  execFileSync("pnpm", [
    "add", "--dir", installRoot, "--ignore-workspace", "--offline", "--allow-build=protobufjs",
    ...offlinePostHogPins(), tarball,
  ], { cwd: repositoryRoot, stdio: "pipe" });
  const packageRoot = join(installRoot, "node_modules", "@timo972", "cc-router");
  const binary = join(installRoot, "node_modules", ".bin", "cc-router");
  scanPackagedArtifact(packageRoot);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  evidence.packageVersion = manifest.version;
  secureWrite(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const constants = await import(pathToFileURL(join(packageRoot, "dist", "telemetry", "constants.js")).href);
  const tokenHash = createHash("sha256").update(constants.POSTHOG_PROJECT_TOKEN).digest("hex");
  if (tokenHash !== process.env.CC_ROUTER_EU_PROJECT_TOKEN_SHA256.toLowerCase()) {
    throw new Error("packed public project token does not match the selected personal EU project");
  }

  provider = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      appendFileSync(networkLog, `${JSON.stringify({ kind: "provider-fixture", protocol: "http:", hostname: "127.0.0.1", path: request.url })}\n`);
      response.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      response.end(JSON.stringify({ synthetic: true, body: evidence.canaries.providerBody }));
    });
  });
  const providerOrigin = `http://127.0.0.1:${await listen(provider)}`;
  const proxyPort = await reservePort();
  const home = join(workRoot, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const accountsPath = join(home, "accounts.json");
  const telemetryPath = join(home, "telemetry.json");
  const configPath = join(home, "config.json");
  writeFileSync(accountsPath, JSON.stringify([{
    id: evidence.canaries.account,
    provider: "openai_subscription",
    accessToken: evidence.canaries.bearer,
    refreshToken: `${canaryPrefix}-refresh`,
    expiresAt: Date.now() + 3_600_000,
    scopes: [evidence.canaries.email],
    enabled: true,
  }]), { mode: 0o600 });
  writeFileSync(telemetryPath, JSON.stringify({ enabled: true, installId: installationId, firstRunAt: evidence.startedAt }), { mode: 0o600 });
  writeFileSync(configPath, "{}\n", { mode: 0o600 });
  const guarded = guardEnvironment(providerOrigin, networkLog);
  let proxyOutput = "";
  proxy = spawn(binary, ["start", "--foreground", "--port", String(proxyPort), "--accounts", accountsPath], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ...guarded,
      HOME: home,
      ACCOUNTS_PATH: accountsPath,
      CONFIG_PATH: configPath,
      TELEMETRY_PATH: telemetryPath,
      NODE_ENV: "test",
      CC_ROUTER_TEST_TRACE_ID: "00000000000000000000000000000001",
      NO_UPDATE_NOTIFIER: "1",
      CI: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxy.stdout.on("data", chunk => { proxyOutput += String(chunk); });
  proxy.stderr.on("data", chunk => { proxyOutput += String(chunk); });
  await waitForProxy(proxyPort, proxy, () => proxyOutput);
  await fetch(`http://127.0.0.1:${proxyPort}/v1/responses?canary=${encodeURIComponent(evidence.canaries.query)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${evidence.canaries.bearer}`,
      "x-api-key": evidence.canaries.bearer,
      "x-claude-code-session-id": evidence.canaries.session,
      host: evidence.canaries.hostname,
    },
    body: JSON.stringify({
      model: "openai/gpt-synthetic",
      input: [{ role: "user", content: [{ type: "input_text", text: evidence.canaries.prompt }] }],
      metadata: { path: evidence.canaries.path },
      stream: false,
    }),
  });
  await new Promise(resolveWait => setTimeout(resolveWait, 1_500));
  proxy.kill("SIGTERM");
  await waitForExit(proxy, 8_000);
  proxy = undefined;

  execFileSync(process.execPath, [syntheticChildPath, packageRoot, evidencePath], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ...guarded,
      HOME: home,
      TELEMETRY_PATH: telemetryPath,
      NO_UPDATE_NOTIFIER: "1",
      CI: "1",
    },
    stdio: "pipe",
  });

  const networkEntries = assertNoBlockedAttempts(networkLog);
  assertMode(evidenceRoot, 0o700, "evidence directory");
  assertMode(evidencePath, 0o600, "evidence file");
  assertMode(networkLog, 0o600, "evidence file");
  evidence.networkSummary = networkEntries;
  secureWrite(evidencePath, `${JSON.stringify({ ...JSON.parse(readFileSync(evidencePath, "utf8")), networkSummary: networkEntries }, null, 2)}\n`);
  process.stdout.write(`Live synthetic emission finished. Evidence: ${evidencePath}\n\n`);
  process.stdout.write(`Use the personal EU project and this exact time window/install ID to verify:\n`);
  process.stdout.write(`1. sampled proxy.request -> provider.inference waterfall and correlated runtime.failure log;\n`);
  process.stdout.write(`2. real account.setup.diagnostic logs and matching funnels for all five setup methods/stages;\n`);
  process.stdout.write(`3. repeated sanitized exceptions share fingerprint/install ID and create no Person;\n`);
  process.stdout.write(`4. every canary in evidence.json has zero matches in Traces, Logs, Events, and Error Tracking.\n`);
} finally {
  if (proxy && proxy.exitCode === null) proxy.kill("SIGKILL");
  if (provider) await close(provider);
  rmSync(workRoot, { recursive: true, force: true });
}
