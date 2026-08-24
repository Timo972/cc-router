import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "smol-toml";
import {
  codexBaseUrlFromRouterUrl,
  writeCodexRouterConfig,
  writeCodexRouterConfigFromClient,
  removeCodexRouterConfig,
  readCodexRouterConfig,
} from "../utils/codex-config.js";

describe("writeCodexRouterConfig", () => {
  it("writes a user-level Codex provider profile for CC-Router", () => {
    const writeFileSync = vi.fn();
    const mkdirSync = vi.fn();

    const output = writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      tokenEnvKey: "CC_ROUTER_TOKEN",
      fs: {
        existsSync: () => false,
        readFileSync: () => "",
        writeFileSync,
        mkdirSync,
      },
    });

    expect(output.path).toBe(join("/tmp/home", ".codex", "config.toml"));
    expect(writeFileSync.mock.calls[0][1]).toContain("[model_providers.cc-router]");
    expect(writeFileSync.mock.calls[0][1]).toContain("base_url = \"http://localhost:3456/v1\"");
    expect(writeFileSync.mock.calls[0][1]).toContain("wire_api = \"responses\"");
    expect(writeFileSync.mock.calls[0][1]).toContain("env_key = \"CC_ROUTER_TOKEN\"");
  });

  it("preserves unrelated Codex config while replacing an existing managed block", () => {
    const writeFileSync = vi.fn();
    const mkdirSync = vi.fn();
    const existing = [
      "model = \"gpt-5\"",
      "",
      "# cc-router:start",
      "model_provider = \"old-router\"",
      "",
      "[model_providers.cc-router]",
      "base_url = \"http://localhost:9999/v1\"",
      "# cc-router:end",
      "",
      "[profiles.work]",
      "model = \"gpt-5-codex\"",
      "",
    ].join("\n");

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      tokenEnvKey: "CC_ROUTER_TOKEN",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync,
        mkdirSync,
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    expect(written).toContain("model = \"gpt-5\"");
    expect(written).toContain("[profiles.work]");
    expect(written).toContain("base_url = \"http://localhost:3456/v1\"");
    expect(written).not.toContain("http://localhost:9999/v1");
    expect(written.match(/# cc-router:start/g)).toHaveLength(1);
  });

  it("writes the selected Codex model into the managed block", () => {
    const writeFileSync = vi.fn();

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      tokenEnvKey: "CC_ROUTER_TOKEN",
      defaultModel: "openai/gpt-5-codex",
      fs: {
        existsSync: () => false,
        readFileSync: () => "",
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    expect(writeFileSync.mock.calls[0][1]).toContain("model = \"openai/gpt-5-codex\"");
  });

  it("writes no env_key line when tokenEnvKey is omitted (local routing has no auth)", () => {
    const writeFileSync = vi.fn();

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      fs: {
        existsSync: () => false,
        readFileSync: () => "",
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    expect(written).not.toContain("env_key");
  });

  it("inserts the managed block before the first top-level table header, not at EOF", () => {
    const writeFileSync = vi.fn();
    const existing = [
      "[hooks.state]",
      "enabled = true",
      "",
    ].join("\n");

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      defaultModel: "openai/gpt-5-codex",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    const lines = written.split("\n");
    const startLine = lines.findIndex(l => l === "# cc-router:start");
    const modelLine = lines.findIndex(l => l === "model_provider = \"cc-router\"");
    const headerLine = lines.findIndex(l => l === "[hooks.state]");
    expect(startLine).toBeGreaterThanOrEqual(0);
    expect(headerLine).toBeGreaterThanOrEqual(0);
    // The managed block (and thus its top-level model_provider key) must
    // land entirely before the first real table header, not inside it.
    expect(startLine).toBeLessThan(headerLine);
    expect(modelLine).toBeLessThan(headerLine);
  });

  it("comments out a pre-existing top-level model_provider before the header as superseded", () => {
    const writeFileSync = vi.fn();
    const existing = [
      "model_provider = \"openai\"",
      "",
      "[profiles.work]",
      "model = \"gpt-5-codex\"",
      "",
    ].join("\n");

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    expect(written).toContain("# cc-router:superseded model_provider = \"openai\"");
    // Exactly one LIVE top-level model_provider assignment remains — the
    // block's own; the pre-existing one is superseded (commented), not live.
    expect(written.match(/^model_provider\s*=/m)?.length ?? 0).toBe(1);
  });

  it("writing twice is idempotent: one block, no duplicate or double-commented lines", () => {
    let stored = [
      "model_provider = \"openai\"",
      "",
      "[hooks.state]",
      "enabled = true",
      "",
    ].join("\n");
    const fs = {
      existsSync: () => true,
      readFileSync: () => stored,
      writeFileSync: (_path: string, data: string) => {
        stored = data;
      },
      mkdirSync: vi.fn(),
    };

    writeCodexRouterConfig({ homeDir: "/tmp/home", baseUrl: "http://localhost:3456/v1", fs });
    const afterFirst = stored;

    writeCodexRouterConfig({ homeDir: "/tmp/home", baseUrl: "http://localhost:3456/v1", fs });
    const afterSecond = stored;

    expect(afterSecond.match(/# cc-router:start/g)).toHaveLength(1);
    expect(afterSecond.match(/# cc-router:superseded/g)).toHaveLength(1);
    expect(afterSecond).toBe(afterFirst);
  });

  it("migrates a legacy EOF managed block to before the first table header, preserving surrounding content", () => {
    let stored = [
      "[hooks.state]",
      "enabled = true",
      "",
      "# cc-router:start",
      "model_provider = \"cc-router\"",
      "",
      "[model_providers.cc-router]",
      "base_url = \"http://localhost:9999/v1\"",
      "# cc-router:end",
      "",
    ].join("\n");
    const fs = {
      existsSync: () => true,
      readFileSync: () => stored,
      writeFileSync: (_path: string, data: string) => {
        stored = data;
      },
      mkdirSync: vi.fn(),
    };

    writeCodexRouterConfig({ homeDir: "/tmp/home", baseUrl: "http://localhost:3456/v1", fs });

    expect(stored).toContain("[hooks.state]");
    expect(stored).toContain("enabled = true");
    expect(stored).toContain("base_url = \"http://localhost:3456/v1\"");
    const lines = stored.split("\n");
    const startLine = lines.findIndex(l => l === "# cc-router:start");
    const headerLine = lines.findIndex(l => l === "[hooks.state]");
    expect(startLine).toBeLessThan(headerLine);
    expect(stored.match(/# cc-router:start/g)).toHaveLength(1);
  });

  it("migrates a mid-file managed block to before the (now-different) first table header", () => {
    let stored = [
      "model = \"gpt-5\"",
      "",
      "# cc-router:start",
      "model_provider = \"cc-router\"",
      "",
      "[model_providers.cc-router]",
      "base_url = \"http://localhost:9999/v1\"",
      "# cc-router:end",
      "",
      "[profiles.work]",
      "model = \"gpt-5-codex\"",
      "",
    ].join("\n");
    const fs = {
      existsSync: () => true,
      readFileSync: () => stored,
      writeFileSync: (_path: string, data: string) => {
        stored = data;
      },
      mkdirSync: vi.fn(),
    };

    writeCodexRouterConfig({ homeDir: "/tmp/home", baseUrl: "http://localhost:3456/v1", fs });

    expect(stored).toContain("model = \"gpt-5\"");
    expect(stored).toContain("[profiles.work]");
    expect(stored).toContain("model = \"gpt-5-codex\"");
    expect(stored).toContain("base_url = \"http://localhost:3456/v1\"");
    const lines = stored.split("\n");
    const startLine = lines.findIndex(l => l === "# cc-router:start");
    const headerLine = lines.findIndex(l => l === "[profiles.work]");
    expect(startLine).toBeLessThan(headerLine);
    expect(stored.match(/# cc-router:start/g)).toHaveLength(1);
  });

  it("handles a table header with leading whitespace", () => {
    const writeFileSync = vi.fn();
    const existing = "  [profiles.work]\nmodel = \"gpt-5-codex\"\n";

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    const lines = written.split("\n");
    const startLine = lines.findIndex(l => l === "# cc-router:start");
    const headerLine = lines.findIndex(l => l.trim() === "[profiles.work]");
    expect(startLine).toBeLessThan(headerLine);
  });

  it("handles a completely empty config", () => {
    const writeFileSync = vi.fn();

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      fs: {
        existsSync: () => true,
        readFileSync: () => "",
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    expect(written).toContain("# cc-router:start");
    expect(written).toContain("[model_providers.cc-router]");
  });

  it("handles a config with only root keys (no table headers at all — appends at EOF)", () => {
    const writeFileSync = vi.fn();
    const existing = "model = \"gpt-5\"\nmodel_provider = \"openai\"\n";

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    expect(written).toContain("model = \"gpt-5\"");
    expect(written).toContain("# cc-router:superseded model_provider = \"openai\"");
    expect(written).toContain("# cc-router:start");
  });

  it("does not treat a `[`-looking line inside a multiline string as a table header", () => {
    const writeFileSync = vi.fn();
    const existing = [
      "notes = \"\"\"",
      "[not a real header]",
      "\"\"\"",
      "",
      "[profiles.work]",
      "model = \"gpt-5-codex\"",
      "",
    ].join("\n");

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    expect(written).toContain("[not a real header]");
    const lines = written.split("\n");
    const startLine = lines.findIndex(l => l === "# cc-router:start");
    const fakeHeaderLine = lines.findIndex(l => l === "[not a real header]");
    const realHeaderLine = lines.findIndex(l => l === "[profiles.work]");
    // The managed block must be inserted before the REAL header, i.e. after
    // (or around) the multiline string content, not before it.
    expect(startLine).toBeGreaterThan(fakeHeaderLine);
    expect(startLine).toBeLessThan(realHeaderLine);
  });

  it("ignores a `\"\"\"` inside a comment when scanning for the first table header", () => {
    const writeFileSync = vi.fn();
    const existing = [
      "# use \"\"\" for multiline values",
      "",
      "[profiles.work]",
      "model = \"gpt-5-codex\"",
      "",
    ].join("\n");

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    const lines = written.split("\n");
    const startLine = lines.findIndex(l => l === "# cc-router:start");
    const headerLine = lines.findIndex(l => l === "[profiles.work]");
    // A `"""` inside a `#` comment must not be counted as a multiline-string
    // delimiter — the odd-count-in-comment bug would otherwise flip the
    // scanner into "inside a string" and hide the real header entirely,
    // pushing the block to EOF instead of before `[profiles.work]`.
    expect(startLine).toBeGreaterThanOrEqual(0);
    expect(headerLine).toBeGreaterThanOrEqual(0);
    expect(startLine).toBeLessThan(headerLine);
  });

  it("does not supersede a line inside a top-level multiline string value", () => {
    let stored = [
      "description = \"\"\"",
      "model_provider = \"example\"",
      "\"\"\"",
      "",
      "[profiles.work]",
      "model = \"gpt-5-codex\"",
      "",
    ].join("\n");
    const fs = {
      existsSync: () => true,
      readFileSync: () => stored,
      writeFileSync: (_path: string, data: string) => {
        stored = data;
      },
      mkdirSync: vi.fn(),
    };

    writeCodexRouterConfig({ homeDir: "/tmp/home", baseUrl: "http://localhost:3456/v1", fs });

    // The line inside the multiline string is pure string content, not a
    // live root assignment — it must be left byte-identical, never
    // commented out with SUPERSEDED_PREFIX.
    expect(stored).toContain("model_provider = \"example\"");
    expect(stored).not.toContain("# cc-router:superseded model_provider = \"example\"");

    removeCodexRouterConfig({ homeDir: "/tmp/home", fs });

    // Round-tripping write+remove must hand the multiline string back
    // byte-identical to the original (module normalizes trailing newlines,
    // which is pre-existing, unrelated behavior).
    expect(stored).toBe([
      "description = \"\"\"",
      "model_provider = \"example\"",
      "\"\"\"",
      "",
      "[profiles.work]",
      "model = \"gpt-5-codex\"",
      "",
      "",
    ].join("\n"));
  });

  it("F1: a single-line string containing a literal \"\"\" does not falsely open multiline-string mode", () => {
    const writeFileSync = vi.fn();
    const existing = [
      "hint = 'use \"\"\" here'",
      "",
      "[profiles.work]",
      "model = \"gpt-5-codex\"",
      "",
    ].join("\n");

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    expect(written).toContain("hint = 'use \"\"\" here'");
    const lines = written.split("\n");
    const startLine = lines.findIndex(l => l === "# cc-router:start");
    const headerLine = lines.findIndex(l => l === "[profiles.work]");
    // A literal `"""` inside an ordinary single-line string must not be
    // mistaken for a multiline-string delimiter — the scanner must still
    // find the REAL table header and insert the block before it.
    expect(startLine).toBeGreaterThanOrEqual(0);
    expect(headerLine).toBeGreaterThanOrEqual(0);
    expect(startLine).toBeLessThan(headerLine);
  });

  it("F2: a multiline array's continuation lines are never mistaken for table headers", () => {
    const writeFileSync = vi.fn();
    const existing = [
      "matrix = [",
      "  [1, 2],",
      "  [3, 4],",
      "]",
      "",
      "[profiles.work]",
      "model = \"gpt-5-codex\"",
      "",
    ].join("\n");

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    // The point of F2: verify via the real parser, not line-position
    // assertions, that the write produced a structurally valid document
    // with model_provider correctly at the top level (i.e. the block was
    // never inserted INSIDE the array).
    const parsed = parse(written) as Record<string, unknown>;
    expect(parsed.model_provider).toBe("cc-router");
    expect(parsed.matrix).toEqual([[1, 2], [3, 4]]);

    const lines = written.split("\n");
    const startLine = lines.findIndex(l => l === "# cc-router:start");
    const realHeaderLine = lines.findIndex(l => l === "[profiles.work]");
    const fakeHeaderLine = lines.findIndex(l => l.trim() === "[1, 2],");
    expect(startLine).toBeGreaterThanOrEqual(0);
    // Must land before the real header, and never land in the middle of
    // the still-open array (i.e. not immediately after a `[1, 2],` row).
    expect(startLine).toBeLessThan(realHeaderLine);
    expect(lines[startLine - 1]?.trim()).not.toBe(fakeHeaderLine >= 0 ? lines[fakeHeaderLine].trim() : "__never__");
  });

  it("F3: a pre-existing quoted top-level key is superseded without creating a duplicate", () => {
    const writeFileSync = vi.fn();
    const existing = [
      "\"model_provider\" = \"x\"",
      "",
      "[profiles.work]",
      "model = \"gpt-5-codex\"",
      "",
    ].join("\n");

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    expect(written).toContain("# cc-router:superseded \"model_provider\" = \"x\"");
    const parsed = parse(written) as Record<string, unknown>;
    expect(parsed.model_provider).toBe("cc-router");
  });

  it("F4: restore only touches lines with clear managed-key provenance", () => {
    // One line carrying SUPERSEDED_PREFIX text sits inside a multiline
    // string (never a live assignment); another is a free-floating comment
    // that merely happens to start with the same prefix text but names an
    // unrelated key. Neither has provenance as an actual superseded
    // `model`/`model_provider` assignment, so remove must leave both
    // byte-identical.
    let stored = [
      "description = \"\"\"",
      "# cc-router:superseded some_random = \"y\"",
      "\"\"\"",
      "# cc-router:start",
      "model_provider = \"cc-router\"",
      "# cc-router:end",
      "# cc-router:superseded some_random = \"y\"",
      "",
    ].join("\n");
    const fs = {
      existsSync: () => true,
      readFileSync: () => stored,
      writeFileSync: (_path: string, data: string) => {
        stored = data;
      },
      mkdirSync: vi.fn(),
    };

    removeCodexRouterConfig({ homeDir: "/tmp/home", fs });

    // Both lines carry the SUPERSEDED_PREFIX text, but neither is a
    // managed-key assignment (`model`/`model_provider`) — one sits inside a
    // multiline string, the other is an unrelated free-floating comment.
    // Both must be left untouched by remove.
    expect(stored).toContain("# cc-router:superseded some_random = \"y\"");
    expect(stored).not.toContain("\nsome_random = \"y\"");
  });

  it("F0: removeCodexRouterConfig refuses to write when the result would not be valid TOML", () => {
    // Constructs the scanner blind spot the F0 safety net exists for: the
    // START/END markers are found by plain substring search
    // (`managedBlockBounds`), so if that literal text happens to appear
    // inside what looks like a multiline-string value, slicing the file at
    // those byte offsets can produce a structurally broken remainder —
    // here, an orphaned bare word with no `=`/`[`/`#`. The parser-backed
    // validator must catch this and throw rather than write it.
    const existing = [
      "# cc-router:start",
      "foo = \"\"\"",
      "# cc-router:end",
      "bar",
    ].join("\n");

    expect(() => removeCodexRouterConfig({
      homeDir: "/tmp/home",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      },
    })).toThrow("failed TOML validation");
  });
});

describe("removeCodexRouterConfig", () => {
  it("strips the managed block and leaves unrelated Codex config intact", () => {
    const writeFileSync = vi.fn();
    const existing = [
      "model = \"gpt-5.6-sol\"",
      "",
      "# cc-router:start",
      "model_provider = \"cc-router\"",
      "",
      "[model_providers.cc-router]",
      "base_url = \"http://localhost:3456/v1\"",
      "# cc-router:end",
      "",
      "[profiles.work]",
      "model = \"gpt-5-codex\"",
      "",
    ].join("\n");

    const result = removeCodexRouterConfig({
      homeDir: "/tmp/home",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    expect(result.removed).toBe(true);
    const written = String(writeFileSync.mock.calls[0][1]);
    expect(written).toContain("model = \"gpt-5.6-sol\"");
    expect(written).toContain("[profiles.work]");
    expect(written).not.toContain("# cc-router:start");
    expect(written).not.toContain("model_provider = \"cc-router\"");
    expect(written).not.toContain("[model_providers.cc-router]");
  });

  it("is a no-op when Codex is not configured for the router", () => {
    const writeFileSync = vi.fn();
    const result = removeCodexRouterConfig({
      homeDir: "/tmp/home",
      fs: {
        existsSync: () => true,
        readFileSync: () => "model = \"gpt-5.6-sol\"\n",
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    expect(result.removed).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("round-trips start then stop then start without duplicating the block", () => {
    let stored = "model = \"gpt-5.6-sol\"\n";
    const fs = {
      existsSync: () => true,
      readFileSync: () => stored,
      writeFileSync: (_path: string, data: string) => {
        stored = data;
      },
      mkdirSync: vi.fn(),
    };

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      fs,
    });
    expect(readCodexRouterConfig({ homeDir: "/tmp/home", fs }).configured).toBe(true);
    expect(stored.match(/# cc-router:start/g)).toHaveLength(1);

    removeCodexRouterConfig({ homeDir: "/tmp/home", fs });
    expect(readCodexRouterConfig({ homeDir: "/tmp/home", fs }).configured).toBe(false);
    expect(stored).toContain("model = \"gpt-5.6-sol\"");
    expect(stored).not.toContain("# cc-router:start");

    writeCodexRouterConfig({
      homeDir: "/tmp/home",
      baseUrl: "http://localhost:3456/v1",
      defaultModel: "openai/gpt-5-codex",
      fs,
    });
    expect(stored.match(/# cc-router:start/g)).toHaveLength(1);
    expect(stored).toContain("model = \"gpt-5.6-sol\"");
    expect(stored).toContain("model = \"openai/gpt-5-codex\"");
  });

  it("refuses to touch a malformed managed block", () => {
    expect(() => removeCodexRouterConfig({
      homeDir: "/tmp/home",
      fs: {
        existsSync: () => true,
        readFileSync: () => "# cc-router:start\nmodel_provider = \"cc-router\"\n",
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      },
    })).toThrow("Malformed cc-router managed block");
  });
});

describe("readCodexRouterConfig", () => {
  it("reports the managed provider URL and model when configured", () => {
    const existing = [
      "# cc-router:start",
      "model = \"openai/gpt-5-codex\"",
      "model_provider = \"cc-router\"",
      "",
      "[model_providers.cc-router]",
      "base_url = \"http://localhost:3456/v1\"",
      "# cc-router:end",
      "",
    ].join("\n");

    expect(readCodexRouterConfig({
      homeDir: "/tmp/home",
      fs: {
        existsSync: () => true,
        readFileSync: () => existing,
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      },
    })).toEqual({
      path: join("/tmp/home", ".codex", "config.toml"),
      configured: true,
      baseUrl: "http://localhost:3456/v1",
      model: "openai/gpt-5-codex",
      modelProvider: "cc-router",
    });
  });
});

describe("codexBaseUrlFromRouterUrl", () => {
  it("uses the remote router URL as an OpenAI-compatible /v1 base URL", () => {
    expect(codexBaseUrlFromRouterUrl("https://router.example.com")).toBe("https://router.example.com/v1");
    expect(codexBaseUrlFromRouterUrl("https://router.example.com/")).toBe("https://router.example.com/v1");
    expect(codexBaseUrlFromRouterUrl("https://router.example.com/v1")).toBe("https://router.example.com/v1");
  });
});

describe("writeCodexRouterConfigFromClient", () => {
  it("configures Codex from stored client mode remote URL", () => {
    const writeFileSync = vi.fn();

    const result = writeCodexRouterConfigFromClient({
      client: {
        remoteUrl: "https://router.example.com",
        remoteSecret: "secret",
      },
    }, {
      homeDir: "/tmp/home",
      defaultModel: "openai/default",
      fs: {
        existsSync: () => false,
        readFileSync: () => "",
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    expect(result.hasSecret).toBe(true);
    expect(written).toContain("model = \"openai/default\"");
    expect(written).toContain("base_url = \"https://router.example.com/v1\"");
    expect(written).toContain("env_key = \"CC_ROUTER_TOKEN\"");
    expect(written).not.toContain("secret");
  });

  it("writes no env_key when the remote client mode has no secret configured", () => {
    const writeFileSync = vi.fn();

    const result = writeCodexRouterConfigFromClient({
      client: {
        remoteUrl: "https://router.example.com",
      },
    }, {
      homeDir: "/tmp/home",
      defaultModel: "openai/default",
      fs: {
        existsSync: () => false,
        readFileSync: () => "",
        writeFileSync,
        mkdirSync: vi.fn(),
      },
    });

    const written = String(writeFileSync.mock.calls[0][1]);
    expect(result.hasSecret).toBe(false);
    expect(written).not.toContain("env_key");
  });

  it("fails clearly when client mode has not been configured", () => {
    expect(() => writeCodexRouterConfigFromClient({}, {
      fs: {
        existsSync: () => false,
        readFileSync: () => "",
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      },
    })).toThrow("Client mode is not configured");
  });
});
