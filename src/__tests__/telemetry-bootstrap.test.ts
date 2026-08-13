import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  startTransportCaptureServer,
  TELEMETRY_CANARY,
  type TransportCaptureServer,
} from "./telemetry-test-helpers.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");

interface RunningPackage {
  child: ChildProcess;
  output: () => string;
  stop(signal?: "SIGTERM" | "SIGINT"): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("loopback server did not expose a TCP port"));
        return;
      }
      resolvePort(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
    server.closeAllConnections();
  });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  failure: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(failure());
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function parsedProtobufForPrivacyAudit(input: Buffer): unknown {
  const readVarint = (buffer: Buffer, offset: number): { value: number; next: number } => {
    let value = 0;
    let multiplier = 1;
    for (let index = offset; index < buffer.length && index < offset + 10; index += 1) {
      const byte = buffer[index]!;
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return { value, next: index + 1 };
      multiplier *= 128;
    }
    throw new Error("invalid protobuf varint");
  };
  const parseMessage = (message: Buffer): unknown[] => {
    const fields: unknown[] = [];
    let offset = 0;
    while (offset < message.length) {
      const tag = readVarint(message, offset);
      offset = tag.next;
      const field = Math.floor(tag.value / 8);
      const wireType = tag.value & 7;
      if (field === 0) throw new Error("invalid protobuf field");
      if (wireType === 0) {
        const value = readVarint(message, offset);
        fields.push({ field, varint: value.value });
        offset = value.next;
        continue;
      }
      if (wireType === 1 || wireType === 5) {
        const bytes = wireType === 1 ? 8 : 4;
        if (offset + bytes > message.length) throw new Error("truncated fixed protobuf field");
        fields.push({ field, fixed: message.subarray(offset, offset + bytes).toString("hex") });
        offset += bytes;
        continue;
      }
      if (wireType !== 2) throw new Error(`unsupported protobuf wire type ${wireType}`);
      const length = readVarint(message, offset);
      offset = length.next;
      const end = offset + length.value;
      if (end > message.length) throw new Error("truncated protobuf field");
      const bytes = message.subarray(offset, end);
      let decoded: unknown;
      try {
        decoded = parseMessage(bytes);
      } catch {
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          decoded = bytes.toString("base64");
        }
      }
      fields.push({ field, value: decoded });
      offset = end;
    }
    return fields;
  };
  return parseMessage(input);
}

async function startBuiltPackage(options: {
  telemetryEnabled: boolean;
  proxyPort: number;
  targetOrigin: string;
  telemetryCaptureOrigin: string;
  testTraceUrl?: string;
  testLogUrl?: string;
  accounts?: object[];
  environment?: Record<string, string>;
  binary?: string;
  cwd?: string;
  launchBinaryDirectly?: boolean;
}): Promise<RunningPackage> {
  const testHome = mkdtempSync(join(tmpdir(), "cc-router-bootstrap-"));
  const accountsPath = join(testHome, "accounts.json");
  const telemetryPath = join(testHome, "telemetry.json");
  const configPath = join(testHome, "config.json");
  const preloadPath = join(testHome, "loopback-fetch-preload.mjs");
  const packageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as {
    bin: { "cc-router": string };
  };
  const binary = options.binary ?? join(PROJECT_ROOT, packageJson.bin["cc-router"]);

  writeFileSync(accountsPath, JSON.stringify(options.accounts ?? [{
    id: TELEMETRY_CANARY.accountId,
    provider: "openai_subscription",
    accessToken: TELEMETRY_CANARY.bearerToken.slice("Bearer ".length),
    refreshToken: TELEMETRY_CANARY.prompt,
    expiresAt: Date.now() + 3_600_000,
    scopes: [TELEMETRY_CANARY.email, TELEMETRY_CANARY.homePath],
    enabled: true,
  }]));
  writeFileSync(telemetryPath, JSON.stringify({
    enabled: options.telemetryEnabled,
    installId: "11111111-1111-4111-8111-111111111111",
    firstRunAt: "2026-08-01T00:00:00.000Z",
  }));
  writeFileSync(configPath, "{}");

  writeFileSync(preloadPath, `
const realFetch = globalThis.fetch;
const targetOrigin = ${JSON.stringify(options.targetOrigin)};
const telemetryOrigin = ${JSON.stringify(options.telemetryCaptureOrigin)};
Math.random = () => 0;
globalThis.fetch = async (input, init) => {
  const original = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (original.hostname === "chatgpt.com" && original.pathname === "/backend-api/codex/responses") {
    return realFetch(new URL(original.pathname, targetOrigin), init);
  }
  if (original.hostname === "eu.i.posthog.com") {
    return realFetch(new URL(original.pathname + original.search, telemetryOrigin), init);
  }
  if (original.hostname === "127.0.0.1" || original.hostname === "::1") {
    return realFetch(input, init);
  }
  return new Response("external request blocked by telemetry bootstrap test", { status: 503 });
};
`);

  let output = "";
  const applicationArgs = [
    "start",
    "--foreground",
    "--port", String(options.proxyPort),
    "--accounts", accountsPath,
  ];
  const executable = options.launchBinaryDirectly ? binary : process.execPath;
  const childArgs = options.launchBinaryDirectly
    ? applicationArgs
    : ["--import", pathToFileURL(preloadPath).href, binary, ...applicationArgs];
  const child = spawn(executable, childArgs, {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: {
      ...process.env,
      ...options.environment,
      HOME: testHome,
      ACCOUNTS_PATH: accountsPath,
      CONFIG_PATH: configPath,
      TELEMETRY_PATH: telemetryPath,
      NODE_ENV: "test",
      CC_ROUTER_TEST_OTLP_TRACE_URL:
        options.testTraceUrl ?? `${options.telemetryCaptureOrigin}/i/v1/traces`,
      CC_ROUTER_TEST_OTLP_LOG_URL:
        options.testLogUrl ?? `${options.telemetryCaptureOrigin}/i/v1/logs`,
      ...(options.launchBinaryDirectly
        ? {
            NODE_OPTIONS: [
              process.env["NODE_OPTIONS"],
              `--import=${pathToFileURL(preloadPath).href}`,
            ].filter(Boolean).join(" "),
          }
        : {}),
      NO_UPDATE_NOTIFIER: "1",
      CI: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", chunk => { output += chunk.toString(); });
  child.stderr?.on("data", chunk => { output += chunk.toString(); });

  await waitUntil(async () => {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${options.proxyPort}/cc-router/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, 8_000, () => `compiled package did not start\n${output}`);

  return {
    child,
    output: () => output,
    stop: async (signal = "SIGTERM") => {
      if (child.exitCode !== null || child.signalCode !== null) {
        rmSync(testHome, { recursive: true, force: true });
        return;
      }
      if (child.exitCode === null) child.kill(signal);
      await Promise.race([
        new Promise<void>(resolveExit => child.once("exit", () => resolveExit())),
        new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 2_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(testHome, { recursive: true, force: true });
    },
  };
}

function installedVersionForEntry(entry: string): string {
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    const packageJsonPath = join(directory, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
      if (typeof packageJson.version === "string") return packageJson.version;
    }
    directory = dirname(directory);
  }
  throw new Error(`could not resolve package version for ${entry}`);
}

function offlinePostHogPins(): string[] {
  const postHogPackageJson = realpathSync(join(PROJECT_ROOT, "node_modules/posthog-node/package.json"));
  const postHogPackage = JSON.parse(readFileSync(postHogPackageJson, "utf8")) as { version: string };
  const requireFromPostHog = createRequire(postHogPackageJson);
  return [
    `posthog-node@${postHogPackage.version}`,
    `@posthog/core@${installedVersionForEntry(requireFromPostHog.resolve("@posthog/core"))}`,
    `@posthog/types@${installedVersionForEntry(requireFromPostHog.resolve("@posthog/types"))}`,
  ];
}

describe("compiled ESM telemetry bootstrap", () => {
  let target: Server;
  let targetOrigin: string;
  let telemetry: TransportCaptureServer;
  let packedPackageRoot: string;
  let installedBinary: string;
  let installedCwd: string;
  const targetHeaders: Array<Record<string, string | string[] | undefined>> = [];
  const targetBodies: Buffer[] = [];
  const children: RunningPackage[] = [];

  beforeAll(async () => {
    execFileSync("pnpm", ["build"], { cwd: PROJECT_ROOT, stdio: "pipe" });
    target = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        targetHeaders.push({ ...request.headers });
        targetBodies.push(Buffer.concat(chunks));
        response.writeHead(200, {
          "content-type": "application/json",
          "x-telemetry-canary": TELEMETRY_CANARY.headerValue,
        });
        response.end(JSON.stringify({
          id: "resp_bootstrap",
          raw: TELEMETRY_CANARY.rawProviderBody,
          email: TELEMETRY_CANARY.email,
        }));
      });
    });
    targetOrigin = `http://127.0.0.1:${await listen(target)}`;
    telemetry = await startTransportCaptureServer();

    packedPackageRoot = mkdtempSync(join(tmpdir(), "cc-router-packed-artifact-"));
    const packDirectory = join(packedPackageRoot, "pack");
    installedCwd = join(packedPackageRoot, "prefix");
    mkdirSync(packDirectory, { recursive: true });
    mkdirSync(installedCwd, { recursive: true });
    execFileSync("pnpm", ["pack", "--pack-destination", packDirectory], {
      cwd: PROJECT_ROOT,
      stdio: "pipe",
    });
    const tarballs = readdirSync(packDirectory).filter(name => name.endsWith(".tgz"));
    expect(tarballs).toHaveLength(1);
    const tarball = join(packDirectory, tarballs[0]!);
    execFileSync("pnpm", [
      "add",
      "--dir",
      installedCwd,
      "--ignore-workspace",
      "--offline",
      "--allow-build=protobufjs",
      ...offlinePostHogPins(),
      tarball,
    ], { cwd: PROJECT_ROOT, stdio: "pipe" });
    const installedPackage = join(installedCwd, "node_modules", "@timo972", "cc-router");
    installedBinary = join(installedCwd, "node_modules", ".bin", "cc-router");
    for (const requiredFile of [
      "dist/cli/bootstrap.js",
      "dist/config/telemetry-state.js",
      "dist/telemetry/runtime.js",
      "dist/telemetry/otel-exporters.js",
      "dist/telemetry/posthog-client.js",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "package.json",
    ]) {
      expect(existsSync(join(installedPackage, requiredFile)), requiredFile).toBe(true);
    }
    const installedManifest = JSON.parse(
      readFileSync(join(installedPackage, "package.json"), "utf8"),
    ) as { bin?: Record<string, string> };
    expect(installedManifest.bin?.["cc-router"]).toBe("dist/cli/bootstrap.js");
    expect(existsSync(installedBinary)).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await Promise.all(children.map(child => child.stop()));
    await Promise.all([close(target), telemetry.close()]);
    rmSync(packedPackageRoot, { recursive: true, force: true });
  });

  it("registers the OTel ESM hook before loading any general application module", () => {
    const testHome = mkdtempSync(join(tmpdir(), "cc-router-import-order-"));
    const telemetryPath = join(testHome, "telemetry.json");
    const loaderPath = join(testHome, "import-order-loader.mjs");
    const importLogPath = join(testHome, "imports.jsonl");
    const packageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as {
      bin: { "cc-router": string };
    };
    const binary = join(PROJECT_ROOT, packageJson.bin["cc-router"]);

    writeFileSync(telemetryPath, JSON.stringify({
      enabled: true,
      installId: "33333333-3333-4333-8333-333333333333",
      firstRunAt: "2026-08-01T00:00:00.000Z",
    }));
    writeFileSync(loaderPath, `
import { appendFileSync } from "node:fs";
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  appendFileSync(process.env.CC_ROUTER_IMPORT_LOG, JSON.stringify(result.url) + "\\n");
  return result;
}
`);

    try {
      const result = spawnSync(process.execPath, [
        "--experimental-loader", pathToFileURL(loaderPath).href,
        binary,
        "start",
        "--help",
      ], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: testHome,
          TELEMETRY_PATH: telemetryPath,
          CC_ROUTER_IMPORT_LOG: importLogPath,
          NO_UPDATE_NOTIFIER: "1",
          CI: "1",
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);

      const imports = readFileSync(importLogPath, "utf8")
        .trim()
        .split("\n")
        .map(line => JSON.parse(line) as string);
      const hookIndex = imports.findIndex(url =>
        url.includes("@opentelemetry/instrumentation/hook.mjs")
      );
      expect(hookIndex).toBeGreaterThanOrEqual(0);

      const localModulesBeforeHook = imports
        .slice(0, hookIndex)
        .filter(url => url.startsWith(pathToFileURL(join(PROJECT_ROOT, "dist")).href))
        .map(url => relative(PROJECT_ROOT, fileURLToPath(url)));
      const bootstrapSafeModules = new Set([
        "dist/cli/bootstrap.js",
        "dist/config/telemetry-state.js",
        "dist/config/directory.js",
        "dist/config/paths.js",
      ]);
      expect(localModulesBeforeHook[0]).toBe("dist/cli/bootstrap.js");
      expect(localModulesBeforeHook.filter(module => !bootstrapSafeModules.has(module))).toEqual([]);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  }, 15_000);

  it("launches the installed tarball through its ESM hook with private carriers and byte-stable kill switches", async () => {
    const unavailableCapture = await startTransportCaptureServer();
    const unavailableOrigin = unavailableCapture.origin;
    await unavailableCapture.close();
    const observations: Array<{
      status: number;
      contentType: string | null;
      body: Buffer;
      forwardedBody: Buffer;
    }> = [];
    const modes = [
      { name: "enabled", telemetryEnabled: true, environment: {}, capture: telemetry.origin },
      { name: "persisted opt-out", telemetryEnabled: false, environment: {}, capture: telemetry.origin },
      {
        name: "DO_NOT_TRACK=1",
        telemetryEnabled: true,
        environment: { DO_NOT_TRACK: "1" },
        capture: telemetry.origin,
      },
      {
        name: "CC_ROUTER_TELEMETRY=0",
        telemetryEnabled: true,
        environment: { CC_ROUTER_TELEMETRY: "0" },
        capture: telemetry.origin,
      },
      { name: "failing transport", telemetryEnabled: true, environment: {}, capture: unavailableOrigin },
    ] as const;

    for (const mode of modes) {
      const telemetryBefore = telemetry.requests.length;
      const targetBefore = targetBodies.length;
      const probe = createServer();
      const proxyPort = await listen(probe);
      await close(probe);
      const running = await startBuiltPackage({
        telemetryEnabled: mode.telemetryEnabled,
        proxyPort,
        targetOrigin,
        telemetryCaptureOrigin: mode.capture,
        environment: mode.environment,
        binary: installedBinary,
        cwd: installedCwd,
        launchBinaryDirectly: true,
      });
      children.push(running);

      try {
        const requestBody = JSON.stringify({
          model: "openai/gpt-5.5",
          input: [{
            role: "user",
            content: [{
              type: "input_text",
              text: Object.values(TELEMETRY_CANARY).join("\n"),
            }],
          }],
          stream: false,
        });
        const response = await fetch(
          `http://127.0.0.1:${proxyPort}/v1/responses${TELEMETRY_CANARY.queryString}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              host: TELEMETRY_CANARY.hostname,
              authorization: TELEMETRY_CANARY.bearerToken,
              "x-api-key": TELEMETRY_CANARY.headerValue,
              "x-claude-code-session-id": TELEMETRY_CANARY.accountId,
              traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
              tracestate: "private=value",
              baggage: "private=value",
            },
            body: requestBody,
          },
        );
        expect(response.status, `${mode.name}\n${running.output()}`).toBe(200);
        const responseBody = Buffer.from(await response.arrayBuffer());
        expect(targetBodies).toHaveLength(targetBefore + 1);
        observations.push({
          status: response.status,
          contentType: response.headers.get("content-type"),
          body: responseBody,
          forwardedBody: targetBodies.at(-1)!,
        });

        if (mode.name === "enabled") {
          await waitUntil(
            () => telemetry.requests.slice(telemetryBefore).some(request => request.url === "/i/v1/traces"),
            8_000,
            () => `installed package exported no traces\n${running.output()}`,
          );
          const capturedTelemetry = telemetry.requests.slice(telemetryBefore);
          const wire = Buffer.concat(
            capturedTelemetry
              .filter(request => request.url === "/i/v1/traces")
              .map(request => request.rawBody),
          ).toString("utf8");
          expect(wire).toContain("@opentelemetry/instrumentation-express");
          expect(wire).toContain("@opentelemetry/instrumentation-undici");
          expect(wire).toContain("proxy.request");
          expect(wire).toContain("provider.inference");
          expect(wire).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
          expect(capturedTelemetry.length).toBeGreaterThan(0);
          expect(new Set(capturedTelemetry.map(request => request.url)))
            .toEqual(new Set(capturedTelemetry.map(request => request.url).filter(path =>
              path === "/i/v1/traces" || path === "/i/v1/logs" || path === "/batch/"
            )));
          const allWire = Buffer.concat(capturedTelemetry.map(request => request.rawBody)).toString("utf8");
          const parsedPayloads = capturedTelemetry.map(request =>
            request.json ?? parsedProtobufForPrivacyAudit(request.rawBody)
          );
          for (const canary of Object.values(TELEMETRY_CANARY)) {
            expect(allWire).not.toContain(canary);
            expect(JSON.stringify(parsedPayloads)).not.toContain(canary);
          }
          expect(targetHeaders.at(-1)).not.toHaveProperty("traceparent");
          expect(targetHeaders.at(-1)).not.toHaveProperty("tracestate");
          expect(targetHeaders.at(-1)).not.toHaveProperty("baggage");
        } else if (mode.name !== "failing transport") {
          await new Promise(resolveWait => setTimeout(resolveWait, 750));
          expect(telemetry.requests, `${mode.name} emitted telemetry`).toHaveLength(telemetryBefore);
        }
      } finally {
        await running.stop("SIGTERM");
      }
    }

    expect(observations).toHaveLength(modes.length);
    for (const observation of observations.slice(1)) {
      expect(observation).toEqual(observations[0]);
    }
  }, 45_000);

  it("uses an environment LiteLLM target for both forwarding and outgoing span trust", async () => {
    const before = telemetry.requests.length;
    const environmentTargetPaths: string[] = [];
    const environmentTargetServer = createServer((request, response) => {
      environmentTargetPaths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "env_target_response" }));
    });
    const environmentTargetPort = await new Promise<number>((resolvePort, reject) => {
      environmentTargetServer.once("error", reject);
      environmentTargetServer.listen(0, "127.0.0.1", () => {
        environmentTargetServer.off("error", reject);
        const address = environmentTargetServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("environment target did not expose a TCP port"));
          return;
        }
        resolvePort(address.port);
      });
    });
    const probe = createServer();
    const proxyPort = await listen(probe);
    await close(probe);
    const environmentTarget = `http://127.0.0.1:${environmentTargetPort}`;
    const running = await startBuiltPackage({
      telemetryEnabled: true,
      proxyPort,
      targetOrigin,
      telemetryCaptureOrigin: telemetry.origin,
      environment: { LITELLM_URL: environmentTarget },
      accounts: [{
        id: "bootstrap-anthropic",
        provider: "anthropic_subscription",
        accessToken: "test-anthropic-access-token",
        refreshToken: "test-anthropic-refresh-token",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["user:inference"],
        enabled: true,
      }],
    });
    children.push(running);

    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "PRIVATE_ENV_TARGET_PROMPT" }],
          max_tokens: 32,
        }),
      }).catch(error => {
        throw new Error(`environment LiteLLM proxy request failed\n${running.output()}`, { cause: error });
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();

      await waitUntil(
        () => telemetry.requests.slice(before).some(request => request.url === "/i/v1/traces"),
        8_000,
        () => `environment LiteLLM target exported no trace\n${running.output()}`,
      );
      const wire = Buffer.concat(
        telemetry.requests
          .slice(before)
          .filter(request => request.url === "/i/v1/traces")
          .map(request => request.rawBody),
      ).toString("utf8");
      expect(environmentTargetPaths).toContain("/v1/messages");
      expect(countOccurrences(wire, "proxy.request")).toBeGreaterThanOrEqual(2);
      expect(wire).toContain("provider.inference");
      expect(countOccurrences(wire, "@opentelemetry/instrumentation-http")).toBeGreaterThanOrEqual(2);
      expect(wire).not.toContain("PRIVATE_ENV_TARGET_PROMPT");
      expect(wire).not.toContain("test-anthropic-access-token");
    } finally {
      await close(environmentTargetServer);
    }
  }, 20_000);

  it("does not initialize or export from the compiled package when persisted telemetry is off", async () => {
    const before = telemetry.requests.length;
    const probe = createServer();
    const proxyPort = await listen(probe);
    await close(probe);
    const running = await startBuiltPackage({
      telemetryEnabled: false,
      proxyPort,
      targetOrigin,
      telemetryCaptureOrigin: telemetry.origin,
    });
    children.push(running);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: false }),
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    await new Promise(resolveWait => setTimeout(resolveWait, 750));
    expect(telemetry.requests).toHaveLength(before);
  }, 15_000);

  it("fails closed before SDK initialization when a test OTLP override is not literal loopback", async () => {
    const before = telemetry.requests.length;
    const probe = createServer();
    const proxyPort = await listen(probe);
    await close(probe);
    const running = await startBuiltPackage({
      telemetryEnabled: true,
      proxyPort,
      targetOrigin,
      telemetryCaptureOrigin: telemetry.origin,
      testTraceUrl: "https://example.test/i/v1/traces",
      testLogUrl: "https://example.test/i/v1/logs",
    });
    children.push(running);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: false }),
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    await new Promise(resolveWait => setTimeout(resolveWait, 750));
    expect(telemetry.requests).toHaveLength(before);
  }, 15_000);

  it("preserves a command exit code across bootstrap cleanup", () => {
    const testHome = mkdtempSync(join(tmpdir(), "cc-router-exit-code-"));
    const packageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as {
      bin: { "cc-router": string };
    };
    try {
      const result = spawnSync(process.execPath, [
        join(PROJECT_ROOT, packageJson.bin["cc-router"]),
        "telemetry",
        "not-a-real-action",
      ], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: testHome,
          TELEMETRY_PATH: join(testHome, "telemetry.json"),
          NO_UPDATE_NOTIFIER: "1",
          CI: "1",
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown action");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "flushes completed spans within the bounded %s shutdown before preserving exit 0",
    async signal => {
      const before = telemetry.requests.length;
      const probe = createServer();
      const proxyPort = await listen(probe);
      await close(probe);
      const running = await startBuiltPackage({
        telemetryEnabled: true,
        proxyPort,
        targetOrigin,
        telemetryCaptureOrigin: telemetry.origin,
      });

      try {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: false }),
        });
        expect(response.status).toBe(200);
        await response.arrayBuffer();

        const shutdownStarted = Date.now();
        await running.stop(signal);
        expect(Date.now() - shutdownStarted).toBeLessThan(1_500);
        expect(running.child.exitCode).toBe(0);
        await waitUntil(
          () => telemetry.requests.length > before,
          2_000,
          () => `${signal} exited without flushing completed spans\n${running.output()}`,
        );
      } finally {
        await running.stop(signal);
      }
    },
    15_000,
  );

  it("keeps exit 0 and the shutdown bound when the loopback telemetry transport fails", async () => {
    const unavailableCapture = await startTransportCaptureServer();
    const unavailableOrigin = unavailableCapture.origin;
    await unavailableCapture.close();
    const probe = createServer();
    const proxyPort = await listen(probe);
    await close(probe);
    const running = await startBuiltPackage({
      telemetryEnabled: true,
      proxyPort,
      targetOrigin,
      telemetryCaptureOrigin: unavailableOrigin,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: false }),
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();

      const shutdownStarted = Date.now();
      await running.stop("SIGTERM");
      expect(Date.now() - shutdownStarted).toBeLessThan(1_500);
      expect(running.child.exitCode).toBe(0);
    } finally {
      await running.stop("SIGTERM");
    }
  }, 15_000);
});

describe("proxy launch commands", () => {
  it("routes the detached daemon through bootstrap while preserving args and environment", async () => {
    const spawnMock = vi.fn(() => ({
      pid: 12345,
      on: vi.fn(),
      unref: vi.fn(),
    }));
    vi.doMock("node:child_process", async importOriginal => ({
      ...await importOriginal<typeof import("node:child_process")>(),
      spawn: spawnMock,
    }));
    vi.doMock("node:fs", async importOriginal => ({
      ...await importOriginal<typeof import("node:fs")>(),
      openSync: vi.fn(() => 91),
      closeSync: vi.fn(),
    }));
    vi.doMock("../daemon/pid.js", () => ({
      writePid: vi.fn(),
      getRunningPid: vi.fn(() => null),
      isProcessAlive: vi.fn(() => false),
      removePid: vi.fn(),
      isProxyRunning: vi.fn(async () => false),
    }));
    vi.doMock("../config/manager.js", () => ({ ensureConfigDir: vi.fn() }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    try {
      const { launchDaemon } = await import("../daemon/launcher.js");
      await launchDaemon({
        port: 4789,
        litellmUrl: "http://127.0.0.1:4790",
        accountsPath: "/tmp/cc-router accounts.json",
        serverMode: true,
      });

      const [, args, options] = spawnMock.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string> },
      ];
      expect(args).toEqual([
        expect.stringMatching(/cli\/bootstrap\.js$/),
        "start",
        "--foreground",
        "--port",
        "4789",
        "--litellm",
        "http://127.0.0.1:4790",
        "--accounts",
        "/tmp/cc-router accounts.json",
      ]);
      expect(options.env).toEqual(expect.objectContaining({
        CC_ROUTER_DAEMON: "1",
        HOST: "0.0.0.0",
      }));
    } finally {
      vi.restoreAllMocks();
      vi.doUnmock("node:child_process");
      vi.doUnmock("node:fs");
      vi.doUnmock("../daemon/pid.js");
      vi.doUnmock("../config/manager.js");
      vi.resetModules();
    }
  });

  it("routes launchd, systemd, and Windows startup through bootstrap with server-mode environment", async () => {
    let platform: "macos" | "linux" | "windows" = "macos";
    const writes: Array<{ path: string; body: string }> = [];
    const execCalls: Array<{ file: string; args: string[] }> = [];
    const execFileMock = (file: string, args: string[], callback: (error: null, stdout: string, stderr: string) => void): void => {
      execCalls.push({ file, args });
      callback(null, "", "");
    };
    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
      execFileSync: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((path: string, body: string) => writes.push({ path, body })),
      unlinkSync: vi.fn(),
    }));
    vi.doMock("../utils/platform.js", () => ({ detectPlatform: () => platform }));

    try {
      const { installService } = await import("../daemon/service.js");

      await installService(true);
      const plist = writes.at(-1)?.body ?? "";
      expect(plist).toContain("cli/bootstrap.js");
      expect(plist).toContain("<string>start</string>");
      expect(plist).toContain("<string>--foreground</string>");
      expect(plist).toContain("<key>HOST</key>");
      expect(plist).toContain("<key>CC_ROUTER_SERVICE</key>");

      platform = "linux";
      await installService(true);
      const unit = writes.at(-1)?.body ?? "";
      expect(unit).toMatch(/ExecStart=.*cli\/bootstrap\.js start --foreground/);
      expect(unit).toContain("Environment=HOST=0.0.0.0");
      expect(unit).toContain("Environment=CC_ROUTER_SERVICE=1");

      platform = "windows";
      await installService(true);
      const registryCommand = execCalls.find(call => call.file === "reg")?.args.join(" ") ?? "";
      expect(registryCommand).toMatch(/cli[\\/]bootstrap\.js/);
      expect(registryCommand).toContain("start --foreground");
      expect(registryCommand).toContain("set HOST=0.0.0.0");
      expect(registryCommand).toContain("set CC_ROUTER_SERVICE=1");
    } finally {
      vi.restoreAllMocks();
      vi.doUnmock("node:child_process");
      vi.doUnmock("node:fs");
      vi.doUnmock("../utils/platform.js");
      vi.resetModules();
    }
  });

  it("routes the legacy PM2 service constructor through bootstrap without changing PM2 arguments", async () => {
    const execCalls: Array<{ file: string; args: string[] }> = [];
    const execFileMock = (file: string, args: string[], callback: (error: null, stdout: string, stderr: string) => void): void => {
      execCalls.push({ file, args });
      callback(null, file === "pm2" && args[0] === "--version" ? "5.4.0" : "", "");
    };
    vi.doMock("child_process", () => ({ execFile: execFileMock }));

    try {
      const { Command } = await import("commander");
      const { registerService } = await import("../cli/cmd-service.js");
      const program = new Command();
      program.exitOverride();
      registerService(program);
      await program.parseAsync(["node", "cc-router", "service", "install"]);

      const startCall = execCalls.find(call => call.file === "pm2" && call.args[0] === "start");
      expect(startCall?.args).toEqual([
        "start",
        expect.stringMatching(/cli[\\/]bootstrap\.js$/),
        "--name",
        "cc-router",
        "--interpreter",
        process.execPath,
        "--max-memory-restart",
        "500M",
        "--",
        "start",
      ]);
    } finally {
      vi.restoreAllMocks();
      vi.doUnmock("child_process");
      vi.resetModules();
    }
  });
});

describe("proxy telemetry runtime lifecycle", () => {
  it("installs only an uncaughtExceptionMonitor while enabled and removes it during bounded shutdown", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "cc-router-runtime-"));
    const telemetryPath = join(testHome, "telemetry.json");
    const capture = await startTransportCaptureServer();
    const originalEnv = {
      nodeEnv: process.env["NODE_ENV"],
      telemetryPath: process.env["TELEMETRY_PATH"],
      traceUrl: process.env["CC_ROUTER_TEST_OTLP_TRACE_URL"],
      logUrl: process.env["CC_ROUTER_TEST_OTLP_LOG_URL"],
    };
    writeFileSync(telemetryPath, JSON.stringify({
      enabled: true,
      installId: "22222222-2222-4222-8222-222222222222",
      firstRunAt: "2026-08-01T00:00:00.000Z",
    }));
    process.env["NODE_ENV"] = "test";
    process.env["TELEMETRY_PATH"] = telemetryPath;
    process.env["CC_ROUTER_TEST_OTLP_TRACE_URL"] = capture.endpoint("/i/v1/traces");
    process.env["CC_ROUTER_TEST_OTLP_LOG_URL"] = capture.endpoint("/i/v1/logs");
    vi.resetModules();

    const monitorBefore = process.listenerCount("uncaughtExceptionMonitor");
    const monitorsBefore = new Set(process.listeners("uncaughtExceptionMonitor"));
    const uncaughtBefore = process.listenerCount("uncaughtException");
    const rejectionBefore = process.listenerCount("unhandledRejection");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    try {
      const runtime = await import("../telemetry/runtime.js");
      expect(runtime.startProxyTelemetry("foreground")).toBe(true);
      expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(monitorBefore + 1);
      expect(process.listenerCount("uncaughtException")).toBe(uncaughtBefore);
      expect(process.listenerCount("unhandledRejection")).toBe(rejectionBefore);
      const fatalMonitor = process.listeners("uncaughtExceptionMonitor")
        .find(listener => !monitorsBefore.has(listener));
      expect(fatalMonitor).toBeTypeOf("function");
      const fatal = new Error("PRIVATE_FATAL_MESSAGE");
      fatal.stack = [
        "Error: PRIVATE_FATAL_MESSAGE",
        `    at fail (${PROJECT_ROOT}/dist/proxy/server.js:10:20)`,
      ].join("\n");
      fatalMonitor?.(fatal, "uncaughtException");
      await waitUntil(
        () => fetchMock.mock.calls.length > 0,
        1_000,
        () => "fatal monitor did not attempt sanitized best-effort capture",
      );
      const capturedWire = fetchMock.mock.calls.map(call => JSON.stringify(call)).join("\n");
      expect(capturedWire).not.toContain("PRIVATE_FATAL_MESSAGE");
      expect(capturedWire).toContain("other");

      const started = Date.now();
      await runtime.shutdownProxyTelemetryWithin(100);
      expect(Date.now() - started).toBeLessThan(500);
      expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(monitorBefore);
      expect(process.listenerCount("uncaughtException")).toBe(uncaughtBefore);
      expect(process.listenerCount("unhandledRejection")).toBe(rejectionBefore);

      writeFileSync(telemetryPath, JSON.stringify({
        enabled: false,
        installId: "22222222-2222-4222-8222-222222222222",
        firstRunAt: "2026-08-01T00:00:00.000Z",
      }));
      expect(runtime.startProxyTelemetry("foreground")).toBe(false);
      expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(monitorBefore);
    } finally {
      if (originalEnv.nodeEnv === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = originalEnv.nodeEnv;
      if (originalEnv.telemetryPath === undefined) delete process.env["TELEMETRY_PATH"];
      else process.env["TELEMETRY_PATH"] = originalEnv.telemetryPath;
      if (originalEnv.traceUrl === undefined) delete process.env["CC_ROUTER_TEST_OTLP_TRACE_URL"];
      else process.env["CC_ROUTER_TEST_OTLP_TRACE_URL"] = originalEnv.traceUrl;
      if (originalEnv.logUrl === undefined) delete process.env["CC_ROUTER_TEST_OTLP_LOG_URL"];
      else process.env["CC_ROUTER_TEST_OTLP_LOG_URL"] = originalEnv.logUrl;
      fetchMock.mockRestore();
      await capture.close();
      rmSync(testHome, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
