import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { semanticStrings } from "./telemetry-test-helpers.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const VALIDATOR = join(PROJECT_ROOT, "scripts", "validate-telemetry-eu.mjs");
const GUARD = join(PROJECT_ROOT, "scripts", "telemetry-eu-network-guard.mjs");
const SYNTHETIC_CHILD = join(PROJECT_ROOT, "scripts", "telemetry-eu-synthetic-child.mjs");
const CI_PNPM = join(PROJECT_ROOT, "scripts", "ci-pnpm.mjs");
const INSTALL_PACKED_ARTIFACT = join(PROJECT_ROOT, "scripts", "install-packed-artifact.mjs");

function expectedExistingEvidenceMode(platform: NodeJS.Platform): number | undefined {
  return platform === "win32" ? undefined : 0o777;
}

const CAUGHT_NETWORK_ATTEMPTS = join(PROJECT_ROOT, "src", "__tests__", "fixtures", "caught-network-attempts.mjs");
const NO_TRANSPORT = join(PROJECT_ROOT, "src", "__tests__", "fixtures", "network-no-transport-preload.mjs");
const NAMED_BEFORE = join(PROJECT_ROOT, "src", "__tests__", "fixtures", "network-named-import-before-preload.mjs");
const LOOPBACK_ONLY = join(PROJECT_ROOT, "src", "__tests__", "fixtures", "network-loopback-only-preload.mjs");
const ALLOWED_NETWORK_ATTEMPTS = join(PROJECT_ROOT, "src", "__tests__", "fixtures", "allowed-network-attempts.mjs");
const AUTHORIZED_ABORT = join(PROJECT_ROOT, "src", "__tests__", "fixtures", "guard-authorized-abort.mjs");
const SOCKET_NO_TRANSPORT = join(
  PROJECT_ROOT,
  "src",
  "__tests__",
  "fixtures",
  "guard-socket-no-transport-preload.mjs",
);
const SOCKET_CARDINALITY = join(
  PROJECT_ROOT,
  "src",
  "__tests__",
  "fixtures",
  "guard-socket-cardinality.mjs",
);

describe("personal EU telemetry release validator", () => {
  it("makes the existing evidence target mode contract explicit on Windows", () => {
    expect(expectedExistingEvidenceMode("darwin")).toBe(0o777);
    expect(expectedExistingEvidenceMode("win32")).toBeUndefined();
  });

  it("defaults to an offline plan with the complete synthetic matrix", () => {
    const output = execFileSync(process.execPath, [VALIDATOR], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    });

    expect(output).toContain("DRY RUN — no network requests were made");
    expect(output).toContain("eu.i.posthog.com/batch/");
    expect(output).toContain("eu.i.posthog.com/i/v1/traces");
    expect(output).toContain("eu.i.posthog.com/i/v1/logs");
    for (const method of [
      "anthropic/macos_keychain",
      "anthropic/claude_credentials_file",
      "anthropic/manual_token",
      "openai/manual_token",
      "openai/device_oauth",
    ]) expect(output).toContain(method);
    expect(output).toContain("repeated sanitized exceptions");
    expect(output).toContain("exact packed artifact");
  });

  it("rejects live mode before touching a tarball unless every explicit gate is present", () => {
    const result = spawnSync(process.execPath, [VALIDATOR, "--live", "--tarball", "/does/not/exist.tgz"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CC_ROUTER_EU_LIVE_VALIDATION: "",
        CC_ROUTER_EU_PROJECT_CONFIGURED: "",
        CC_ROUTER_EU_PROJECT_TOKEN_SHA256: "",
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("CC_ROUTER_EU_LIVE_VALIDATION");
    expect(`${result.stdout}${result.stderr}`).not.toContain("ENOENT");
  });

  it("rejects inherited NODE_OPTIONS before resolving the tarball or spawning children", () => {
    const result = spawnSync(process.execPath, [VALIDATOR, "--live", "--tarball", "/does/not/exist.tgz"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: "--trace-warnings",
        CC_ROUTER_EU_LIVE_VALIDATION: "I_UNDERSTAND_SYNTHETIC_TELEMETRY_WILL_BE_SENT",
        CC_ROUTER_EU_PROJECT_CONFIGURED: "personal-eu-cc-router",
        CC_ROUTER_EU_PROJECT_TOKEN_SHA256: "a".repeat(64),
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("inherited NODE_OPTIONS");
    expect(`${result.stdout}${result.stderr}`).not.toContain("ENOENT");
  });

  it("rejects an existing evidence target without overwriting its contents or echoing them", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-router-evidence-existing-"));
    const evidenceRoot = join(root, "evidence");
    const tarball = join(root, "fixture.tgz");
    const sentinel = "WORLD_READABLE_PRIVATE_SENTINEL";
    mkdirSync(evidenceRoot, { mode: 0o777 });
    writeFileSync(join(evidenceRoot, "evidence.json"), sentinel, { mode: 0o666 });
    chmodSync(evidenceRoot, 0o777);
    writeFileSync(tarball, "not a real archive");
    try {
      const result = spawnSync(process.execPath, [VALIDATOR, "--live", "--tarball", tarball], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          CC_ROUTER_EU_LIVE_VALIDATION: "I_UNDERSTAND_SYNTHETIC_TELEMETRY_WILL_BE_SENT",
          CC_ROUTER_EU_PROJECT_CONFIGURED: "personal-eu-cc-router",
          CC_ROUTER_EU_PROJECT_TOKEN_SHA256: "a".repeat(64),
          CC_ROUTER_EU_EVIDENCE_DIR: evidenceRoot,
        },
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain("evidence target must not already exist");
      expect(output).not.toContain(sentinel);
      expect(readFileSync(join(evidenceRoot, "evidence.json"), "utf8")).toBe(sentinel);
      const directoryStat = statSync(evidenceRoot);
      const evidenceStat = statSync(join(evidenceRoot, "evidence.json"));
      expect(directoryStat.isDirectory()).toBe(true);
      expect(evidenceStat.isFile()).toBe(true);
      const expectedMode = expectedExistingEvidenceMode(process.platform);
      if (expectedMode !== undefined) expect(directoryStat.mode & 0o777).toBe(expectedMode);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the repo-local harness unshipped and free of embedded credentials/canaries", () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as {
      files: string[];
    };
    expect(manifest.files).not.toContain("scripts/");

    const source = [VALIDATOR, GUARD, SYNTHETIC_CHILD, CI_PNPM, INSTALL_PACKED_ARTIFACT]
      .map(path => readFileSync(path, "utf8"))
      .join("\n");
    expect(source).not.toMatch(/\bph[ctx]_[0-9A-Za-z]+/);
    expect(source).not.toMatch(/sk-(?:ant-|proj-)?[0-9A-Za-z_-]{16,}/);
    expect(source).not.toContain("PRIVATE_CANARY");
    expect(source).not.toContain("Droidrun Cloud");
  });

  it("blocks a non-PostHog external fetch before transport", () => {
    const result = spawnSync(process.execPath, [
      "--import", pathToFileURL(GUARD).href,
      "--input-type=module",
      "-e", "await fetch('https://example.invalid/forbidden')",
    ], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CC_ROUTER_EU_GUARD_MODE: "validation",
        CC_ROUTER_EU_LOOPBACK_PROVIDER_ORIGIN: "http://127.0.0.1:43199",
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("blocked external fetch");
  });

  it("records a blocked request even when the child catches it and exits zero", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-router-guard-caught-"));
    const networkLog = join(root, "network.jsonl");
    try {
      const result = spawnSync(process.execPath, [
        "--import", pathToFileURL(NAMED_BEFORE).href,
        "--import", pathToFileURL(NO_TRANSPORT).href,
        "--import", pathToFileURL(GUARD).href,
        CAUGHT_NETWORK_ATTEMPTS,
      ], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          CC_ROUTER_EU_GUARD_MODE: "validation",
          CC_ROUTER_EU_LOOPBACK_PROVIDER_ORIGIN: "http://127.0.0.1:43199",
          CC_ROUTER_EU_NETWORK_LOG: networkLog,
        },
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const networkWire = readFileSync(networkLog, "utf8");
      expect(networkWire.match(/"kind":"blocked-fetch"/g)).toHaveLength(2);
      expect(networkWire.match(/"kind":"blocked-request"/g)).toHaveLength(13);
      expect(networkWire.match(/"kind":"blocked-socket"/g)).toHaveLength(5);
      expect(networkWire).toContain('"hostname":"2001:db8::1"');
      expect(networkWire).toContain('"hostname":"eu.i.posthog.com"');
      expect(networkWire).toContain('"path":"/named-before-not-approved"');
      expect(networkWire).toContain('"path":"/named-after-not-approved"');
      expect(networkWire).toContain('"port":"8443"');
      expect(networkWire).toContain('"port":"9443"');

      const audit = spawnSync(process.execPath, [
        VALIDATOR,
        "--test-audit-network-log",
        "--network-log", networkLog,
      ], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test" },
      });
      expect(audit.status).not.toBe(0);
      expect(`${audit.stdout}${audit.stderr}`).toContain("blocked egress attempt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects every unexpected network entry, even when it is not labeled blocked", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-router-guard-audit-"));
    const networkLog = join(root, "network.jsonl");
    try {
      writeFileSync(networkLog, `${JSON.stringify({
        kind: "request",
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "43199",
        method: "GET",
        path: "/arbitrary",
      })}\n`);
      const audit = spawnSync(process.execPath, [
        VALIDATOR,
        "--test-audit-network-log",
        "--network-log", networkLog,
      ], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          CC_ROUTER_EU_LOOPBACK_PROVIDER_ORIGIN: "http://127.0.0.1:43198",
          CC_ROUTER_EU_OFFLINE_CAPTURE_ORIGIN: "http://127.0.0.1:43197",
        },
      });
      expect(audit.status).not.toBe(0);
      expect(`${audit.stdout}${audit.stderr}`).toContain("unexpected network audit entry");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("redirects exact allowed POST paths for default and named request/get bindings", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-router-guard-allowed-"));
    const networkLog = join(root, "network.jsonl");
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}\n");
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address() as AddressInfo;
    try {
      const child = spawn(process.execPath, [
        "--import", pathToFileURL(NAMED_BEFORE).href,
        "--import", pathToFileURL(LOOPBACK_ONLY).href,
        "--import", pathToFileURL(GUARD).href,
        ALLOWED_NETWORK_ATTEMPTS,
      ], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          NODE_ENV: "test",
          CC_ROUTER_EU_GUARD_MODE: "offline-test",
          CC_ROUTER_EU_OFFLINE_CAPTURE_ORIGIN: `http://127.0.0.1:${address.port}`,
          CC_ROUTER_EU_LOOPBACK_PROVIDER_ORIGIN: `http://127.0.0.1:${address.port}`,
          CC_ROUTER_EU_NETWORK_LOG: networkLog,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += String(chunk); });
      child.stderr.on("data", chunk => { output += String(chunk); });
      const status = await new Promise<number | null>((resolveExit, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`allowed network fixture timed out\n${output}`));
        }, 5_000);
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.once("exit", code => { clearTimeout(timeout); resolveExit(code); });
      });
      expect(status, output).toBe(0);
      expect(requests).toHaveLength(6);
      expect(requests.filter(path => path === "/batch/")).toHaveLength(2);
      expect(requests.filter(path => path === "/i/v1/traces")).toHaveLength(2);
      expect(requests.filter(path => path === "/i/v1/logs")).toHaveLength(2);
      const networkWire = readFileSync(networkLog, "utf8");
      expect(networkWire.match(/"kind":"offline-posthog-loopback"/g)).toHaveLength(6);
      expect(networkWire.match(/"kind":"approved-socket"/g)?.length).toBeGreaterThanOrEqual(1);
      expect(networkWire.match(/"method":"POST"/g)?.length).toBeGreaterThanOrEqual(7);
      expect(networkWire).not.toContain("blocked-");
      const audit = spawnSync(process.execPath, [
        VALIDATOR,
        "--test-audit-network-log",
        "--network-log", networkLog,
      ], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          CC_ROUTER_EU_LOOPBACK_PROVIDER_ORIGIN: `http://127.0.0.1:${address.port}`,
          CC_ROUTER_EU_OFFLINE_CAPTURE_ORIGIN: `http://127.0.0.1:${address.port}`,
        },
      });
      expect(audit.status, `${audit.stdout}${audit.stderr}`).toBe(0);
    } finally {
      await new Promise<void>(resolveClose => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("contains an authorized held-request abort without misclassifying its transport cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-router-guard-abort-"));
    const networkLog = join(root, "network.jsonl");
    const server = createServer((request) => { request.resume(); });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address() as AddressInfo;
    try {
      const result = spawnSync(process.execPath, [
        "--import", pathToFileURL(GUARD).href,
        AUTHORIZED_ABORT,
      ], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          CC_ROUTER_EU_GUARD_MODE: "offline-test",
          CC_ROUTER_EU_OFFLINE_CAPTURE_ORIGIN: `http://127.0.0.1:${address.port}`,
          CC_ROUTER_EU_LOOPBACK_PROVIDER_ORIGIN: `http://127.0.0.1:${address.port}`,
          CC_ROUTER_EU_NETWORK_LOG: networkLog,
        },
      });

      const networkWire = readFileSync(networkLog, "utf8");
      expect(result.status, `${result.stdout}${result.stderr}\n${networkWire}`).toBe(0);
      expect(result.stdout).toContain("authorized request settled");
      expect(networkWire).toContain('"kind":"offline-posthog-loopback"');
      expect(networkWire).toContain('"kind":"approved-socket"');
      expect(networkWire).not.toContain("blocked-");
    } finally {
      await new Promise<void>(resolveClose => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows one destroyed-socket replacement but blocks every other socket cardinality", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-router-guard-cardinality-"));
    const networkLog = join(root, "network.jsonl");
    const origin = "http://127.0.0.1:43197";
    try {
      const result = spawnSync(process.execPath, [
        "--import", pathToFileURL(SOCKET_NO_TRANSPORT).href,
        "--import", pathToFileURL(GUARD).href,
        SOCKET_CARDINALITY,
      ], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          CC_ROUTER_EU_GUARD_MODE: "offline-test",
          CC_ROUTER_EU_OFFLINE_CAPTURE_ORIGIN: origin,
          CC_ROUTER_EU_LOOPBACK_PROVIDER_ORIGIN: origin,
          CC_ROUTER_EU_NETWORK_LOG: networkLog,
        },
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        first: "allowed",
        secondLive: "blocked",
        mismatch: "blocked",
        replacement: "allowed",
        third: "blocked",
        noProvenance: "blocked",
      });
      const entries = readFileSync(networkLog, "utf8")
        .trim().split("\n").map(line => JSON.parse(line) as {
          kind: string;
          method?: string;
          path: string;
          hostname: string;
          port?: string;
        });
      expect(entries.filter(entry => entry.kind === "approved-socket")).toEqual([
        expect.objectContaining({
          hostname: "127.0.0.1",
          port: "43197",
          method: "POST",
          path: "/batch/",
        }),
        expect.objectContaining({
          hostname: "127.0.0.1",
          port: "43197",
          method: "POST",
          path: "/batch/",
        }),
      ]);
      expect(entries.filter(entry => entry.kind === "blocked-socket")).toHaveLength(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits the five synthetic funnels and grouped exceptions through a loopback-only self-test", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "cc-router-eu-validator-"));
    const requests: Array<{ url: string; body: Buffer }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({ url: request.url ?? "", body: Buffer.concat(chunks) });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}\n");
      });
    });
    try {
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolveListen());
      });
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const telemetryPath = join(testHome, "telemetry.json");
      const evidencePath = join(testHome, "evidence.json");
      const installId = "11111111-1111-4111-8111-111111111111";
      const canaries = {
        arbitraryProperty: "validator-arbitrary-canary",
        exceptionOne: "validator-exception-one",
        exceptionTwo: "validator-exception-two",
      };
      writeFileSync(telemetryPath, JSON.stringify({
        enabled: true,
        installId,
        firstRunAt: "2026-08-13T00:00:00.000Z",
      }));
      writeFileSync(evidencePath, JSON.stringify({
        packageVersion: "0.8.2",
        installationId: installId,
        canaries,
      }));

      const child = spawn(process.execPath, [
        "--import", "tsx",
        "--import", pathToFileURL(GUARD).href,
        SYNTHETIC_CHILD,
        PROJECT_ROOT,
        evidencePath,
      ], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: testHome,
          TELEMETRY_PATH: telemetryPath,
          NODE_ENV: "test",
          CC_ROUTER_EU_GUARD_MODE: "offline-test",
          CC_ROUTER_EU_SYNTHETIC_SOURCE_SELF_TEST: "1",
          CC_ROUTER_EU_OFFLINE_CAPTURE_ORIGIN: origin,
          CC_ROUTER_EU_LOOPBACK_PROVIDER_ORIGIN: origin,
          CC_ROUTER_TEST_OTLP_LOG_URL: `${origin}/i/v1/logs`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += String(chunk); });
      child.stderr.on("data", chunk => { output += String(chunk); });
      const status = await new Promise<number | null>((resolveExit, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`synthetic child timed out\n${output}`));
        }, 15_000);
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.once("exit", code => { clearTimeout(timeout); resolveExit(code); });
      });
      expect(status, output).toBe(0);

      const batches = requests.filter(request => request.url === "/batch/").flatMap(request => {
        const parsed = JSON.parse(request.body.toString("utf8")) as { batch?: unknown[] };
        return parsed.batch ?? [];
      }) as Array<{ event: string; properties: Record<string, unknown> }>;
      expect(new Set(batches.filter(event => event.event.startsWith("account_setup."))
        .map(event => `${String(event.properties.provider)}/${String(event.properties.method)}`))).toEqual(new Set([
        "anthropic/macos_keychain",
        "anthropic/claude_credentials_file",
        "anthropic/manual_token",
        "openai/manual_token",
        "openai/device_oauth",
      ]));
      const completedStages = (provider: string, method: string) => batches
        .filter(event => event.event === "account_setup.stage_completed"
          && event.properties.provider === provider
          && event.properties.method === method)
        .map(event => event.properties.stage);
      expect(completedStages("openai", "manual_token")).toEqual([
        "credential_source_selection", "credential_read", "credential_parse", "persistence",
      ]);
      expect(completedStages("openai", "device_oauth")).toEqual([
        "credential_source_selection", "device_code_request", "authorization_polling",
        "token_exchange", "access_token_parse", "persistence",
      ]);
      expect(batches.filter(event => event.event === "$exception")).toHaveLength(2);
      expect(batches.every(event => event.properties["$process_person_profile"] === false)).toBe(true);
      expect(batches.every(event => event.properties["$geoip_disable"] === true)).toBe(true);
      const logPayloads = requests
        .filter(request => request.url === "/i/v1/logs")
        .map(request => JSON.parse(request.body.toString("utf8")) as unknown);
      const logStrings = semanticStrings(logPayloads);
      expect(logStrings, JSON.stringify(requests.map(request => request.url))).toContain("account.setup.diagnostic");
      for (const method of ["macos_keychain", "claude_credentials_file", "manual_token", "device_oauth"]) {
        expect(logStrings).toContain(method);
      }
      for (const stage of ["credential_read", "credential_parse", "token_validation", "persistence", "token_exchange"]) {
        expect(logStrings).toContain(stage);
      }
      const wire = Buffer.concat(requests.map(request => request.body)).toString("utf8");
      for (const canary of Object.values(canaries)) expect(wire).not.toContain(canary);
      const writtenEvidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
        exceptions: Array<{ fingerprint: string }>;
      };
      expect(writtenEvidence.exceptions[0]?.fingerprint).toBe(writtenEvidence.exceptions[1]?.fingerprint);
    } finally {
      await new Promise<void>(resolveClose => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
      rmSync(testHome, { recursive: true, force: true });
    }
  }, 20_000);
});
