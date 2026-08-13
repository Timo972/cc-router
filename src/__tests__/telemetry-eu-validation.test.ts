import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const VALIDATOR = join(PROJECT_ROOT, "scripts", "validate-telemetry-eu.mjs");
const GUARD = join(PROJECT_ROOT, "scripts", "telemetry-eu-network-guard.mjs");
const SYNTHETIC_CHILD = join(PROJECT_ROOT, "scripts", "telemetry-eu-synthetic-child.mjs");

describe("personal EU telemetry release validator", () => {
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

  it("keeps the repo-local harness unshipped and free of embedded credentials/canaries", () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as {
      files: string[];
    };
    expect(manifest.files).not.toContain("scripts/");

    const source = [VALIDATOR, GUARD, SYNTHETIC_CHILD]
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

  it("emits the five synthetic funnels and grouped exceptions through a loopback-only self-test", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "cc-router-eu-validator-"));
    const requests: Buffer[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push(Buffer.concat(chunks));
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

      const batches = requests.flatMap(body => {
        const parsed = JSON.parse(body.toString("utf8")) as { batch?: unknown[] };
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
      expect(batches.filter(event => event.event === "$exception")).toHaveLength(2);
      expect(batches.every(event => event.properties["$process_person_profile"] === false)).toBe(true);
      expect(batches.every(event => event.properties["$geoip_disable"] === true)).toBe(true);
      const wire = Buffer.concat(requests).toString("utf8");
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
