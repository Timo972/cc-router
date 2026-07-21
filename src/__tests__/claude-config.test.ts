import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// vi.hoisted runs BEFORE vi.mock factories — the only way to pass dynamic
// values into a mock factory in ESM+vitest
// vi.hoisted runs before ESM imports resolve — can only use Node globals, no imported modules
const MOCK_DIR = vi.hoisted(() => {
  const tmp = process.env["TMPDIR"] ?? process.env["TEMP"] ?? "/tmp";
  const id = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  return `${tmp}/cc-router-cfg-${id}`;
});

vi.mock("../config/paths.js", () => ({
  CLAUDE_SETTINGS_PATH: `${MOCK_DIR}/settings.json`,
  CONFIG_DIR: MOCK_DIR,
  ACCOUNTS_PATH: `${MOCK_DIR}/accounts.json`,
  CONFIG_PATH: `${MOCK_DIR}/config.json`,
  PROXY_PORT: 3456,
  LITELLM_PORT: 4000,
  LITELLM_URL: undefined,
}));

import {
  writeClaudeSettings,
  removeClaudeSettings,
  readClaudeProxySettings,
} from "../utils/claude-config.js";

const settingsPath = () => `${MOCK_DIR}/settings.json`;

beforeEach(() => {
  fs.mkdirSync(MOCK_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(MOCK_DIR, { recursive: true, force: true });
});

// ─── writeClaudeSettings ─────────────────────────────────────────────────────

describe("writeClaudeSettings", () => {
  it("creates settings.json when it doesn't exist", () => {
    writeClaudeSettings(3456);
    expect(fs.existsSync(settingsPath())).toBe(true);
  });

  it("writes ANTHROPIC_BASE_URL without /v1 suffix", () => {
    writeClaudeSettings(3456);
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://localhost:3456");
    expect(written.env.ANTHROPIC_BASE_URL).not.toContain("/v1");
  });

  it("sets ANTHROPIC_AUTH_TOKEN to proxy-managed", () => {
    writeClaudeSettings(3456);
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe("proxy-managed");
  });

  it("writes 30-minute event and byte stream idle watchdogs", () => {
    writeClaudeSettings(3456);
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("1800000");
    expect(written.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBe("1800000");
  });

  it("backs up pre-existing watchdog values only once", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      env: {
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: "600000",
        CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "900000",
      },
    }));
    writeClaudeSettings(3456);
    writeClaudeSettings(4567);
    const config = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
    expect(config.claudeEnvBackup).toEqual({
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: { existed: true, value: "600000" },
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: { existed: true, value: "900000" },
    });
  });

  it("merges with existing settings — preserves other top-level keys", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      model: "claude-opus-4-6",
      theme: "dark",
      env: { SOME_OTHER_VAR: "preserved" },
    }));

    writeClaudeSettings(3456);

    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.model).toBe("claude-opus-4-6");
    expect(written.theme).toBe("dark");
  });

  it("merges with existing env — preserves other env vars", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      env: { MY_VAR: "still-here", ANTHROPIC_BASE_URL: "old-value" },
    }));

    writeClaudeSettings(3456);

    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.MY_VAR).toBe("still-here");
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://localhost:3456");
  });

  it("uses the port passed as argument", () => {
    writeClaudeSettings(9999);
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://localhost:9999");
  });

  it("overwrites a previous cc-router config with a new port", () => {
    writeClaudeSettings(3456);
    writeClaudeSettings(4567);
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://localhost:4567");
  });

  it("writes the selected Claude Code model when provided", () => {
    writeClaudeSettings(3456, undefined, undefined, "openai/default");

    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.model).toBe("openai/default");
  });

  it("preserves an existing Claude Code model when no model is provided", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      model: "claude-opus-4-6",
      env: {},
    }));

    writeClaudeSettings(3456);

    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.model).toBe("claude-opus-4-6");
  });
});

// ─── removeClaudeSettings ─────────────────────────────────────────────────────

describe("removeClaudeSettings", () => {
  it("does nothing when settings file does not exist", () => {
    expect(() => removeClaudeSettings()).not.toThrow();
  });

  it("removes ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN", () => {
    writeClaudeSettings(3456);
    removeClaudeSettings();
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(written.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("restores watchdog values that existed before configuration", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      env: {
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: "600000",
        CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "900000",
      },
    }));
    writeClaudeSettings(3456);
    removeClaudeSettings();
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("600000");
    expect(written.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBe("900000");
    const config = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
    expect(config.claudeEnvBackup).toBeUndefined();
  });

  it("removes watchdog values that did not exist before configuration", () => {
    writeClaudeSettings(3456);
    removeClaudeSettings();
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env?.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBeUndefined();
    expect(written.env?.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBeUndefined();
  });

  it("preserves watchdog values changed by the user after configuration", () => {
    writeClaudeSettings(3456);
    const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    settings.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = "1200000";
    settings.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS = "1500000";
    fs.writeFileSync(settingsPath(), JSON.stringify(settings));
    removeClaudeSettings();
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("1200000");
    expect(written.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBe("1500000");
  });

  it("restores one managed watchdog while preserving a user edit to the other", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      env: {
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: "600000",
        CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "900000",
      },
    }));
    writeClaudeSettings(3456);
    const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    settings.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS = "1500000";
    fs.writeFileSync(settingsPath(), JSON.stringify(settings));

    removeClaudeSettings();

    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("600000");
    expect(written.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBe("1500000");
    const config = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
    expect(config.claudeEnvBackup).toBeUndefined();
  });

  it("clears a stale backup when the settings file is missing before the next cycle", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      env: {
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: "600000",
        CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "900000",
      },
    }));
    writeClaudeSettings(3456);
    fs.unlinkSync(settingsPath());

    removeClaudeSettings();

    let config = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
    expect(config.claudeEnvBackup).toBeUndefined();

    fs.writeFileSync(settingsPath(), JSON.stringify({
      env: {
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: "1200000",
        CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "1500000",
      },
    }));
    writeClaudeSettings(4567);
    config = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
    expect(config.claudeEnvBackup).toEqual({
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: { existed: true, value: "1200000" },
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: { existed: true, value: "1500000" },
    });
  });

  it("keeps the backup and propagates a settings write failure", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      env: {
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: "600000",
        CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "900000",
      },
    }));
    writeClaudeSettings(3456);
    fs.chmodSync(settingsPath(), 0o444);

    try {
      expect(() => removeClaudeSettings()).toThrow();
      const config = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
      expect(config.claudeEnvBackup).toBeDefined();
      const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
      expect(settings.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("1800000");
    } finally {
      fs.chmodSync(settingsPath(), 0o644);
    }
  });

  it("keeps the backup and propagates a settings read failure", () => {
    writeClaudeSettings(3456);
    fs.chmodSync(settingsPath(), 0o000);

    try {
      expect(() => removeClaudeSettings()).toThrow();
      const config = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
      expect(config.claudeEnvBackup).toBeDefined();
    } finally {
      fs.chmodSync(settingsPath(), 0o644);
    }
  });

  it("keeps the backup and propagates config cleanup failure after settings removal", () => {
    writeClaudeSettings(3456);
    fs.mkdirSync(`${MOCK_DIR}/config.json.tmp`);

    expect(() => removeClaudeSettings()).toThrow();

    let config = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
    expect(config.claudeEnvBackup).toBeDefined();
    const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(settings.env).toBeUndefined();

    fs.rmdirSync(`${MOCK_DIR}/config.json.tmp`);
    removeClaudeSettings();
    config = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
    expect(config.claudeEnvBackup).toBeUndefined();
  });

  it("leaves malformed settings and the watchdog backup untouched", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      env: {
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: "600000",
        CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "900000",
      },
    }));
    writeClaudeSettings(3456);
    const configBefore = fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8");
    fs.writeFileSync(settingsPath(), "{ malformed", "utf-8");

    removeClaudeSettings();

    expect(fs.readFileSync(settingsPath(), "utf-8")).toBe("{ malformed");
    expect(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8")).toBe(configBefore);
  });

  it("preserves other env vars after removal", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      env: { KEEP_ME: "yes", ANTHROPIC_BASE_URL: "http://localhost:3456", ANTHROPIC_AUTH_TOKEN: "proxy-managed" },
    }));
    removeClaudeSettings();
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env.KEEP_ME).toBe("yes");
  });

  it("removes the env block entirely after removing managed settings", () => {
    writeClaudeSettings(3456);
    removeClaudeSettings();
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.env).toBeUndefined();
    const config = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
    expect(config.claudeEnvBackup).toBeUndefined();
  });

  it("preserves other top-level keys after removal", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      model: "claude-opus-4-6",
      env: { ANTHROPIC_BASE_URL: "http://localhost:3456", ANTHROPIC_AUTH_TOKEN: "x" },
    }));
    removeClaudeSettings();
    const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(written.model).toBe("claude-opus-4-6");
  });
});

// ─── readClaudeProxySettings ──────────────────────────────────────────────────

describe("readClaudeProxySettings", () => {
  it("returns empty object when file does not exist", () => {
    expect(readClaudeProxySettings()).toEqual({});
  });

  it("reads baseUrl and authToken correctly", () => {
    writeClaudeSettings(3456, undefined, undefined, "openai/default");
    const result = readClaudeProxySettings();
    expect(result.baseUrl).toBe("http://localhost:3456");
    expect(result.authToken).toBe("proxy-managed");
    expect(result.model).toBe("openai/default");
  });

  it("returns empty object when env block is missing", () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({ model: "claude-opus-4-6" }));
    expect(readClaudeProxySettings()).toEqual({});
  });
});
