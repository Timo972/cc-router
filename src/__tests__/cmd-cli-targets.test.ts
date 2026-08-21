import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeClaudeSettings: vi.fn(),
  removeClaudeSettings: vi.fn(),
  readClaudeProxySettings: vi.fn(() => ({})),
  writeCodexRouterConfig: vi.fn(() => ({ path: "/tmp/codex/config.toml" })),
  writeCodexRouterConfigFromClient: vi.fn(() => ({ path: "/tmp/codex/config.toml", hasSecret: false })),
  removeCodexRouterConfig: vi.fn(() => ({ path: "/tmp/codex/config.toml", removed: true })),
  readCodexRouterConfig: vi.fn(() => ({ path: "/tmp/codex/config.toml", configured: false })),
  readConfig: vi.fn(() => ({ runPreferences: { mode: "background" as const, serverMode: false, port: 3456 } })),
  isProxyRunning: vi.fn(async () => true),
}));

vi.mock("../utils/claude-config.js", () => ({
  writeClaudeSettings: mocks.writeClaudeSettings,
  removeClaudeSettings: mocks.removeClaudeSettings,
  readClaudeProxySettings: mocks.readClaudeProxySettings,
}));

vi.mock("../utils/codex-config.js", () => ({
  writeCodexRouterConfig: mocks.writeCodexRouterConfig,
  writeCodexRouterConfigFromClient: mocks.writeCodexRouterConfigFromClient,
  removeCodexRouterConfig: mocks.removeCodexRouterConfig,
  readCodexRouterConfig: mocks.readCodexRouterConfig,
  codexBaseUrlFromRouterUrl: (url: string) => `${url.replace(/\/+$/, "")}/v1`,
}));

vi.mock("../config/manager.js", () => ({
  readConfig: mocks.readConfig,
}));

vi.mock("../daemon/pid.js", () => ({
  isProxyRunning: mocks.isProxyRunning,
}));

import { registerCliTargets } from "../cli/cmd-cli-targets.js";

function parse(argv: string[]): Promise<Command> {
  const program = new Command();
  program.exitOverride();
  registerCliTargets(program);
  return program.parseAsync(["node", "cc-router", ...argv]);
}

describe("cc-router cli claude/codex", () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readClaudeProxySettings.mockReturnValue({});
    mocks.readCodexRouterConfig.mockReturnValue({ path: "/tmp/codex/config.toml", configured: false });
    mocks.readConfig.mockReturnValue({ runPreferences: { mode: "background", serverMode: false, port: 3456 } });
    mocks.isProxyRunning.mockResolvedValue(true);
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
  });

  it("enables Claude routing without stopping the proxy", async () => {
    await parse(["cli", "claude", "start"]);
    expect(mocks.writeClaudeSettings).toHaveBeenCalledWith(3456, undefined, undefined, undefined);
    expect(mocks.removeClaudeSettings).not.toHaveBeenCalled();
  });

  it("disables Claude routing and leaves the proxy alone", async () => {
    mocks.readClaudeProxySettings.mockReturnValue({ baseUrl: "http://localhost:3456" });
    await parse(["cli", "claude", "stop"]);
    expect(mocks.removeClaudeSettings).toHaveBeenCalledOnce();
    expect(mocks.writeClaudeSettings).not.toHaveBeenCalled();
  });

  it("treats claude resume as start", async () => {
    await parse(["cli", "claude", "resume", "--model", "opus"]);
    expect(mocks.writeClaudeSettings).toHaveBeenCalledWith(3456, undefined, undefined, "opus");
  });

  it("enables and then disables Codex routing", async () => {
    await parse(["cli", "codex", "start"]);
    expect(mocks.writeCodexRouterConfig).toHaveBeenCalledWith({
      baseUrl: "http://localhost:3456/v1",
      tokenEnvKey: "CC_ROUTER_TOKEN",
      defaultModel: undefined,
    });

    mocks.readCodexRouterConfig.mockReturnValue({
      path: "/tmp/codex/config.toml",
      configured: true,
      baseUrl: "http://localhost:3456/v1",
    });
    await parse(["cli", "codex", "stop"]);
    expect(mocks.removeCodexRouterConfig).toHaveBeenCalledOnce();
  });

  it("prints both CLIs from cc-router cli", async () => {
    mocks.readClaudeProxySettings.mockReturnValue({ baseUrl: "http://localhost:3456", model: "opus" });
    await parse(["cli"]);
    const out = log.mock.calls.flat().join("\n");
    expect(out).toContain("Claude Code is routing through cc-router");
    expect(out).toContain("Codex CLI is using native OpenAI auth");
  });

  it("keeps cc-router claude as a shortcut for cli claude", async () => {
    await parse(["claude", "start"]);
    expect(mocks.writeClaudeSettings).toHaveBeenCalledWith(3456, undefined, undefined, undefined);
  });
});
