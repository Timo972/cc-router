import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const WORKER = join(import.meta.dirname, "fixtures", "telemetry-consent-worker.mjs");
const INSTALL_ID = "123e4567-e89b-42d3-a456-426614174000";
const FIRST_RUN_AT = "2026-08-01T00:00:00.000Z";
const homes: string[] = [];

interface WorkerResult {
  ok: boolean;
  elapsedMs: number;
  requested?: boolean;
  enabled?: boolean;
  state?: TelemetryState;
  snapshot?: TelemetrySnapshot;
  snapshots?: TelemetrySnapshot[];
  states?: TelemetryState[];
  error?: { code?: string; name?: string; message?: string };
}

interface TelemetryState {
  enabled: boolean;
  installId: string;
  firstRunAt: string;
  revision: number;
}

interface TelemetrySnapshot {
  state: TelemetryState;
  environmentDisabled: boolean;
  enabled: boolean;
}

function createState(enabled = true, revision = 0): { home: string; telemetryPath: string } {
  const home = mkdtempSync(join(tmpdir(), "cc-router-consent-lock-"));
  homes.push(home);
  const configDir = join(home, ".cc-router");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const telemetryPath = join(configDir, "telemetry.json");
  writeFileSync(telemetryPath, JSON.stringify({
    enabled,
    installId: INSTALL_ID,
    firstRunAt: FIRST_RUN_AT,
    revision,
  }), { mode: 0o600 });
  return { home, telemetryPath };
}

function workerEnvironment(home: string, telemetryPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TELEMETRY_PATH: telemetryPath,
  };
}

function runWorker(
  home: string,
  telemetryPath: string,
  mode: string,
  ...args: string[]
): Promise<WorkerResult> {
  return new Promise((resolveRun, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", WORKER, mode, ...args],
      {
        cwd: PROJECT_ROOT,
        env: workerEnvironment(home, telemetryPath),
        timeout: 10_000,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`consent worker failed: ${error.message}\n${stderr}`));
          return;
        }
        try {
          resolveRun(JSON.parse(stdout.trim()) as WorkerResult);
        } catch (parseError) {
          reject(new Error(`invalid consent worker output: ${stdout}\n${stderr}`, { cause: parseError }));
        }
      },
    );
  });
}

function startLockHolder(home: string, telemetryPath: string): Promise<{
  child: ChildProcess;
  owner: { version: 1; token: string; pid: number; createdAt: number };
}> {
  return new Promise((resolveStart, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, "hold-lock"], {
      cwd: PROJECT_ROOT,
      env: workerEnvironment(home, telemetryPath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error(`lock holder did not become ready\n${stdout}\n${stderr}`));
    }, 5_000);
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.stdout?.on("data", chunk => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(deadline);
      try {
        const ready = JSON.parse(stdout.slice(0, newline)) as {
          ok: boolean;
          owner: { version: 1; token: string; pid: number; createdAt: number };
        };
        if (!ready.ok) throw new Error("lock holder reported failure");
        resolveStart({ child, owner: ready.owner });
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.once("error", error => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", code => {
      if (stdout.includes("\n")) return;
      clearTimeout(deadline);
      reject(new Error(`lock holder exited ${String(code)} before readiness\n${stderr}`));
    });
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveStop, reject) => {
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
    }, 2_000);
    child.once("error", error => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(deadline);
      resolveStop();
    });
    child.kill();
  });
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("telemetry consent lock ownership", () => {
  it("keeps a valid snapshot lock-free when an abandoned lock path exists", async () => {
    const { home, telemetryPath } = createState(false, 7);
    writeFileSync(`${telemetryPath}.lock`, "abandoned-pre-ownership-lock", { mode: 0o600 });

    const result = await runWorker(home, telemetryPath, "snapshot");

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      snapshot: {
        state: { enabled: false, installId: INSTALL_ID, firstRunAt: FIRST_RUN_AT, revision: 7 },
        environmentDisabled: false,
        enabled: false,
      },
    }));
    expect(result.elapsedMs).toBeLessThan(250);
    expect(readFileSync(`${telemetryPath}.lock`, "utf8")).toBe("abandoned-pre-ownership-lock");
  });

  it("recovers a killed owner's stale lock and completes the next explicit choice", async () => {
    const { home, telemetryPath } = createState(true, 10);
    const holder = await startLockHolder(home, telemetryPath);
    await stopChild(holder.child);

    const result = await runWorker(home, telemetryPath, "update", "false");

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      requested: false,
      state: { enabled: false, installId: INSTALL_ID, firstRunAt: FIRST_RUN_AT, revision: 11 },
    }));
    expect(result.elapsedMs).toBeLessThan(1_000);
    expect(existsSync(`${telemetryPath}.lock`)).toBe(false);
  });

  it("serializes concurrent updater processes into unique monotonic revisions", async () => {
    const { home, telemetryPath } = createState(true, 40);
    const choices = [false, true, false, true];

    const results = await Promise.all(choices.map(choice => (
      runWorker(home, telemetryPath, "update", String(choice))
    )));

    expect(results.every(result => result.ok)).toBe(true);
    expect(results.map(result => result.state?.revision).sort((left, right) => (left ?? 0) - (right ?? 0)))
      .toEqual([41, 42, 43, 44]);
    for (const result of results) expect(result.state?.enabled).toBe(result.requested);
    const finalState = JSON.parse(readFileSync(telemetryPath, "utf8")) as TelemetryState;
    const lastResult = results.find(result => result.state?.revision === 44);
    expect(finalState).toEqual(lastResult?.state);
  });

  it("never steals a live owner's lock and bounds the isolated mutation failure", async () => {
    const { home, telemetryPath } = createState(true, 2);
    const holder = await startLockHolder(home, telemetryPath);
    const originalLock = readFileSync(`${telemetryPath}.lock`, "utf8");
    try {
      const result = await runWorker(home, telemetryPath, "update", "false");

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("EEXIST");
      expect(result.elapsedMs).toBeLessThan(1_000);
      expect(readFileSync(`${telemetryPath}.lock`, "utf8")).toBe(originalLock);
      expect(JSON.parse(originalLock)).toEqual(holder.owner);
      expect(JSON.parse(readFileSync(telemetryPath, "utf8"))).toEqual({
        enabled: true,
        installId: INSTALL_ID,
        firstRunAt: FIRST_RUN_AT,
        revision: 2,
      });
    } finally {
      await stopChild(holder.child);
    }
  });

  it.each([
    ["malformed", "not-json"],
    ["foreign", JSON.stringify({
      version: 99,
      token: "123e4567-e89b-42d3-a456-426614174099",
      pid: 2_147_483_647,
      createdAt: 0,
    })],
  ])("fails safely for %s lock content without unlinking it", async (_kind, lockContent) => {
    const { home, telemetryPath } = createState(true, 3);
    writeFileSync(`${telemetryPath}.lock`, lockContent, { mode: 0o600 });

    const result = await runWorker(home, telemetryPath, "update", "false");

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EEXIST");
    expect(result.elapsedMs).toBeLessThan(1_000);
    expect(readFileSync(`${telemetryPath}.lock`, "utf8")).toBe(lockContent);
  });

  it("reads only complete atomic state while another process repeatedly updates by rename", async () => {
    const { home, telemetryPath } = createState(true, 0);

    const [writer, reader] = await Promise.all([
      runWorker(home, telemetryPath, "update-many", "100", "1"),
      runWorker(home, telemetryPath, "read-many", "400"),
    ]);

    expect(writer.ok).toBe(true);
    expect(writer.states?.map(state => state.revision)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    expect(reader.ok).toBe(true);
    expect(reader.snapshots).toHaveLength(400);
    const revisions = reader.snapshots?.map(snapshot => snapshot.state.revision) ?? [];
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
    for (const snapshot of reader.snapshots ?? []) {
      expect(snapshot.state).toEqual({
        enabled: expect.any(Boolean),
        installId: INSTALL_ID,
        firstRunAt: FIRST_RUN_AT,
        revision: expect.any(Number),
      });
      expect(snapshot.enabled).toBe(snapshot.state.enabled);
      expect(snapshot.environmentDisabled).toBe(false);
    }
    expect(JSON.parse(readFileSync(telemetryPath, "utf8"))).toEqual({
      enabled: false,
      installId: INSTALL_ID,
      firstRunAt: FIRST_RUN_AT,
      revision: 100,
    });
  });

  it("applies environment kill switches immediately without consulting a foreign lock", async () => {
    const { home, telemetryPath } = createState(true, 5);
    writeFileSync(`${telemetryPath}.lock`, "foreign-lock", { mode: 0o600 });

    const result = await new Promise<WorkerResult>((resolveRun, reject) => {
      execFile(
        process.execPath,
        ["--import", "tsx", WORKER, "snapshot"],
        {
          cwd: PROJECT_ROOT,
          env: {
            ...workerEnvironment(home, telemetryPath),
            DO_NOT_TRACK: "1",
          },
          timeout: 10_000,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`kill-switch worker failed: ${error.message}\n${stderr}`));
            return;
          }
          resolveRun(JSON.parse(stdout.trim()) as WorkerResult);
        },
      );
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot).toEqual({
      state: { enabled: true, installId: INSTALL_ID, firstRunAt: FIRST_RUN_AT, revision: 5 },
      environmentDisabled: true,
      enabled: false,
    });
    expect(result.elapsedMs).toBeLessThan(250);
  });

  it("isolates malformed-state lock failures from application enablement gates", async () => {
    const { home, telemetryPath } = createState(true, 0);
    writeFileSync(telemetryPath, "partial-json", { mode: 0o600 });
    writeFileSync(`${telemetryPath}.lock`, "foreign-lock", { mode: 0o600 });

    const result = await runWorker(home, telemetryPath, "gate");

    expect(result).toEqual(expect.objectContaining({ ok: true, enabled: false }));
    expect(result.elapsedMs).toBeLessThan(1_000);
    expect(readFileSync(`${telemetryPath}.lock`, "utf8")).toBe("foreign-lock");
  });
});
