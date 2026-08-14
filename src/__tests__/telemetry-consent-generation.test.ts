import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const WORKER = join(import.meta.dirname, "fixtures", "telemetry-consent-worker.mjs");
const FS_LOADER = join(import.meta.dirname, "fixtures", "telemetry-consent-fs-loader.mjs");
const INSTALL_ID = "123e4567-e89b-42d3-a456-426614174000";
const INITIAL_GENERATION = "123e4567-e89b-42d3-a456-426614174001";
const FIRST_RUN_AT = "2026-08-01T00:00:00.000Z";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const homes: string[] = [];
const children: ChildProcess[] = [];

interface TelemetryState {
  enabled: boolean;
  installId: string;
  firstRunAt: string;
  consentGeneration: string;
  revision: number;
}

interface TelemetrySnapshot {
  state: TelemetryState;
  environmentDisabled: boolean;
  enabled: boolean;
}

interface WorkerResult {
  ok: boolean;
  elapsedMs: number;
  requested?: boolean;
  enabled?: boolean;
  latchedDisabled?: boolean;
  acceptedGeneration?: string;
  state?: TelemetryState;
  snapshot?: TelemetrySnapshot;
  snapshots?: TelemetrySnapshot[];
  states?: TelemetryState[];
  error?: { code?: string; name?: string; message?: string };
}

function createHome(): { home: string; telemetryPath: string } {
  const home = mkdtempSync(join(tmpdir(), "cc-router-consent-generation-"));
  homes.push(home);
  const configDir = join(home, ".cc-router");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  return { home, telemetryPath: join(configDir, "telemetry.json") };
}

function createState(enabled = true, revision = 0): { home: string; telemetryPath: string } {
  const paths = createHome();
  writeFileSync(paths.telemetryPath, JSON.stringify({
    enabled,
    installId: INSTALL_ID,
    firstRunAt: FIRST_RUN_AT,
    consentGeneration: INITIAL_GENERATION,
    revision,
  }), { mode: 0o600 });
  return paths;
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
        timeout: 15_000,
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

function startBarrierWorker(
  home: string,
  telemetryPath: string,
  barrier: string,
  phase: "after-read" | "before-publish" | "after-publish",
  mode: "initialize" | "update",
  ...args: string[]
): { child: ChildProcess; result: Promise<WorkerResult> } {
  const child = spawn(process.execPath, [
    "--import", "tsx",
    "--loader", FS_LOADER,
    WORKER, mode, ...args,
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...workerEnvironment(home, telemetryPath),
      NODE_ENV: "test",
      CC_ROUTER_TEST_CONSENT_PUBLISH_BARRIER: barrier,
      CC_ROUTER_TEST_CONSENT_PUBLISH_PHASE: phase,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const result = new Promise<WorkerResult>((resolveResult, reject) => {
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`publish worker ${phase} timed out\n${stdout}\n${stderr}`));
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
        reject(new Error(`publish worker ${phase} exited ${String(code)}\n${stdout}\n${stderr}`));
        return;
      }
      try {
        resolveResult(JSON.parse(stdout.trim()) as WorkerResult);
      } catch (error) {
        reject(new Error(`invalid publish worker output\n${stdout}\n${stderr}`, { cause: error }));
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

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolveStop => {
    child.once("close", () => resolveStop());
    child.kill("SIGKILL");
  });
}

function readState(telemetryPath: string): TelemetryState {
  return JSON.parse(readFileSync(telemetryPath, "utf8")) as TelemetryState;
}

function tempArtifacts(telemetryPath: string): string[] {
  const prefix = `${basename(telemetryPath)}.`;
  return readdirSync(dirname(telemetryPath))
    .filter(name => name.startsWith(prefix) && name.endsWith(".tmp"))
    .sort();
}

function sharedLockArtifacts(telemetryPath: string): string[] {
  const prefix = `${basename(telemetryPath)}.lock`;
  return readdirSync(dirname(telemetryPath)).filter(name => name.startsWith(prefix)).sort();
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("lock-free telemetry consent publication", () => {
  it("ignores abandoned, foreign, symlinked, hardlinked, and directory .lock artifacts", async () => {
    const { home, telemetryPath } = createState(true, 7);
    const abandoned = `${telemetryPath}.lock`;
    const foreign = `${telemetryPath}.lock.foreign`;
    const symlink = `${telemetryPath}.lock.symlink`;
    const hardlink = `${telemetryPath}.lock.hardlink`;
    const legacyQueue = `${telemetryPath}.lock.queue`;
    const externalSymlink = join(home, "external-symlink-target");
    const externalHardlink = join(home, "external-hardlink-target");
    writeFileSync(abandoned, "abandoned lock", { mode: 0o600 });
    writeFileSync(foreign, "foreign lock", { mode: 0o600 });
    writeFileSync(externalSymlink, "symlink sentinel", { mode: 0o600 });
    writeFileSync(externalHardlink, "hardlink sentinel", { mode: 0o600 });
    symlinkSync(externalSymlink, symlink, "file");
    linkSync(externalHardlink, hardlink);
    mkdirSync(legacyQueue, { mode: 0o700 });
    writeFileSync(join(legacyQueue, "sentinel"), "queue sentinel", { mode: 0o600 });

    const snapshot = await runWorker(home, telemetryPath, "snapshot");
    const off = await runWorker(home, telemetryPath, "update", "false");
    const on = await runWorker(home, telemetryPath, "update", "true");

    expect(snapshot.ok).toBe(true);
    expect(off.ok).toBe(true);
    expect(on.ok).toBe(true);
    expect(Math.max(snapshot.elapsedMs, off.elapsedMs, on.elapsedMs)).toBeLessThan(500);
    expect(off.state?.consentGeneration).toMatch(UUID_PATTERN);
    expect(on.state?.consentGeneration).toMatch(UUID_PATTERN);
    expect(off.state?.consentGeneration).not.toBe(INITIAL_GENERATION);
    expect(on.state?.consentGeneration).not.toBe(off.state?.consentGeneration);
    expect(readFileSync(abandoned, "utf8")).toBe("abandoned lock");
    expect(readFileSync(foreign, "utf8")).toBe("foreign lock");
    expect(lstatSync(symlink).isSymbolicLink()).toBe(true);
    expect(readFileSync(externalSymlink, "utf8")).toBe("symlink sentinel");
    expect(statSync(hardlink).nlink).toBeGreaterThanOrEqual(2);
    expect(readFileSync(externalHardlink, "utf8")).toBe("hardlink sentinel");
    expect(readFileSync(join(legacyQueue, "sentinel"), "utf8")).toBe("queue sentinel");
  });

  it.each([4, 8, 12])(
    "linearizes %i simultaneous choices by final rename with unique generations",
    async processCount => {
      const { home, telemetryPath } = createState(true, 40);
      const choices = Array.from({ length: processCount }, (_, index) => index % 3 === 0);

      const results = await Promise.all(choices.map(choice => (
        runWorker(home, telemetryPath, "update", String(choice))
      )));

      expect(results.every(result => result.ok)).toBe(true);
      expect(results.every(result => result.elapsedMs < 5_000)).toBe(true);
      const returned = results.map(result => result.state!);
      expect(new Set(returned.map(state => state.consentGeneration)).size).toBe(processCount);
      for (const [index, state] of returned.entries()) {
        expect(state.enabled).toBe(choices[index]);
        expect(state.installId).toBe(INSTALL_ID);
        expect(state.consentGeneration).toMatch(UUID_PATTERN);
        expect(state.consentGeneration).not.toBe(INITIAL_GENERATION);
      }
      const persisted = readState(telemetryPath);
      expect(returned).toContainEqual(persisted);
      expect(persisted.installId).toBe(INSTALL_ID);
      expect(JSON.parse(readFileSync(telemetryPath, "utf8"))).toEqual(persisted);
    },
  );

  it("permanently latches a preexisting runtime off after concurrent choices finish enabled", async () => {
    const { home, telemetryPath } = createState(true, 40);
    const readyPath = join(home, "runtime-ready");
    const releasePath = join(home, "release-runtime");
    const runtime = spawn(process.execPath, [
      "--import", "tsx", WORKER, "watch-gate", readyPath, releasePath,
    ], {
      cwd: PROJECT_ROOT,
      env: workerEnvironment(home, telemetryPath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(runtime);
    const runtimeResult = new Promise<WorkerResult>((resolveResult, reject) => {
      let stdout = "";
      let stderr = "";
      runtime.stdout?.on("data", chunk => { stdout += String(chunk); });
      runtime.stderr?.on("data", chunk => { stderr += String(chunk); });
      runtime.once("error", reject);
      runtime.once("close", code => {
        if (code !== 0) {
          reject(new Error(`runtime watcher exited ${String(code)}\n${stdout}\n${stderr}`));
          return;
        }
        resolveResult(JSON.parse(stdout.trim()) as WorkerResult);
      });
    });
    await waitForPath(readyPath);

    const results = await Promise.all([
      false, true, false, true, false, true, false, true,
    ].map(choice => runWorker(home, telemetryPath, "update", String(choice))));
    const finalOn = await runWorker(home, telemetryPath, "update", "true");
    const final = readState(telemetryPath);
    writeFileSync(releasePath, "", { mode: 0o600 });
    const observed = await runtimeResult;
    const adopted = await runWorker(home, telemetryPath, "gate");

    expect([...results, finalOn]).toContainEqual(expect.objectContaining({ state: final }));
    expect(final.enabled).toBe(true);
    expect(final.consentGeneration).not.toBe(INITIAL_GENERATION);
    expect(observed).toEqual(expect.objectContaining({
      ok: true,
      enabled: false,
      latchedDisabled: true,
      acceptedGeneration: INITIAL_GENERATION,
    }));
    expect(adopted).toEqual(expect.objectContaining({ ok: true, enabled: true }));
  });

  it.each([4, 8, 12])(
    "converges %i simultaneous first initializers on one authoritative identity and generation",
    async processCount => {
      const { home, telemetryPath } = createHome();

      const results = await Promise.all(Array.from({ length: processCount }, () => (
        runWorker(home, telemetryPath, "initialize")
      )));

      expect(results.every(result => result.ok)).toBe(true);
      expect(results.every(result => result.elapsedMs < 5_000)).toBe(true);
      const persisted = readState(telemetryPath);
      expect(persisted.installId).toMatch(UUID_PATTERN);
      expect(persisted.consentGeneration).toMatch(UUID_PATTERN);
      expect(persisted.enabled).toBe(true);
      for (const result of results) expect(result.state).toEqual(persisted);
      if (process.platform !== "win32") expect(statSync(telemetryPath).mode & 0o777).toBe(0o600);
      expect(sharedLockArtifacts(telemetryPath)).toEqual([]);
    },
  );

  it("keeps the old state valid when a writer is killed before atomic publication", async () => {
    const { home, telemetryPath } = createState(true, 5);
    const before = readState(telemetryPath);
    const barrier = join(home, "before-publish-barrier");
    mkdirSync(barrier, { mode: 0o700 });
    const worker = startBarrierWorker(home, telemetryPath, barrier, "before-publish", "update", "false");
    const ignoredResult = worker.result.catch(() => undefined);
    await waitForPath(join(barrier, "before-publish.ready"));

    await stopChild(worker.child);
    await ignoredResult;

    expect(readState(telemetryPath)).toEqual(before);
    expect(tempArtifacts(telemetryPath)).toHaveLength(1);
    expect(sharedLockArtifacts(telemetryPath)).toEqual([]);
  });

  it("leaves a complete new state when a writer is killed after atomic publication", async () => {
    const { home, telemetryPath } = createState(true, 6);
    const barrier = join(home, "after-publish-barrier");
    mkdirSync(barrier, { mode: 0o700 });
    const worker = startBarrierWorker(home, telemetryPath, barrier, "after-publish", "update", "false");
    const ignoredResult = worker.result.catch(() => undefined);
    await waitForPath(join(barrier, "after-publish.ready"));

    const published = readState(telemetryPath);
    await stopChild(worker.child);
    await ignoredResult;

    expect(published).toEqual({
      enabled: false,
      installId: INSTALL_ID,
      firstRunAt: FIRST_RUN_AT,
      consentGeneration: expect.stringMatching(UUID_PATTERN),
      revision: 7,
    });
    expect(published.consentGeneration).not.toBe(INITIAL_GENERATION);
    expect(readState(telemetryPath)).toEqual(published);
    expect(tempArtifacts(telemetryPath)).toEqual([]);
    expect(sharedLockArtifacts(telemetryPath)).toEqual([]);
  });

  it("cleans only its unique candidate and leaves foreign temp candidates inert", async () => {
    const { home, telemetryPath } = createState(true, 8);
    const foreignTemp = `${telemetryPath}.foreign-operation.tmp`;
    writeFileSync(foreignTemp, "foreign temp sentinel", { mode: 0o600 });

    const result = await runWorker(home, telemetryPath, "update", "false");

    expect(result.ok).toBe(true);
    expect(readFileSync(foreignTemp, "utf8")).toBe("foreign temp sentinel");
    expect(tempArtifacts(telemetryPath)).toEqual([basename(foreignTemp)]);
  });

  it("never exposes partial JSON to readers during repeated concurrent writes", async () => {
    const { home, telemetryPath } = createState(true, 0);

    const [firstWriter, secondWriter, reader] = await Promise.all([
      runWorker(home, telemetryPath, "update-many", "120", "0"),
      runWorker(home, telemetryPath, "update-many", "120", "0"),
      runWorker(home, telemetryPath, "read-many", "800"),
    ]);

    expect(firstWriter.ok).toBe(true);
    expect(secondWriter.ok).toBe(true);
    expect(reader.ok).toBe(true);
    expect(reader.elapsedMs).toBeLessThan(5_000);
    expect(reader.snapshots).toHaveLength(800);
    for (const snapshot of reader.snapshots ?? []) {
      expect(snapshot.state).toEqual({
        enabled: expect.any(Boolean),
        installId: INSTALL_ID,
        firstRunAt: FIRST_RUN_AT,
        consentGeneration: expect.stringMatching(UUID_PATTERN),
        revision: expect.any(Number),
      });
      expect(snapshot.enabled).toBe(snapshot.state.enabled);
      expect(snapshot.environmentDisabled).toBe(false);
    }
    const allPublished = [...(firstWriter.states ?? []), ...(secondWriter.states ?? [])];
    expect(allPublished).toContainEqual(readState(telemetryPath));
  });

  it("fails closed quickly on malformed authoritative state and contains gate errors", async () => {
    const { home, telemetryPath } = createState(true, 0);
    writeFileSync(telemetryPath, "partial-json", { mode: 0o600 });
    writeFileSync(`${telemetryPath}.lock`, "foreign-lock", { mode: 0o600 });

    const result = await runWorker(home, telemetryPath, "gate");

    expect(result).toEqual(expect.objectContaining({ ok: true, enabled: false }));
    expect(result.elapsedMs).toBeLessThan(250);
    expect(readFileSync(telemetryPath, "utf8")).toBe("partial-json");
    expect(readFileSync(`${telemetryPath}.lock`, "utf8")).toBe("foreign-lock");
  });

  it("repairs malformed state only through explicit initialization/update and ignores lock artifacts", async () => {
    const { home, telemetryPath } = createState(true, 0);
    writeFileSync(telemetryPath, "partial-json", { mode: 0o600 });
    writeFileSync(`${telemetryPath}.lock`, "foreign-lock", { mode: 0o600 });

    const result = await runWorker(home, telemetryPath, "update", "false");

    expect(result.ok).toBe(true);
    expect(result.state).toEqual({
      enabled: false,
      installId: expect.stringMatching(UUID_PATTERN),
      firstRunAt: expect.any(String),
      consentGeneration: expect.stringMatching(UUID_PATTERN),
      revision: 1,
    });
    expect(readState(telemetryPath)).toEqual(result.state);
    expect(readFileSync(`${telemetryPath}.lock`, "utf8")).toBe("foreign-lock");
  });

  it("applies environment kill switches immediately without consulting lock artifacts", async () => {
    const { home, telemetryPath } = createState(true, 5);
    writeFileSync(`${telemetryPath}.lock`, "foreign-lock", { mode: 0o600 });

    const result = await new Promise<WorkerResult>((resolveRun, reject) => {
      execFile(
        process.execPath,
        ["--import", "tsx", WORKER, "snapshot"],
        {
          cwd: PROJECT_ROOT,
          env: { ...workerEnvironment(home, telemetryPath), DO_NOT_TRACK: "1" },
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
      state: {
        enabled: true,
        installId: INSTALL_ID,
        firstRunAt: FIRST_RUN_AT,
        consentGeneration: INITIAL_GENERATION,
        revision: 5,
      },
      environmentDisabled: true,
      enabled: false,
    });
    expect(result.elapsedMs).toBeLessThan(250);
  });

  it("reads legacy choices without mutation and migrates them on explicit choice", async () => {
    const { home, telemetryPath } = createHome();
    const legacyState = {
      enabled: false,
      installId: INSTALL_ID,
      firstRunAt: FIRST_RUN_AT,
      revision: 27,
    };
    const serializedLegacy = JSON.stringify(legacyState);
    writeFileSync(telemetryPath, serializedLegacy, { mode: 0o600 });

    const result = await runWorker(home, telemetryPath, "initialize");

    expect(result.state).toEqual({
      enabled: false,
      installId: INSTALL_ID,
      firstRunAt: FIRST_RUN_AT,
      consentGeneration: expect.stringMatching(UUID_PATTERN),
      revision: 27,
    });
    expect(readFileSync(telemetryPath, "utf8")).toBe(serializedLegacy);
    const repeatedRead = await runWorker(home, telemetryPath, "initialize");
    expect(repeatedRead.state).toEqual(result.state);
    expect(readFileSync(telemetryPath, "utf8")).toBe(serializedLegacy);

    const updated = await runWorker(home, telemetryPath, "update", "false");
    expect(updated.state).toEqual({
      enabled: false,
      installId: INSTALL_ID,
      firstRunAt: FIRST_RUN_AT,
      consentGeneration: expect.stringMatching(UUID_PATTERN),
      revision: 28,
    });
    expect(updated.state?.consentGeneration).not.toBe(result.state?.consentGeneration);
    expect(readState(telemetryPath)).toEqual(updated.state);
  });

  it("does not let a delayed legacy migration overwrite a successful explicit opt-out", async () => {
    const { home, telemetryPath } = createHome();
    const legacyState = {
      enabled: true,
      installId: INSTALL_ID,
      firstRunAt: FIRST_RUN_AT,
      revision: 27,
    };
    writeFileSync(telemetryPath, JSON.stringify(legacyState), { mode: 0o600 });
    const barrier = join(home, "legacy-migration-barrier");
    mkdirSync(barrier, { mode: 0o700 });
    const migration = startBarrierWorker(
      home,
      telemetryPath,
      barrier,
      "after-read",
      "initialize",
    );
    await waitForPath(join(barrier, "after-read.ready"));

    const optOut = await runWorker(home, telemetryPath, "update", "false");
    writeFileSync(join(barrier, "after-read.release"), "", { mode: 0o600 });
    const migrated = await migration.result;
    const persisted = readState(telemetryPath);

    expect(optOut).toEqual(expect.objectContaining({
      ok: true,
      state: expect.objectContaining({
        enabled: false,
        installId: INSTALL_ID,
        consentGeneration: expect.stringMatching(UUID_PATTERN),
      }),
    }));
    expect(migrated.ok).toBe(true);
    expect(persisted).toEqual(optOut.state);
  });

  it("latches a new runtime off when an older writer changes the legacy revision", async () => {
    const { home, telemetryPath } = createHome();
    writeFileSync(telemetryPath, JSON.stringify({
      enabled: true,
      installId: INSTALL_ID,
      firstRunAt: FIRST_RUN_AT,
      revision: 27,
    }), { mode: 0o600 });
    const readyPath = join(home, "legacy-runtime-ready");
    const releasePath = join(home, "release-legacy-runtime");
    const runtime = spawn(process.execPath, [
      "--import", "tsx", WORKER, "watch-gate", readyPath, releasePath,
    ], {
      cwd: PROJECT_ROOT,
      env: workerEnvironment(home, telemetryPath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(runtime);
    const runtimeResult = new Promise<WorkerResult>((resolveResult, reject) => {
      let stdout = "";
      let stderr = "";
      runtime.stdout?.on("data", chunk => { stdout += String(chunk); });
      runtime.stderr?.on("data", chunk => { stderr += String(chunk); });
      runtime.once("error", reject);
      runtime.once("close", code => {
        if (code !== 0) {
          reject(new Error(`legacy runtime watcher exited ${String(code)}\n${stdout}\n${stderr}`));
          return;
        }
        resolveResult(JSON.parse(stdout.trim()) as WorkerResult);
      });
    });
    await waitForPath(readyPath);

    writeFileSync(telemetryPath, JSON.stringify({
      enabled: true,
      installId: INSTALL_ID,
      firstRunAt: FIRST_RUN_AT,
      revision: 29,
    }), { mode: 0o600 });
    writeFileSync(releasePath, "", { mode: 0o600 });

    await expect(runtimeResult).resolves.toEqual(expect.objectContaining({
      ok: true,
      enabled: false,
      latchedDisabled: true,
    }));
  });
});
