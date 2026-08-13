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
import { createServer, request, type ClientRequest, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  decodeOtlpProtobuf,
  semanticStrings,
  startTransportCaptureServer,
  TELEMETRY_CANARY,
  telemetryWireRepresentations,
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

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    return await listen(server);
  } finally {
    if (server.listening) await close(server);
    else server.closeAllConnections();
  }
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

function runNodeFixture(path: string, environment: Record<string, string>): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [path], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", chunk => { output += String(chunk); });
    child.stderr?.on("data", chunk => { output += String(chunk); });
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15_000);
    child.once("error", error => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (!timedOut && code === 0) {
        resolveRun();
        return;
      }
      reject(new Error(
        `Node fixture ${timedOut ? "timed out" : `exited ${String(code)} (${String(signal)})`}\n${output}`,
      ));
    });
  });
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

interface HttpObservation {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  chunks: Buffer[];
  body: Buffer;
}

function startHttpRequest(
  url: URL,
  body: Buffer,
  headers: Record<string, string>,
): {
  request: ClientRequest;
  firstChunk: Promise<void>;
  completed: Promise<HttpObservation>;
  chunks: Buffer[];
} {
  let firstChunkResolve!: () => void;
  const firstChunk = new Promise<void>(resolveFirst => { firstChunkResolve = resolveFirst; });
  let requestHandle!: ClientRequest;
  const receivedChunks: Buffer[] = [];
  const completed = new Promise<HttpObservation>((resolveResponse, reject) => {
    requestHandle = request(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-length": String(body.length),
      },
    }, response => {
      response.on("data", chunk => {
        receivedChunks.push(Buffer.from(chunk));
        if (receivedChunks.length === 1) firstChunkResolve();
      });
      response.on("end", () => resolveResponse({
        status: response.statusCode ?? 0,
        headers: { ...response.headers },
        chunks: receivedChunks,
        body: Buffer.concat(receivedChunks),
      }));
      response.on("error", reject);
    });
    requestHandle.on("error", reject);
    requestHandle.end(body);
  });
  return { request: requestHandle, firstChunk, completed, chunks: receivedChunks };
}

async function collectHttpRequest(
  url: URL,
  body: Buffer,
  headers: Record<string, string>,
): Promise<HttpObservation> {
  return startHttpRequest(url, body, headers).completed;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = (): void => finish(true);
    const deadline = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function cleanupBuiltPackage(
  child: ChildProcess | undefined,
  testHome: string,
  signal: "SIGTERM" | "SIGINT" = "SIGTERM",
): Promise<void> {
  try {
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    if (await waitForChildExit(child, 2_000)) return;
    child.kill("SIGKILL");
    if (!await waitForChildExit(child, 2_000)) {
      throw new Error(`test child ${String(child.pid)} survived SIGKILL`);
    }
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
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
  config?: Record<string, unknown>;
  readinessTimeoutMs?: number;
}): Promise<RunningPackage> {
  const testHome = mkdtempSync(join(tmpdir(), "cc-router-bootstrap-"));
  let child: ChildProcess | undefined;
  try {
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
    writeFileSync(configPath, JSON.stringify(options.config ?? {}));

    writeFileSync(preloadPath, `
import { ServerResponse } from "node:http";
const realFetch = globalThis.fetch;
const targetOrigin = ${JSON.stringify(options.targetOrigin)};
const telemetryOrigin = ${JSON.stringify(options.telemetryCaptureOrigin)};
const originalWriteHead = ServerResponse.prototype.writeHead;
ServerResponse.prototype.writeHead = function (...args) {
  if (!this.hasHeader("date")) this.setHeader("date", "Thu, 01 Jan 1970 00:00:00 GMT");
  return originalWriteHead.apply(this, args);
};
Math.random = () => 0;
globalThis.fetch = async (input, init) => {
  const original = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (original.hostname === "chatgpt.com" && original.pathname === "/backend-api/codex/responses") {
    if (String(init?.body ?? "").includes("telemetry_hostile_error")) {
      const hostile = await realFetch(new URL(original.pathname, targetOrigin), init);
      await hostile.arrayBuffer();
      const error = new Error(${JSON.stringify(TELEMETRY_CANARY.exceptionMessage)});
      error.stack = ${JSON.stringify(`Error: ${TELEMETRY_CANARY.exceptionMessage}\n    at private (${TELEMETRY_CANARY.homePath}/private.js:1:2)`)};
      throw error;
    }
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
    child = spawn(executable, childArgs, {
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
    let startupError: Error | undefined;
    child.once("error", error => {
      startupError = error;
      output += `${error.stack ?? error.message}\n`;
    });
    child.stdout?.on("data", chunk => { output += chunk.toString(); });
    child.stderr?.on("data", chunk => { output += chunk.toString(); });

    await waitUntil(async () => {
      if (startupError) throw startupError;
      if (child!.exitCode !== null) return false;
      try {
        const response = await fetch(`http://127.0.0.1:${options.proxyPort}/cc-router/health`);
        return response.ok;
      } catch {
        return false;
      }
    }, options.readinessTimeoutMs ?? 8_000, () => `compiled package did not start\n${output}`);

    let stopPromise: Promise<void> | undefined;
    const readyChild = child;
    return {
      child: readyChild,
      output: () => output,
      stop: (signal = "SIGTERM") => {
        stopPromise ??= cleanupBuiltPackage(readyChild, testHome, signal);
        return stopPromise;
      },
    };
  } catch (error) {
    await cleanupBuiltPackage(child, testHome);
    throw error;
  }
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
  const targetFlows: Array<{
    flow: string;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }> = [];
  const releaseTargetFlow = new Map<string, () => void>();
  const closedTargetFlows: string[] = [];
  const hostileStatusDescriptions: string[] = [];
  const hostileResponseBodies: Buffer[] = [];
  const children: RunningPackage[] = [];
  const auxiliaryServers: Server[] = [];

  beforeAll(async () => {
    execFileSync("pnpm", ["build"], { cwd: PROJECT_ROOT, stdio: "pipe" });
    target = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        response.sendDate = false;
        response.setHeader("date", "Thu, 01 Jan 1970 00:00:00 GMT");
        targetHeaders.push({ ...request.headers });
        const body = Buffer.concat(chunks);
        targetBodies.push(body);
        const flow = String(request.headers["x-test-flow"] ?? "openai");
        if (request.url === "/hostile-status" || body.includes("telemetry_hostile_error")) {
          response.statusMessage = TELEMETRY_CANARY.exceptionMessage;
          hostileStatusDescriptions.push(response.statusMessage);
          hostileResponseBodies.push(Buffer.from(TELEMETRY_CANARY.rawProviderBody));
          response.writeHead(599, {
            "content-type": "application/json",
            "x-hostile-path": TELEMETRY_CANARY.homePath,
          });
          response.end(TELEMETRY_CANARY.rawProviderBody);
          return;
        }
        if (request.url === "/v1/messages") {
          targetFlows.push({ flow, headers: { ...request.headers }, body });
          const ssePrefix = Buffer.from(`event: ping\ndata: {"flow":"${flow}"}\n\n`);
          const sseSuffix = Buffer.from("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
          if (flow === "timeout") {
            response.once("close", () => closedTargetFlows.push(flow));
            return;
          }
          if (flow === "abort" || flow.startsWith("concurrent-")) {
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              "x-upstream-marker": "transparent",
            });
            response.write(ssePrefix);
            response.once("close", () => closedTargetFlows.push(flow));
            releaseTargetFlow.set(flow, () => {
              if (!response.destroyed) response.end(sseSuffix);
            });
            return;
          }
          if (flow === "sse") {
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              "x-upstream-marker": "transparent",
            });
            response.write(ssePrefix.subarray(0, 11));
            response.write(ssePrefix.subarray(11));
            response.end(sseSuffix);
            return;
          }
          if (flow === "failure") {
            const failureBody = Buffer.from("{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}\n");
            response.writeHead(429, {
              "content-type": "application/json",
              "retry-after": "60",
              "x-upstream-marker": "transparent",
            });
            response.write(failureBody.subarray(0, 13));
            response.end(failureBody.subarray(13));
            return;
          }
          const nonStreamBody = Buffer.from("{\"type\":\"message\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}\n");
          response.writeHead(201, {
            "content-type": "application/json",
            "content-length": String(nonStreamBody.length),
            "x-upstream-marker": "transparent",
          });
          response.write(nonStreamBody.subarray(0, 9));
          response.end(nonStreamBody.subarray(9));
          return;
        }
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
    await Promise.all([close(target), telemetry.close(), ...auxiliaryServers.map(close)]);
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

  it("launches the installed tarball through its ESM hook with semantic privacy and isolated kill switches", async () => {
    const observations: Array<{ status: number; headers: Record<string, string>; body: Buffer; forwardedBody: Buffer }> = [];
    const modes = [
      {
        name: "enabled",
        telemetryEnabled: true,
        environment: { DO_NOT_TRACK: "0", CC_ROUTER_TELEMETRY: "1" },
      },
      {
        name: "persisted opt-out",
        telemetryEnabled: false,
        environment: { DO_NOT_TRACK: "0", CC_ROUTER_TELEMETRY: "1" },
      },
      {
        name: "DO_NOT_TRACK=1",
        telemetryEnabled: true,
        environment: { DO_NOT_TRACK: "1", CC_ROUTER_TELEMETRY: "1" },
      },
      {
        name: "CC_ROUTER_TELEMETRY=0",
        telemetryEnabled: true,
        environment: { DO_NOT_TRACK: "0", CC_ROUTER_TELEMETRY: "0" },
      },
    ] as const;
    for (const mode of modes) {
      const isolatedCapture = await startTransportCaptureServer();
      try {
      const targetBefore = targetBodies.length;
      const proxyPort = await reserveLoopbackPort();
      const running = await startBuiltPackage({
        telemetryEnabled: mode.telemetryEnabled,
        proxyPort,
        targetOrigin,
        telemetryCaptureOrigin: isolatedCapture.origin,
        environment: mode.environment,
        binary: installedBinary,
        cwd: installedCwd,
        launchBinaryDirectly: true,
      });
      children.push(running);
      try {
        const requestBody = JSON.stringify({
          model: "openai/gpt-5.5",
          input: [{ role: "user", content: [{
            type: "input_text",
            text: Object.values(TELEMETRY_CANARY).join("\n"),
          }] }],
          metadata: { escaped: JSON.stringify({ privateBody: TELEMETRY_CANARY.rawProviderBody }) },
          stream: false,
        });
        const carrierValues = semanticStrings(JSON.parse(requestBody));
        for (const canary of Object.values(TELEMETRY_CANARY)) {
          expect(carrierValues.some(value => value.includes(canary)), canary).toBe(true);
        }
        const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses${TELEMETRY_CANARY.queryString}`, {
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
        });
        const responseBody = Buffer.from(await response.arrayBuffer());
        expect(response.status, `${mode.name}\n${running.output()}`).toBe(200);
        expect(targetBodies).toHaveLength(targetBefore + 1);
        observations.push({
          status: response.status,
          headers: Object.fromEntries([...response.headers].sort()),
          body: responseBody,
          forwardedBody: targetBodies.at(-1)!,
        });
        if (mode.name === "enabled") {
          await waitUntil(
            () => isolatedCapture.requests.some(request => request.url === "/i/v1/traces"),
            8_000,
            () => `installed package exported no traces\n${running.output()}`,
          );
          const decodedPayloads = isolatedCapture.requests.map(request => request.json
            ?? decodeOtlpProtobuf(request.rawBody, request.url.endsWith("traces") ? "traces" : "logs"));
          const decodedValues = semanticStrings(decodedPayloads);
          const capturedWire = Buffer.concat(isolatedCapture.requests.map(request => request.rawBody));
          expect(decodedValues).toContain("@opentelemetry/instrumentation-express");
          expect(decodedValues).toContain("@opentelemetry/instrumentation-undici");
          expect(decodedValues).toContain("proxy.request");
          expect(decodedValues).toContain("provider.inference");
          for (const canary of Object.values(TELEMETRY_CANARY)) {
            expect(decodedValues.some(value => value.includes(canary)), canary).toBe(false);
            for (const representation of telemetryWireRepresentations(canary)) {
              expect(capturedWire.includes(Buffer.from(representation)), representation).toBe(false);
            }
          }
          expect(targetHeaders.at(-1)).not.toHaveProperty("traceparent");
          expect(targetHeaders.at(-1)).not.toHaveProperty("tracestate");
          expect(targetHeaders.at(-1)).not.toHaveProperty("baggage");
        }
      } finally {
        await running.stop("SIGTERM");
      }
      isolatedCapture.assertOnlyApprovedRequests();
      if (mode.name !== "enabled") {
        expect(isolatedCapture.requests, `${mode.name} emitted during request or shutdown drain`).toEqual([]);
      }
      } finally {
        await isolatedCapture.close();
      }
    }
    expect(observations).toHaveLength(modes.length);
    for (const observation of observations.slice(1)) expect(observation).toEqual(observations[0]);
  }, 60_000);

  it("removes a real automatic Express error message, stack, and status description before OTLP export", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "cc-router-auto-express-error-"));
    let capture: TransportCaptureServer | undefined;
    try {
      const candidateMarker = join(testHome, "candidate.json");
      const networkGuardMarker = join(testHome, "network-guard.json");
      const telemetryPath = join(testHome, "telemetry.json");
      writeFileSync(telemetryPath, JSON.stringify({
        enabled: true,
        installId: "70d8062e-1fa0-4ae4-a115-bf782ecca462",
        firstRunAt: "2026-08-03T00:00:00.000Z",
      }));
      capture = await startTransportCaptureServer();
      await runNodeFixture(
        join(import.meta.dirname, "fixtures", "otel-auto-error-carrier-bootstrap.mjs"),
        {
          NODE_ENV: "test",
          TELEMETRY_PATH: telemetryPath,
          CC_ROUTER_TEST_TRACE_ID: "00000000000000000000000000000001",
          CC_ROUTER_TEST_OTLP_TRACE_URL: capture.endpoint("/i/v1/traces"),
          CC_ROUTER_TEST_OTLP_LOG_URL: capture.endpoint("/i/v1/logs"),
          CC_ROUTER_TEST_POSTHOG_ORIGIN: capture.origin,
          CC_ROUTER_TEST_CANDIDATE_MARKER: candidateMarker,
          CC_ROUTER_TEST_NETWORK_GUARD_MARKER: networkGuardMarker,
          CC_ROUTER_TEST_HOSTILE_MESSAGE: TELEMETRY_CANARY.exceptionMessage,
          CC_ROUTER_TEST_HOSTILE_STACK_PATH: TELEMETRY_CANARY.homePath,
          CC_ROUTER_TEST_FATAL_MESSAGE: TELEMETRY_CANARY.prompt,
        },
      );

      const candidate = JSON.parse(readFileSync(candidateMarker, "utf8")) as {
        scope: string;
        status: { code: number; message?: string };
        events: Array<{ name: string; attributes: Record<string, unknown> }>;
        attributes: Record<string, unknown>;
      };
      expect(candidate.scope).toBe("@opentelemetry/instrumentation-express");
      expect(candidate.status).toEqual({ code: 2, message: TELEMETRY_CANARY.exceptionMessage });
      expect(candidate.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "exception",
          attributes: expect.objectContaining({
            "exception.message": TELEMETRY_CANARY.exceptionMessage,
            "exception.stacktrace": expect.stringContaining(TELEMETRY_CANARY.homePath),
          }),
        }),
      ]));
      expect(candidate.attributes["cc_router.operation"]).toBe("proxy.request");

      const networkGuard = JSON.parse(readFileSync(networkGuardMarker, "utf8")) as {
        blocked: string[];
        redirected: string[];
        fatalCaptured: boolean;
      };
      expect(networkGuard).toEqual({
        blocked: ["POST https://external.invalid/forbidden"],
        redirected: ["POST https://eu.i.posthog.com/batch/"],
        fatalCaptured: true,
      });
      expect(capture.requests.map(request => `${request.method} ${request.url}`).sort()).toEqual([
        "POST /batch/",
        "POST /i/v1/traces",
      ]);
      capture.assertOnlyApprovedRequests();
      const decoded = capture.requests.map(request => request.json
        ?? decodeOtlpProtobuf(request.rawBody, request.url.endsWith("traces") ? "traces" : "logs"));
      const decodedValues = semanticStrings(decoded);
      const wire = Buffer.concat(capture.requests.map(request => request.rawBody));
      expect(decodedValues).toContain("@opentelemetry/instrumentation-express");
      expect(decodedValues).toContain("proxy.request");
      expect(decodedValues).toContain("$exception");
      for (const canary of [
        TELEMETRY_CANARY.exceptionMessage,
        TELEMETRY_CANARY.homePath,
        TELEMETRY_CANARY.prompt,
      ]) {
        expect(decodedValues.some(value => value.includes(canary)), canary).toBe(false);
        for (const representation of telemetryWireRepresentations(canary)) {
          expect(wire.includes(Buffer.from(representation)), representation).toBe(false);
        }
      }
    } finally {
      if (capture) await capture.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  }, 20_000);

  it("cleans a child, listener, and temp home when package readiness times out", async () => {
    const markerHome = mkdtempSync(join(tmpdir(), "cc-router-readiness-marker-"));
    const markerPath = join(markerHome, "resources.json");
    let resources: { pid: number; home: string; port: number } | undefined;
    let capture: TransportCaptureServer | undefined;
    try {
      capture = await startTransportCaptureServer();
      const proxyPort = await reserveLoopbackPort();
      await expect(startBuiltPackage({
        telemetryEnabled: true,
        proxyPort,
        targetOrigin,
        telemetryCaptureOrigin: capture.origin,
        binary: join(import.meta.dirname, "fixtures", "unready-package.mjs"),
        readinessTimeoutMs: 150,
        environment: { CC_ROUTER_TEST_STARTUP_MARKER: markerPath },
      })).rejects.toThrow("compiled package did not start");
      resources = JSON.parse(readFileSync(markerPath, "utf8")) as typeof resources;
      expect(resources).toBeDefined();
      expect(existsSync(resources!.home), "failed startup leaked its temp home").toBe(false);
      expect(() => process.kill(resources!.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      await expect(fetch(`http://127.0.0.1:${resources!.port}/cc-router/health`)).rejects.toThrow();
    } finally {
      if (resources) {
        try {
          process.kill(resources.pid, "SIGKILL");
        } catch {
          // Already reaped by the helper, as required.
        }
        rmSync(resources.home, { recursive: true, force: true });
      }
      if (capture) await capture.close();
      rmSync(markerHome, { recursive: true, force: true });
    }
  }, 12_000);

  it("sanitizes a production PostHog exception after a hostile provider failure", async () => {
    let capture: TransportCaptureServer | undefined;
    let running: RunningPackage | undefined;
    try {
      capture = await startTransportCaptureServer();
      const proxyPort = await reserveLoopbackPort();
      running = await startBuiltPackage({
        telemetryEnabled: true,
        proxyPort,
        targetOrigin,
        telemetryCaptureOrigin: capture.origin,
        environment: { DO_NOT_TRACK: "0", CC_ROUTER_TELEMETRY: "1" },
        binary: installedBinary,
        cwd: installedCwd,
        launchBinaryDirectly: true,
      });
      children.push(running);
      const hostileBefore = hostileStatusDescriptions.length;
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses${TELEMETRY_CANARY.queryString}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hostile-path": TELEMETRY_CANARY.homePath,
        },
        body: JSON.stringify({
          model: "openai/gpt-5.5",
          input: [{ role: "user", content: "telemetry_hostile_error" }],
          metadata: {
            nested: JSON.stringify({
              message: TELEMETRY_CANARY.exceptionMessage,
              stack: `${TELEMETRY_CANARY.homePath}/private.js:1:2`,
              providerBody: TELEMETRY_CANARY.rawProviderBody,
            }),
          },
          stream: false,
        }),
      });
      expect(response.status).toBe(500);
      await response.arrayBuffer();
      expect(hostileStatusDescriptions.slice(hostileBefore)).toEqual([
        TELEMETRY_CANARY.exceptionMessage,
      ]);
      expect(hostileResponseBodies.at(-1)?.toString("utf8")).toBe(TELEMETRY_CANARY.rawProviderBody);
      await waitUntil(
        () => capture.requests.some(request => request.url === "/i/v1/traces")
          && capture.requests.some(request => request.url === "/batch/"),
        8_000,
        () => `hostile provider flow exported no sanitized PostHog exception or trace\n${running.output()}`,
      );
      await running.stop("SIGTERM");
      capture.assertOnlyApprovedRequests();
      expect(semanticStrings(capture.requests
        .filter(request => request.url === "/batch/")
        .map(request => request.json))).toContain("$exception");
      const decodedPayloads = capture.requests.map(request => request.json
        ?? decodeOtlpProtobuf(request.rawBody, request.url.endsWith("traces") ? "traces" : "logs"));
      const decodedValues = semanticStrings(decodedPayloads);
      const capturedWire = Buffer.concat(capture.requests.map(request => request.rawBody));
      for (const canary of [
        TELEMETRY_CANARY.exceptionMessage,
        TELEMETRY_CANARY.homePath,
        TELEMETRY_CANARY.rawProviderBody,
        TELEMETRY_CANARY.queryString,
      ]) {
        expect(decodedValues.some(value => value.includes(canary)), canary).toBe(false);
        for (const representation of telemetryWireRepresentations(canary)) {
          expect(capturedWire.includes(Buffer.from(representation)), representation).toBe(false);
        }
      }
    } finally {
      if (running) await running.stop("SIGTERM");
      if (capture) await capture.close();
    }
  }, 20_000);

  it("keeps the real Anthropic proxy byte-transparent when telemetry is enabled, disabled, or failing", async () => {
    const priorEnvironment = {
      DO_NOT_TRACK: process.env["DO_NOT_TRACK"],
      CC_ROUTER_TELEMETRY: process.env["CC_ROUTER_TELEMETRY"],
    };
    const modes = [
      { name: "enabled", telemetryEnabled: true, responseMode: "success" },
      { name: "disabled", telemetryEnabled: false, responseMode: "success" },
      { name: "failing", telemetryEnabled: true, responseMode: "reset" },
    ] as const;
    const snapshots: Array<{
      responses: Record<string, HttpObservation>;
      forwarded: Array<{ flow: string; headers: Record<string, string | string[] | undefined>; body: Buffer }>;
      concurrency: string[];
      abortPrefix: Buffer;
      abortClosed: boolean;
      timeoutClosed: boolean;
    }> = [];
    const requestBody = (flow: string, stream: boolean): Buffer => Buffer.from(JSON.stringify({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: `transparent-${flow}` }],
      max_tokens: 32,
      stream,
    }));
    const isStreamingFlow = (flow: string): boolean => flow === "sse"
      || flow === "abort"
      || flow.startsWith("concurrent-");
    const requestHeaders = (flow: string): Record<string, string> => ({
      "content-type": "application/json",
      "x-test-flow": flow,
      "x-claude-code-session-id": `session-${flow}`,
      "x-forwarded-private": "forwarded-byte-for-byte",
    });

    for (const mode of modes) {
      const modeCapture = await startTransportCaptureServer({ responseMode: mode.responseMode });
      try {
      expect(process.env["DO_NOT_TRACK"]).toBe(priorEnvironment.DO_NOT_TRACK);
      expect(process.env["CC_ROUTER_TELEMETRY"]).toBe(priorEnvironment.CC_ROUTER_TELEMETRY);
      const flowBefore = targetFlows.length;
      const closedBefore = closedTargetFlows.length;
      const proxyPort = await reserveLoopbackPort();
      const running = await startBuiltPackage({
        telemetryEnabled: mode.telemetryEnabled,
        proxyPort,
        targetOrigin,
        telemetryCaptureOrigin: modeCapture.origin,
        environment: { DO_NOT_TRACK: "0", CC_ROUTER_TELEMETRY: "1", LITELLM_URL: targetOrigin },
        config: { proxyRequestTimeoutMs: 150 },
        accounts: [{
          id: "transparent-anthropic",
          provider: "anthropic_subscription",
          accessToken: "transparent-access-token",
          refreshToken: "transparent-refresh-token",
          expiresAt: Date.now() + 3_600_000,
          scopes: ["user:inference"],
          enabled: true,
        }],
        binary: installedBinary,
        cwd: installedCwd,
        launchBinaryDirectly: true,
      });
      children.push(running);
      const base = `http://127.0.0.1:${proxyPort}/v1/messages`;
      const responses: Record<string, HttpObservation> = {};
      let abortPrefix = Buffer.alloc(0);
      try {
        for (const flow of ["nonstream", "sse"] as const) {
          responses[flow] = await collectHttpRequest(
            new URL(base),
            requestBody(flow, flow === "sse"),
            requestHeaders(flow),
          );
        }

        const concurrentOne = startHttpRequest(
          new URL(base), requestBody("concurrent-one", true), requestHeaders("concurrent-one"),
        );
        const concurrentTwo = startHttpRequest(
          new URL(base), requestBody("concurrent-two", true), requestHeaders("concurrent-two"),
        );
        let oneCompleted = false;
        let twoCompleted = false;
        void concurrentOne.completed.then(() => { oneCompleted = true; });
        void concurrentTwo.completed.then(() => { twoCompleted = true; });
        await Promise.all([concurrentOne.firstChunk, concurrentTwo.firstChunk]);
        expect(oneCompleted).toBe(false);
        expect(twoCompleted).toBe(false);
        releaseTargetFlow.get("concurrent-one")?.();
        responses["concurrent-one"] = await concurrentOne.completed;
        expect(twoCompleted).toBe(false);
        releaseTargetFlow.get("concurrent-two")?.();
        responses["concurrent-two"] = await concurrentTwo.completed;

        const abort = startHttpRequest(new URL(base), requestBody("abort", true), requestHeaders("abort"));
        void abort.completed.catch(() => undefined);
        await abort.firstChunk;
        abortPrefix = Buffer.concat(abort.chunks);
        abort.request.destroy();
        await waitUntil(
          () => closedTargetFlows.slice(closedBefore).includes("abort"),
          2_000,
          () => `${mode.name} abort did not close upstream`,
        );

        try {
          responses.timeout = await collectHttpRequest(
            new URL(base), requestBody("timeout", false), requestHeaders("timeout"),
          );
        } catch (error) {
          responses.timeout = {
            status: 0,
            headers: { "x-client-error": String((error as NodeJS.ErrnoException).code ?? "unknown") },
            chunks: [],
            body: Buffer.alloc(0),
          };
        }
        await waitUntil(
          () => closedTargetFlows.slice(closedBefore).includes("timeout"),
          2_000,
          () => `${mode.name} timeout did not close upstream`,
        );
        responses.failure = await collectHttpRequest(
          new URL(base), requestBody("failure", false), requestHeaders("failure"),
        );
      } finally {
        for (const release of releaseTargetFlow.values()) release();
        releaseTargetFlow.clear();
        await running.stop("SIGTERM");
      }
      modeCapture.assertOnlyApprovedRequests();
      if (mode.name === "enabled") expect(modeCapture.requests.length).toBeGreaterThan(0);
      if (mode.name === "disabled") expect(modeCapture.requests).toEqual([]);
      if (mode.name === "failing") expect(modeCapture.requests.length).toBeGreaterThan(0);
      expect(process.env["DO_NOT_TRACK"]).toBe(priorEnvironment.DO_NOT_TRACK);
      expect(process.env["CC_ROUTER_TELEMETRY"]).toBe(priorEnvironment.CC_ROUTER_TELEMETRY);
      const forwarded = targetFlows.slice(flowBefore)
        .sort((left, right) => left.flow.localeCompare(right.flow));
      expect(forwarded.map(flow => flow.flow)).toEqual([
        "abort",
        "concurrent-one",
        "concurrent-two",
        "failure",
        "nonstream",
        "sse",
        "timeout",
      ]);
      for (const flow of forwarded) {
        expect(flow.headers["authorization"]).toBe("Bearer transparent-access-token");
        expect(flow.headers["x-forwarded-private"]).toBe("forwarded-byte-for-byte");
        expect(flow.body).toEqual(requestBody(flow.flow, isStreamingFlow(flow.flow)));
      }
      snapshots.push({
        responses,
        forwarded,
        concurrency: ["concurrent-one", "concurrent-two"],
        abortPrefix,
        abortClosed: closedTargetFlows.slice(closedBefore).includes("abort"),
        timeoutClosed: closedTargetFlows.slice(closedBefore).includes("timeout"),
      });
      } finally {
        await modeCapture.close();
      }
    }

    expect(snapshots).toHaveLength(3);
    for (const snapshot of snapshots) {
      expect(snapshot.responses.nonstream!.status).toBe(201);
      expect(snapshot.responses.nonstream!.body).toEqual(Buffer.from("{\"type\":\"message\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}\n"));
      expect(snapshot.responses.failure!.status).toBe(429);
      expect(snapshot.responses.failure!.headers["retry-after"]).toBe("60");
      expect(snapshot.responses.failure!.body).toEqual(Buffer.from("{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}\n"));
      for (const flow of ["sse", "concurrent-one", "concurrent-two"] as const) {
        const text = snapshot.responses[flow]!.body.toString("utf8");
        expect(snapshot.responses[flow]!.status).toBe(200);
        expect(snapshot.responses[flow]!.headers["x-upstream-marker"]).toBe("transparent");
        expect(text.indexOf("event: ping")).toBeLessThan(text.indexOf("event: message_stop"));
        expect(text.match(/event: message_stop/g)).toHaveLength(1);
      }
      expect(snapshot.responses.timeout).toEqual({
        status: 0,
        headers: { "x-client-error": "ECONNRESET" },
        chunks: [],
        body: Buffer.alloc(0),
      });
      expect(snapshot.abortPrefix).toEqual(Buffer.from("event: ping\ndata: {\"flow\":\"abort\"}\n\n"));
      expect(snapshot.abortClosed).toBe(true);
      expect(snapshot.timeoutClosed).toBe(true);
    }
    for (const snapshot of snapshots.slice(1)) expect(snapshot).toEqual(snapshots[0]);
  }, 60_000);

  it("uses an environment LiteLLM target for both forwarding and outgoing span trust", async () => {
    const before = telemetry.requests.length;
    const environmentTargetPaths: string[] = [];
    const environmentTargetServer = createServer((request, response) => {
      environmentTargetPaths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "env_target_response" }));
    });
    let running: RunningPackage | undefined;
    try {
      const environmentTargetPort = await listen(environmentTargetServer);
      const proxyPort = await reserveLoopbackPort();
      const environmentTarget = `http://127.0.0.1:${environmentTargetPort}`;
      running = await startBuiltPackage({
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
      if (running) await running.stop();
      if (environmentTargetServer.listening) await close(environmentTargetServer);
      else environmentTargetServer.closeAllConnections();
    }
  }, 20_000);

  it("does not initialize or export from the compiled package when persisted telemetry is off", async () => {
    const before = telemetry.requests.length;
    const proxyPort = await reserveLoopbackPort();
    const running = await startBuiltPackage({
      telemetryEnabled: false,
      proxyPort,
      targetOrigin,
      telemetryCaptureOrigin: telemetry.origin,
    });
    children.push(running);
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.5", input: [], stream: false }),
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    } finally {
      await running.stop();
    }
    expect(telemetry.requests).toHaveLength(before);
  }, 15_000);

  it("fails closed before SDK initialization when a test OTLP override is not literal loopback", async () => {
    let isolatedCapture: TransportCaptureServer | undefined;
    let running: RunningPackage | undefined;
    try {
      isolatedCapture = await startTransportCaptureServer();
      const proxyPort = await reserveLoopbackPort();
      running = await startBuiltPackage({
        telemetryEnabled: true,
        proxyPort,
        targetOrigin,
        telemetryCaptureOrigin: isolatedCapture.origin,
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
      expect(isolatedCapture.requests).toEqual([]);
    } finally {
      if (running) await running.stop();
      if (isolatedCapture) await isolatedCapture.close();
    }
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
      const proxyPort = await reserveLoopbackPort();
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
    const proxyPort = await reserveLoopbackPort();
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
