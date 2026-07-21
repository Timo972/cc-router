import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";

const TEST_STATE = vi.hoisted(() => {
  const tmp = process.env["TMPDIR"] ?? process.env["TEMP"] ?? "/tmp";
  return {
    dir: `${tmp}/cc-router-client-lifecycle-${process.pid}`,
    inputs: [] as string[],
    selects: [] as string[],
    confirms: [] as boolean[],
  };
});

vi.mock("../config/paths.js", () => ({
  CLAUDE_SETTINGS_PATH: `${TEST_STATE.dir}/settings.json`,
  CONFIG_DIR: TEST_STATE.dir,
  ACCOUNTS_PATH: `${TEST_STATE.dir}/accounts.json`,
  CONFIG_PATH: `${TEST_STATE.dir}/config.json`,
  PROXY_PORT: 3456,
  LITELLM_PORT: 4000,
  LITELLM_URL: undefined,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (candidate: import("node:fs").PathLike) =>
      String(candidate) === "/Applications/Claude.app" || actual.existsSync(candidate),
  };
});

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: (candidate: import("fs").PathLike) =>
      String(candidate) === "/Applications/Claude.app" || actual.existsSync(candidate),
  };
});

vi.mock("@inquirer/prompts", () => ({
  input: vi.fn(async () => TEST_STATE.inputs.shift() ?? ""),
  select: vi.fn(async () => TEST_STATE.selects.shift()),
  confirm: vi.fn(async () => TEST_STATE.confirms.shift() ?? false),
  password: vi.fn(async () => ""),
  number: vi.fn(async () => 1),
}));

vi.mock("../utils/platform.js", () => ({
  detectPlatform: () => "macos",
  isMacos: () => true,
  isWindows: () => false,
}));

vi.mock("../interceptor/mitmproxy-manager.js", () => ({
  checkMitmproxyInstalled: vi.fn(async () => true),
  isCaCertInstalled: vi.fn(() => true),
  generateCaCert: vi.fn(async () => undefined),
  installCaCert: vi.fn(async () => true),
  writeAddonScript: vi.fn(),
  startInterceptor: vi.fn(async () => undefined),
  stopInterceptor: vi.fn(async () => undefined),
  isInterceptorRunning: vi.fn(async () => false),
  getProcessName: vi.fn(() => "Claude"),
  getNetworkExtensionStatus: vi.fn(async () => "enabled"),
  openNetworkExtensionSettings: vi.fn(async () => undefined),
  installInterceptorService: vi.fn(async () => true),
  uninstallInterceptorService: vi.fn(async () => undefined),
  isInterceptorServiceInstalled: vi.fn(() => false),
}));

vi.mock("../utils/telemetry.js", () => ({ trackEvent: vi.fn() }));

import * as fs from "node:fs";
import { Command } from "commander";
import { registerClient } from "../cli/cmd-client.js";
import { runSetupWizard } from "../cli/cmd-setup.js";

const settingsPath = path.join(TEST_STATE.dir, "settings.json");
const configPath = path.join(TEST_STATE.dir, "config.json");

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, any>;
}

function seedClaudeSettings(): void {
  fs.writeFileSync(configPath, JSON.stringify({
    proxySecret: "local-secret",
    autoUpdate: false,
    futureSetting: { keep: true },
  }));
  fs.writeFileSync(settingsPath, JSON.stringify({
    env: {
      KEEP_ME: "yes",
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: "600000",
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "900000",
    },
  }));
}

async function runClient(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerClient(program);
  await program.parseAsync(["node", "cc-router", "client", ...args]);
}

beforeEach(() => {
  fs.mkdirSync(TEST_STATE.dir, { recursive: true });
  TEST_STATE.inputs.length = 0;
  TEST_STATE.selects.length = 0;
  TEST_STATE.confirms.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    status: "ok",
    accounts: [{ id: "one" }],
  }), { status: 200, headers: { "content-type": "application/json" } })));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(TEST_STATE.dir, { recursive: true, force: true });
});

describe("client config lifecycle", () => {
  it("preserves the watchdog backup through Desktop connect, disconnect, and a second cycle", async () => {
    seedClaudeSettings();
    TEST_STATE.confirms.push(true, false);

    await runClient("connect", "https://router.example", "--secret", "secret", "--desktop");

    let config = readJson(configPath);
    expect(config.client).toMatchObject({
      remoteUrl: "https://router.example",
      remoteSecret: "secret",
      desktopEnabled: true,
    });
    expect(config.claudeEnvBackup).toEqual({
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: { existed: true, value: "600000" },
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: { existed: true, value: "900000" },
    });
    expect(config).toMatchObject({
      proxySecret: "local-secret",
      autoUpdate: false,
      futureSetting: { keep: true },
    });

    await runClient("disconnect");

    config = readJson(configPath);
    expect(config.client).toBeUndefined();
    expect(config.claudeEnvBackup).toBeUndefined();
    expect(config).toMatchObject({
      proxySecret: "local-secret",
      autoUpdate: false,
      futureSetting: { keep: true },
    });
    let settings = readJson(settingsPath);
    expect(settings.env).toEqual({
      KEEP_ME: "yes",
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: "600000",
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "900000",
    });

    TEST_STATE.confirms.push(true, false);
    await runClient("connect", "https://router.example", "--secret", "secret", "--desktop");
    await runClient("disconnect");

    config = readJson(configPath);
    expect(config.client).toBeUndefined();
    expect(config.claudeEnvBackup).toBeUndefined();
    settings = readJson(settingsPath);
    expect(settings.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("600000");
    expect(settings.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBe("900000");
  });

  it("preserves the watchdog backup through setup-wizard Desktop configuration", async () => {
    seedClaudeSettings();
    TEST_STATE.selects.push("client");
    TEST_STATE.inputs.push("router.example", "secret");
    TEST_STATE.confirms.push(true, false);

    await runSetupWizard({ addMode: false });

    const config = readJson(configPath);
    expect(config.client).toMatchObject({
      remoteUrl: "http://router.example",
      remoteSecret: "secret",
      desktopEnabled: true,
    });
    expect(config.claudeEnvBackup).toEqual({
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: { existed: true, value: "600000" },
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: { existed: true, value: "900000" },
    });
    expect(config).toMatchObject({
      proxySecret: "local-secret",
      autoUpdate: false,
      futureSetting: { keep: true },
    });
  });
});
