import * as fs from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MOCK_DIR = vi.hoisted(() => {
  const tmp = process.env["TMPDIR"] ?? process.env["TEMP"] ?? "/tmp";
  return `${tmp}/cc-router-telemetry-state-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
});
const TELEMETRY_PATH = `${MOCK_DIR}/telemetry.json`;

const fsCalls = vi.hoisted(() => ({
  writes: [] as string[],
  renames: [] as [string, string][],
  beforeLink: undefined as (() => void) | undefined,
}));

vi.mock("../config/paths.js", () => ({
  CONFIG_DIR: MOCK_DIR,
  TELEMETRY_PATH: `${MOCK_DIR}/telemetry.json`,
  ACCOUNTS_PATH: `${MOCK_DIR}/accounts.json`,
  CLAUDE_SETTINGS_PATH: `${MOCK_DIR}/settings.json`,
  CONFIG_PATH: `${MOCK_DIR}/config.json`,
  PROXY_PORT: 3456,
  LITELLM_PORT: 4000,
  LITELLM_URL: undefined,
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    writeFileSync: (path: fs.PathOrFileDescriptor, ...rest: never[]) => {
      if (typeof path === "string") fsCalls.writes.push(path);
      return (actual.writeFileSync as (...args: unknown[]) => void)(path, ...rest);
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      fsCalls.renames.push([String(from), String(to)]);
      return actual.renameSync(from, to);
    },
    linkSync: (from: fs.PathLike, to: fs.PathLike) => {
      fsCalls.beforeLink?.();
      return actual.linkSync(from, to);
    },
  };
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type TelemetryModule = typeof import("../config/telemetry.js");

/** A fresh module instance models a fresh process for first-start claims. */
async function freshModule(): Promise<TelemetryModule> {
  vi.resetModules();
  return import("../config/telemetry.js");
}

function readFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(TELEMETRY_PATH, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  fs.rmSync(MOCK_DIR, { recursive: true, force: true });
  fs.mkdirSync(MOCK_DIR, { recursive: true });
  fsCalls.writes.length = 0;
  fsCalls.renames.length = 0;
  delete process.env["DO_NOT_TRACK"];
  delete process.env["CC_ROUTER_TELEMETRY"];
});

afterEach(() => {
  fs.rmSync(MOCK_DIR, { recursive: true, force: true });
  delete process.env["DO_NOT_TRACK"];
  delete process.env["CC_ROUTER_TELEMETRY"];
});

describe("persisted telemetry state", () => {
  it("creates default enabled state with a random install id on first read", async () => {
    const { getTelemetrySnapshot } = await freshModule();

    const snapshot = getTelemetrySnapshot();

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.environmentDisabled).toBe(false);
    expect(snapshot.state.enabled).toBe(true);
    expect(snapshot.state.installId).toMatch(UUID);
    expect(snapshot.state.consentGeneration).toMatch(UUID);
    expect(new Date(snapshot.state.firstRunAt).getTime()).toBeGreaterThan(0);
    expect(readFile()).toEqual(snapshot.state);
    expect(getTelemetrySnapshot().state.installId).toBe(snapshot.state.installId);
  });

  it("adopts an opt-out another process published between the read and the initial publish", async () => {
    const { getTelemetrySnapshot, claimTelemetryFirstStart } = await freshModule();
    const optOut = JSON.stringify({
      enabled: false,
      installId: "11111111-2222-4333-8444-555555555555",
      firstRunAt: "2026-01-01T00:00:00.000Z",
      consentGeneration: "66666666-7777-4888-9999-000000000000",
    });
    // Models `cc-router telemetry off` landing in another process after this
    // one observed a missing file.
    fsCalls.beforeLink = () => {
      fsCalls.beforeLink = undefined;
      fs.writeFileSync(TELEMETRY_PATH, optOut, "utf8");
    };

    const snapshot = getTelemetrySnapshot();

    expect(snapshot.enabled).toBe(false);
    expect(snapshot.state.installId).toBe("11111111-2222-4333-8444-555555555555");
    expect(fs.readFileSync(TELEMETRY_PATH, "utf8")).toBe(optOut);
    expect(claimTelemetryFirstStart()).toBeUndefined();
  });

  it("repairs a malformed state file instead of failing every later read", async () => {
    const { getTelemetrySnapshot } = await freshModule();
    fs.writeFileSync(TELEMETRY_PATH, "{ not json", "utf8");

    const repaired = getTelemetrySnapshot();

    expect(repaired.state.installId).toMatch(UUID);
    expect(readFile()).toEqual(repaired.state);

    fs.writeFileSync(TELEMETRY_PATH, JSON.stringify({ installId: 42 }), "utf8");
    expect(getTelemetrySnapshot().state.installId).toMatch(UUID);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails closed on an unreadable state file instead of replacing a persisted opt-out",
    async () => {
      const { getTelemetrySnapshot, isTelemetryEnabled, createTelemetryConsentGate } = await freshModule();
      const optOut = JSON.stringify({
        enabled: false,
        installId: "11111111-2222-4333-8444-555555555555",
        firstRunAt: "2026-01-01T00:00:00.000Z",
        consentGeneration: "66666666-7777-4888-9999-000000000000",
      });
      fs.writeFileSync(TELEMETRY_PATH, optOut, "utf8");
      fs.chmodSync(TELEMETRY_PATH, 0o000);
      try {
        expect(() => getTelemetrySnapshot()).toThrow(/unreadable/);
        expect(isTelemetryEnabled()).toBe(false);
        const gate = createTelemetryConsentGate();
        expect(gate.getSnapshot()).toBeUndefined();
        expect(gate.latched).toBe(true);
      } finally {
        fs.chmodSync(TELEMETRY_PATH, 0o600);
      }
      expect(fs.readFileSync(TELEMETRY_PATH, "utf8")).toBe(optOut);
    },
  );

  it("reads a legacy record without a consent generation and never rewrites it", async () => {
    const { getTelemetrySnapshot } = await freshModule();
    const legacy = JSON.stringify({
      enabled: false,
      installId: "legacy-install-id",
      firstRunAt: "2026-01-01T00:00:00.000Z",
      revision: 27,
    });
    fs.writeFileSync(TELEMETRY_PATH, legacy, "utf8");

    const snapshot = getTelemetrySnapshot();

    expect(snapshot.state).toEqual({
      enabled: false,
      installId: "legacy-install-id",
      firstRunAt: "2026-01-01T00:00:00.000Z",
      consentGeneration: "legacy",
    });
    expect(snapshot.enabled).toBe(false);
    expect(fs.readFileSync(TELEMETRY_PATH, "utf8")).toBe(legacy);
  });

  it("rotates the consent generation and publishes atomically with private permissions", async () => {
    const { getTelemetrySnapshot, updateTelemetryConsent } = await freshModule();
    const initial = getTelemetrySnapshot().state;
    fsCalls.writes.length = 0;
    fsCalls.renames.length = 0;

    const disabled = updateTelemetryConsent(false);

    expect(disabled.enabled).toBe(false);
    expect(disabled.installId).toBe(initial.installId);
    expect(disabled.firstRunAt).toBe(initial.firstRunAt);
    expect(disabled.consentGeneration).toMatch(UUID);
    expect(disabled.consentGeneration).not.toBe(initial.consentGeneration);
    expect(readFile()).toEqual(disabled);
    expect(getTelemetrySnapshot().enabled).toBe(false);

    // The final file is only ever produced by renaming a fully written candidate.
    expect(fsCalls.writes).not.toContain(TELEMETRY_PATH);
    expect(fsCalls.writes.every(path => path.startsWith(`${TELEMETRY_PATH}.`))).toBe(true);
    expect(fsCalls.renames).toEqual([[fsCalls.writes[0]!, TELEMETRY_PATH]]);
    expect(fs.readdirSync(MOCK_DIR)).toEqual(["telemetry.json"]);
    if (process.platform !== "win32") {
      expect(fs.statSync(TELEMETRY_PATH).mode & 0o777).toBe(0o600);
    }

    const enabled = updateTelemetryConsent(true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.consentGeneration).not.toBe(disabled.consentGeneration);
  });

  it.each([
    ["DO_NOT_TRACK", "1"],
    ["CC_ROUTER_TELEMETRY", "0"],
  ])("treats %s=%s as an environment kill switch without touching persisted consent", async (name, value) => {
    const { getTelemetrySnapshot, isTelemetryEnabled } = await freshModule();
    const persisted = getTelemetrySnapshot().state;

    process.env[name] = value;
    const snapshot = getTelemetrySnapshot();

    expect(snapshot.environmentDisabled).toBe(true);
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.state.enabled).toBe(true);
    expect(isTelemetryEnabled()).toBe(false);
    expect(readFile()).toEqual(persisted);

    delete process.env[name];
    expect(isTelemetryEnabled()).toBe(true);
  });
});

describe("consent gate", () => {
  const snapshotOf = (enabled: boolean, consentGeneration: string) => ({
    state: {
      enabled,
      installId: "70d8062e-1fa0-4ae4-a115-bf782ecca462",
      firstRunAt: "2026-08-03T00:00:00.000Z",
      consentGeneration,
    },
    environmentDisabled: false,
    enabled,
  });

  it("passes snapshots through while the bound generation holds", async () => {
    const { createTelemetryConsentGate } = await freshModule();
    let current = snapshotOf(true, "generation-a");
    const gate = createTelemetryConsentGate(() => current);

    expect(gate.getSnapshot()).toBe(current);
    expect(gate.latched).toBe(false);

    current = snapshotOf(false, "generation-a");
    expect(gate.getSnapshot()).toBeUndefined();
    expect(gate.latched).toBe(false);

    current = snapshotOf(true, "generation-a");
    expect(gate.getSnapshot()).toBe(current);
  });

  it("latches off permanently on a generation change and reports it once", async () => {
    const { createTelemetryConsentGate } = await freshModule();
    let current = snapshotOf(true, "generation-a");
    const onLatch = vi.fn();
    const gate = createTelemetryConsentGate(() => current, onLatch);

    expect(gate.getSnapshot()).toBeDefined();

    current = snapshotOf(true, "generation-b");
    expect(gate.getSnapshot()).toBeUndefined();
    expect(gate.latched).toBe(true);

    // Restoring the original choice must not revive a latched runtime.
    current = snapshotOf(true, "generation-a");
    expect(gate.getSnapshot()).toBeUndefined();
    expect(onLatch).toHaveBeenCalledTimes(1);
  });

  it("latches off when the state cannot be read", async () => {
    const { createTelemetryConsentGate } = await freshModule();
    let readable = true;
    const onLatch = vi.fn();
    const gate = createTelemetryConsentGate(() => {
      if (!readable) throw new Error("unreadable");
      return snapshotOf(true, "generation-a");
    }, onLatch);

    expect(gate.getSnapshot()).toBeDefined();
    readable = false;
    expect(gate.getSnapshot()).toBeUndefined();
    readable = true;
    expect(gate.getSnapshot()).toBeUndefined();
    expect(gate.latched).toBe(true);
    expect(onLatch).toHaveBeenCalledTimes(1);
  });

  it("starts latched when the very first read fails", async () => {
    const { createTelemetryConsentGate } = await freshModule();

    const gate = createTelemetryConsentGate(() => { throw new Error("unreadable"); });

    expect(gate.latched).toBe(true);
    expect(gate.getSnapshot()).toBeUndefined();
  });

  it("defaults to the persisted state and follows an explicit opt-out", async () => {
    const { createTelemetryConsentGate, getTelemetrySnapshot, updateTelemetryConsent } = await freshModule();
    getTelemetrySnapshot();
    const gate = createTelemetryConsentGate();

    expect(gate.getSnapshot()?.enabled).toBe(true);

    updateTelemetryConsent(false);

    expect(gate.getSnapshot()).toBeUndefined();
    expect(gate.latched).toBe(true);
  });
});

describe("first start claim", () => {
  it("is claimable exactly once by the process that created the state", async () => {
    const first = await freshModule();
    const created = first.getTelemetrySnapshot().state;

    expect(first.claimTelemetryFirstStart()?.state.installId).toBe(created.installId);
    expect(first.claimTelemetryFirstStart()).toBeUndefined();
  });

  it("is never claimable by a process that only read existing state", async () => {
    const creator = await freshModule();
    creator.getTelemetrySnapshot();

    const reader = await freshModule();
    reader.getTelemetrySnapshot();

    expect(reader.claimTelemetryFirstStart()).toBeUndefined();
  });

  it("is not claimable before any state has been read", async () => {
    const { claimTelemetryFirstStart } = await freshModule();

    expect(claimTelemetryFirstStart()).toBeUndefined();
  });
});
