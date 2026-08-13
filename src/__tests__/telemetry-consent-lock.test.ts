import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const WORKER = join(import.meta.dirname, "fixtures", "telemetry-consent-worker.mjs");
const FS_LOADER = join(import.meta.dirname, "fixtures", "telemetry-consent-fs-loader.mjs");
const INSTALL_ID = "123e4567-e89b-42d3-a456-426614174000";
const FIRST_RUN_AT = "2026-08-01T00:00:00.000Z";
const homes: string[] = [];
const children: ChildProcess[] = [];

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

function startRaceWorker(
  home: string,
  telemetryPath: string,
  barrier: string,
  worker: "first" | "second",
  enabled: boolean,
): { child: ChildProcess; result: Promise<WorkerResult> } {
  const child = spawn(process.execPath, [
    "--import", "tsx",
    "--loader", FS_LOADER,
    WORKER, "update", String(enabled),
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...workerEnvironment(home, telemetryPath),
      NODE_ENV: "test",
      CC_ROUTER_TEST_CONSENT_RACE_BARRIER: barrier,
      CC_ROUTER_TEST_CONSENT_RACE_WORKER: worker,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const result = new Promise<WorkerResult>((resolveResult, reject) => {
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`race worker ${worker} timed out\n${stdout}\n${stderr}`));
    }, 10_000);
    child.stdout?.on("data", chunk => { stdout += String(chunk); });
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.once("error", error => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(deadline);
      if (code !== 0) {
        reject(new Error(`race worker ${worker} exited ${String(code)}\n${stdout}\n${stderr}`));
        return;
      }
      try {
        resolveResult(JSON.parse(stdout.trim()) as WorkerResult);
      } catch (error) {
        reject(new Error(`invalid race worker ${worker} output\n${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
  return { child, result };
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}

async function waitForEitherPath(paths: string[]): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const existing = paths.find(path => existsSync(path));
    if (existing) return existing;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for one of ${paths.join(", ")}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
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

  it("recovers both immutable contender and write lock after an elected updater is killed", async () => {
    const { home, telemetryPath } = createState(true, 20);
    const barrier = join(home, "killed-elected-updater");
    mkdirSync(barrier, { mode: 0o700 });
    const killed = startRaceWorker(home, telemetryPath, barrier, "first", false);
    const ignoredKilledResult = killed.result.catch(() => undefined);
    await waitForPath(join(barrier, "first.read-state"));
    await stopChild(killed.child);
    await ignoredKilledResult;

    expect(existsSync(`${telemetryPath}.lock`)).toBe(true);
    expect(readdirSync(`${telemetryPath}.lock.queue`)).toHaveLength(1);
    const result = await runWorker(home, telemetryPath, "update", "false");

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      state: { enabled: false, installId: INSTALL_ID, firstRunAt: FIRST_RUN_AT, revision: 21 },
    }));
    expect(result.elapsedMs).toBeLessThan(1_000);
    expect(readdirSync(`${telemetryPath}.lock.queue`)).toHaveLength(0);
    expect(existsSync(`${telemetryPath}.lock`)).toBe(false);
  });

  it("lets only an atomic stale-generation claimant remove it before concurrent updates", async () => {
    const { home, telemetryPath } = createState(true, 0);
    const barrier = join(home, "race");
    mkdirSync(barrier, { mode: 0o700 });
    const holder = await startLockHolder(home, telemetryPath);
    await stopChild(holder.child);
    await new Promise(resolveWait => setTimeout(resolveWait, 300));

    const first = startRaceWorker(home, telemetryPath, barrier, "first", false);
    await waitForPath(join(barrier, "first.validated-stale"));
    const second = startRaceWorker(home, telemetryPath, barrier, "second", true);
    await waitForEitherPath([
      join(barrier, "second.validated-stale"),
      join(barrier, "second.queued"),
    ]);

    writeFileSync(join(barrier, "first.release-validation"), "", { mode: 0o600 });
    await waitForPath(join(barrier, "first.read-state"));
    const firstReplacement = JSON.parse(readFileSync(`${telemetryPath}.lock`, "utf8")) as { token: string };
    writeFileSync(join(barrier, "second.release-validation"), "", { mode: 0o600 });
    let secondResult: WorkerResult | undefined;
    await Promise.race([
      second.result.then(result => { secondResult = result; }),
      new Promise(resolveWait => setTimeout(resolveWait, 250)),
    ]);
    writeFileSync(join(barrier, "first.release-state"), "", { mode: 0o600 });
    const firstResult = await first.result;
    secondResult ??= await second.result;

    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok, JSON.stringify(secondResult)).toBe(true);
    expect([firstResult.state?.revision, secondResult.state?.revision].sort()).toEqual([1, 2]);
    const finalState = JSON.parse(readFileSync(telemetryPath, "utf8")) as TelemetryState;
    const lastResult = [firstResult, secondResult].find(result => result.state?.revision === 2);
    expect(finalState).toEqual(lastResult?.state);

    const audit = readFileSync(join(barrier, "lock-audit.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line) as { type: string; worker: string; token?: string });
    expect(audit).toContainEqual({
      type: "acquired",
      worker: "first",
      token: firstReplacement.token,
    });
    const acquiredByWorker = new Map(audit
      .filter(entry => entry.type === "acquired")
      .map(entry => [`${entry.worker}:${entry.token}`, true]));
    for (const entry of audit.filter(candidate => candidate.type === "unlinked-authoritative")) {
      expect(acquiredByWorker.has(`${entry.worker}:${entry.token}`), JSON.stringify(entry)).toBe(true);
    }
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
