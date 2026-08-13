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
  renameSync,
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
  worker: "first" | "second" | "reclaimer" | "queue-swap" | "queue-open-swap"
    | "queue-rename-swap" | "queue-unlink-swap" | "queue-stale-swap" | "quarantine-swap"
    | "empty-quarantine",
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

function reclaimArtifacts(telemetryPath: string): string[] {
  const prefix = `${basename(telemetryPath)}.lock.reclaim.`;
  return readdirSync(dirname(telemetryPath)).filter(name => name.startsWith(prefix)).sort();
}

function queueArtifacts(telemetryPath: string): string[] {
  const prefix = `${basename(telemetryPath)}.lock.queue.v1.`;
  return readdirSync(dirname(telemetryPath)).filter(name => name.startsWith(prefix)).sort();
}

function queueCleanupArtifacts(telemetryPath: string): string[] {
  const prefix = `${basename(telemetryPath)}.lock.queue-cleanup.v1.`;
  return readdirSync(dirname(telemetryPath)).filter(name => name.startsWith(prefix)).sort();
}

function queueEntryName(
  telemetryPath: string,
  owner: { token: string; pid: number; createdAt: number },
): string {
  return `${basename(telemetryPath)}.lock.queue.v1.${String(owner.pid)}.${
    String(owner.createdAt)
  }.${owner.token}.choosing`;
}

function quarantineName(
  telemetryPath: string,
  reclaimer: { token: string; pid: number; createdAt: number },
  owner: { token: string; pid: number; createdAt: number },
): string {
  return `${basename(telemetryPath)}.lock.reclaim.v1.${String(reclaimer.pid)}.${
    String(reclaimer.createdAt)
  }.${reclaimer.token}.${String(owner.pid)}.${String(owner.createdAt)}.${owner.token}`;
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

  it("ignores an inert legacy queue symlink without touching its external target", async () => {
    const { home, telemetryPath } = createState(true, 8);
    const external = join(home, "external-queue-target");
    mkdirSync(external, { mode: 0o700 });
    const queuePath = `${telemetryPath}.lock.queue`;
    symlinkSync(external, queuePath, process.platform === "win32" ? "junction" : "dir");

    const result = await runWorker(home, telemetryPath, "update", "false");

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      state: { enabled: false, installId: INSTALL_ID, firstRunAt: FIRST_RUN_AT, revision: 9 },
    }));
    expect(lstatSync(queuePath).isSymbolicLink()).toBe(true);
    expect(readdirSync(external)).toEqual([]);
    expect(JSON.parse(readFileSync(telemetryPath, "utf8"))).toEqual({
      enabled: false,
      installId: INSTALL_ID,
      firstRunAt: FIRST_RUN_AT,
      revision: 9,
    });
  });

  it("ignores an inert legacy queue file without replacing or changing it", async () => {
    const { home, telemetryPath } = createState(true, 9);
    const queuePath = `${telemetryPath}.lock.queue`;
    writeFileSync(queuePath, "foreign queue file", { mode: 0o600 });

    const result = await runWorker(home, telemetryPath, "update", "false");

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      state: { enabled: false, installId: INSTALL_ID, firstRunAt: FIRST_RUN_AT, revision: 10 },
    }));
    expect(lstatSync(queuePath).isFile()).toBe(true);
    expect(readFileSync(queuePath, "utf8")).toBe("foreign queue file");
    expect(JSON.parse(readFileSync(telemetryPath, "utf8"))).toEqual({
      enabled: false,
      installId: INSTALL_ID,
      firstRunAt: FIRST_RUN_AT,
      revision: 10,
    });
  });

  it("never chmods or enters an inert legacy queue directory", async () => {
    const { home, telemetryPath } = createState(true, 10);
    const queuePath = `${telemetryPath}.lock.queue`;
    mkdirSync(queuePath, { mode: 0o700 });
    chmodSync(queuePath, 0o777);

    const result = await runWorker(home, telemetryPath, "update", "false");

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      state: { enabled: false, installId: INSTALL_ID, firstRunAt: FIRST_RUN_AT, revision: 11 },
    }));
    const status = statSync(queuePath);
    expect(status.isDirectory()).toBe(true);
    expect(lstatSync(queuePath).isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") expect(status.mode & 0o777).toBe(0o777);
  });

  it("does not follow a legacy queue swapped to an external directory after validation", async () => {
    const { home, telemetryPath } = createState(true, 11);
    const queuePath = `${telemetryPath}.lock.queue`;
    const savedQueue = join(home, "validated-queue");
    const external = join(home, "external-queue-swap-target");
    const barrier = join(home, "queue-swap");
    mkdirSync(queuePath, { mode: 0o700 });
    mkdirSync(external, { mode: 0o700 });
    mkdirSync(barrier, { mode: 0o700 });
    chmodSync(external, 0o777);
    const worker = startRaceWorker(home, telemetryPath, barrier, "queue-swap", false);
    await waitForPath(join(barrier, "queue-swap.queue-ready"));
    renameSync(queuePath, savedQueue);
    symlinkSync(external, queuePath, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(barrier, "queue-swap.release-queue"), "", { mode: 0o600 });

    const result = await worker.result;

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      state: { enabled: false, installId: INSTALL_ID, firstRunAt: FIRST_RUN_AT, revision: 12 },
    }));
    expect(readdirSync(external)).toEqual([]);
    expect(readdirSync(savedQueue)).toEqual([]);
    if (process.platform !== "win32") expect(statSync(external).mode & 0o777).toBe(0o777);
  });

  it("does not create a contender through a queue directory swapped before open", async () => {
    const { home, telemetryPath } = createState(true, 12);
    const queuePath = `${telemetryPath}.lock.queue`;
    const savedQueue = join(home, "open-validated-queue");
    const external = join(home, "external-queue-open-target");
    const barrier = join(home, "queue-open-swap");
    mkdirSync(queuePath, { mode: 0o700 });
    mkdirSync(external, { mode: 0o700 });
    mkdirSync(barrier, { mode: 0o700 });
    const worker = startRaceWorker(home, telemetryPath, barrier, "queue-open-swap", false);
    await waitForPath(join(barrier, "queue-open-swap.before-queue-open"));
    renameSync(queuePath, savedQueue);
    symlinkSync(external, queuePath, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(barrier, "queue-open-swap.release-queue-open"), "", { mode: 0o600 });
    await waitForPath(join(barrier, "queue-open-swap.queue-opened"));
    const externalDuringOpen = readdirSync(external);
    writeFileSync(join(barrier, "queue-open-swap.release-queue-opened"), "", { mode: 0o600 });

    const result = await worker.result;

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      state: { enabled: false, installId: INSTALL_ID, firstRunAt: FIRST_RUN_AT, revision: 13 },
    }));
    expect(externalDuringOpen).toEqual([]);
  });

  it("does not rename a contender through a queue directory swapped after publication", async () => {
    const { home, telemetryPath } = createState(true, 13);
    const queuePath = `${telemetryPath}.lock.queue`;
    const savedQueue = join(home, "rename-published-queue");
    const external = join(home, "external-queue-rename-target");
    const barrier = join(home, "queue-rename-swap");
    mkdirSync(queuePath, { mode: 0o700 });
    mkdirSync(external, { mode: 0o700 });
    mkdirSync(barrier, { mode: 0o700 });
    const worker = startRaceWorker(home, telemetryPath, barrier, "queue-rename-swap", false);
    await waitForPath(join(barrier, "queue-rename-swap.before-queue-rename"));
    renameSync(queuePath, savedQueue);
    symlinkSync(external, queuePath, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(barrier, "queue-rename-swap.release-queue-rename"), "", { mode: 0o600 });

    const result = await worker.result;

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      state: { enabled: false, installId: INSTALL_ID, firstRunAt: FIRST_RUN_AT, revision: 14 },
    }));
    expect(readdirSync(external)).toEqual([]);
  });

  it("does not unlink through a queue directory swapped after final owner validation", async () => {
    const { home, telemetryPath } = createState(true, 14);
    const queuePath = `${telemetryPath}.lock.queue`;
    const savedQueue = join(home, "unlink-validated-queue");
    const external = join(home, "external-queue-unlink-target");
    const barrier = join(home, "queue-unlink-swap");
    mkdirSync(queuePath, { mode: 0o700 });
    mkdirSync(external, { mode: 0o700 });
    mkdirSync(barrier, { mode: 0o700 });
    const worker = startRaceWorker(home, telemetryPath, barrier, "queue-unlink-swap", false);
    await waitForPath(join(barrier, "queue-unlink-swap.before-queue-unlink"));
    const activeName = readdirSync(queuePath)[0] ?? queueArtifacts(telemetryPath)[0];
    expect(activeName).toBeTypeOf("string");
    renameSync(queuePath, savedQueue);
    symlinkSync(external, queuePath, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(external, activeName!), "external unlink sentinel", { mode: 0o600 });
    writeFileSync(join(barrier, "queue-unlink-swap.release-queue-unlink"), "", { mode: 0o600 });

    const result = await worker.result;

    expect(result.ok).toBe(true);
    expect(readFileSync(join(external, activeName!), "utf8")).toBe("external unlink sentinel");
  });

  it.each(["symlink", "hardlink"] as const)(
    "fails closed for a valid-looking same-parent queue %s without touching its external target",
    async kind => {
      const { home, telemetryPath } = createState(true, 12);
      const holder = await startLockHolder(home, telemetryPath);
      await stopChild(holder.child);
      await new Promise(resolveWait => setTimeout(resolveWait, 300));
      const external = join(home, `external-queue-${kind}`);
      writeFileSync(external, "external queue sentinel", { mode: 0o600 });
      const entryPath = join(dirname(telemetryPath), queueEntryName(telemetryPath, holder.owner));
      if (kind === "symlink") symlinkSync(external, entryPath, "file");
      else linkSync(external, entryPath);

      const result = await runWorker(home, telemetryPath, "update", "false");

      expect(result.ok).toBe(false);
      expect(result.elapsedMs).toBeLessThan(1_000);
      expect(readFileSync(external, "utf8")).toBe("external queue sentinel");
      expect(existsSync(entryPath)).toBe(true);
      expect(JSON.parse(readFileSync(telemetryPath, "utf8"))).toEqual({
        enabled: true,
        installId: INSTALL_ID,
        firstRunAt: FIRST_RUN_AT,
        revision: 12,
      });
    },
  );

  it("fails closed for a permissive same-parent queue record", async () => {
    const { home, telemetryPath } = createState(true, 15);
    const holder = await startLockHolder(home, telemetryPath);
    await stopChild(holder.child);
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
    const entryPath = join(dirname(telemetryPath), queueEntryName(telemetryPath, holder.owner));
    writeFileSync(entryPath, JSON.stringify(holder.owner), { mode: 0o600 });
    chmodSync(entryPath, 0o666);

    const result = await runWorker(home, telemetryPath, "update", "false");

    expect(result.ok).toBe(false);
    expect(readFileSync(entryPath, "utf8")).toBe(JSON.stringify(holder.owner));
    if (process.platform !== "win32") expect(statSync(entryPath).mode & 0o777).toBe(0o666);
  });

  it("fails the mutation when a validated stale queue record changes before retirement", async () => {
    const { home, telemetryPath } = createState(true, 16);
    const holder = await startLockHolder(home, telemetryPath);
    await stopChild(holder.child);
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
    const entryPath = join(dirname(telemetryPath), queueEntryName(telemetryPath, holder.owner));
    const relocated = join(home, "relocated-stale-queue-record");
    const external = join(home, "external-stale-queue-target");
    const barrier = join(home, "queue-stale-swap");
    writeFileSync(entryPath, JSON.stringify(holder.owner), { mode: 0o600 });
    writeFileSync(external, "external stale queue sentinel", { mode: 0o600 });
    mkdirSync(barrier, { mode: 0o700 });
    const worker = startRaceWorker(home, telemetryPath, barrier, "queue-stale-swap", false);
    await waitForPath(join(barrier, "queue-stale-swap.before-stale-queue-retire"));
    renameSync(entryPath, relocated);
    symlinkSync(external, entryPath, "file");
    writeFileSync(join(barrier, "queue-stale-swap.release-stale-queue-retire"), "", { mode: 0o600 });

    const result = await worker.result;

    expect(result.ok).toBe(false);
    expect(result.elapsedMs).toBeLessThan(1_000);
    expect(readFileSync(external, "utf8")).toBe("external stale queue sentinel");
    expect(readFileSync(relocated, "utf8")).toBe(JSON.stringify(holder.owner));
    expect(JSON.parse(readFileSync(telemetryPath, "utf8"))).toEqual({
      enabled: true,
      installId: INSTALL_ID,
      firstRunAt: FIRST_RUN_AT,
      revision: 16,
    });
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
    const [queueArtifact] = queueArtifacts(telemetryPath);
    expect(queueArtifact).toBeTypeOf("string");
    const queueStatus = lstatSync(join(dirname(telemetryPath), queueArtifact!));
    expect(queueStatus.isFile()).toBe(true);
    expect(queueStatus.nlink).toBe(1);
    if (process.platform !== "win32") expect(queueStatus.mode & 0o777).toBe(0o600);
    const result = await runWorker(home, telemetryPath, "update", "false");

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      state: { enabled: false, installId: INSTALL_ID, firstRunAt: FIRST_RUN_AT, revision: 21 },
    }));
    expect(result.elapsedMs).toBeLessThan(1_000);
    expect(queueArtifacts(telemetryPath)).toHaveLength(0);
    expect(queueCleanupArtifacts(telemetryPath)).toHaveLength(0);
    expect(existsSync(`${telemetryPath}.lock`)).toBe(false);
  });

  it("reclaims an exact crash-window quarantine without accumulating killed artifacts", async () => {
    const { home, telemetryPath } = createState(true, 0);

    for (let round = 1; round <= 3; round += 1) {
      const holder = await startLockHolder(home, telemetryPath);
      await stopChild(holder.child);
      await new Promise(resolveWait => setTimeout(resolveWait, 300));
      const barrier = join(home, `killed-reclaimer-${String(round)}`);
      mkdirSync(barrier, { mode: 0o700 });
      const killed = startRaceWorker(home, telemetryPath, barrier, "reclaimer", false);
      const ignoredKilledResult = killed.result.catch(() => undefined);
      await waitForPath(join(barrier, "reclaimer.renamed-quarantine"));

      expect(existsSync(`${telemetryPath}.lock`)).toBe(false);
      const [reclaimArtifact] = reclaimArtifacts(telemetryPath);
      expect(reclaimArtifact).toBeTypeOf("string");
      const reclaimStatus = lstatSync(join(dirname(telemetryPath), reclaimArtifact!));
      expect(reclaimStatus.isFile()).toBe(true);
      expect(reclaimStatus.nlink).toBe(1);
      if (process.platform !== "win32") expect(reclaimStatus.mode & 0o777).toBe(0o600);
      await stopChild(killed.child);
      await ignoredKilledResult;

      const recovered = await runWorker(home, telemetryPath, "update", String(round % 2 === 0));
      expect(recovered).toEqual(expect.objectContaining({
        ok: true,
        state: expect.objectContaining({ revision: round }),
      }));
      expect(reclaimArtifacts(telemetryPath)).toEqual([]);
      expect(queueCleanupArtifacts(telemetryPath)).toEqual([]);
    }
  });

  it("never follows a quarantine swapped after validation before its mutation", async () => {
    const { home, telemetryPath } = createState(true, 3);
    const holder = await startLockHolder(home, telemetryPath);
    await stopChild(holder.child);
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
    const creationBarrier = join(home, "quarantine-creation");
    mkdirSync(creationBarrier, { mode: 0o700 });
    const creator = startRaceWorker(home, telemetryPath, creationBarrier, "reclaimer", false);
    const ignoredCreatorResult = creator.result.catch(() => undefined);
    await waitForPath(join(creationBarrier, "reclaimer.renamed-quarantine"));
    await stopChild(creator.child);
    await ignoredCreatorResult;
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
    const [artifactName] = reclaimArtifacts(telemetryPath);
    expect(artifactName).toBeTypeOf("string");
    const artifactPath = join(dirname(telemetryPath), artifactName!);

    const barrier = join(home, "quarantine-swap");
    mkdirSync(barrier, { mode: 0o700 });
    const cleanup = startRaceWorker(home, telemetryPath, barrier, "quarantine-swap", false);
    await waitForPath(join(barrier, "quarantine-swap.before-quarantine-mutation"));
    const relocated = join(home, "relocated-quarantine");
    const external = join(home, "external-quarantine-swap-target");
    const wasDirectory = lstatSync(artifactPath).isDirectory();
    renameSync(artifactPath, relocated);
    if (wasDirectory) {
      mkdirSync(external, { mode: 0o700 });
      writeFileSync(join(external, "owner"), "external quarantine sentinel", { mode: 0o600 });
      symlinkSync(external, artifactPath, process.platform === "win32" ? "junction" : "dir");
    } else {
      writeFileSync(external, "external quarantine sentinel", { mode: 0o600 });
      symlinkSync(external, artifactPath, "file");
    }
    writeFileSync(join(barrier, "quarantine-swap.release-quarantine-mutation"), "", { mode: 0o600 });

    const result = await cleanup.result;

    expect(result.ok).toBe(true);
    const externalSentinel = wasDirectory ? join(external, "owner") : external;
    expect(readFileSync(externalSentinel, "utf8")).toBe("external quarantine sentinel");
    expect(existsSync(relocated)).toBe(true);
    const [ambiguousArtifact] = reclaimArtifacts(telemetryPath);
    expect(ambiguousArtifact).toBeTypeOf("string");
    expect(lstatSync(join(dirname(telemetryPath), ambiguousArtifact!)).isSymbolicLink()).toBe(true);
  });

  it("leaves no empty quarantine when a cleaner dies immediately after removing its file", async () => {
    const { home, telemetryPath } = createState(true, 0);
    const holder = await startLockHolder(home, telemetryPath);
    await stopChild(holder.child);
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
    const creationBarrier = join(home, "empty-quarantine-creation");
    mkdirSync(creationBarrier, { mode: 0o700 });
    const creator = startRaceWorker(home, telemetryPath, creationBarrier, "reclaimer", false);
    const ignoredCreatorResult = creator.result.catch(() => undefined);
    await waitForPath(join(creationBarrier, "reclaimer.renamed-quarantine"));
    await stopChild(creator.child);
    await ignoredCreatorResult;
    await new Promise(resolveWait => setTimeout(resolveWait, 300));

    const barrier = join(home, "empty-quarantine-cleanup");
    mkdirSync(barrier, { mode: 0o700 });
    const killed = startRaceWorker(home, telemetryPath, barrier, "empty-quarantine", false);
    const ignoredKilledResult = killed.result.catch(() => undefined);
    await waitForPath(join(barrier, "empty-quarantine.removed-quarantine-file"));
    await stopChild(killed.child);
    await ignoredKilledResult;

    const recovered = await runWorker(home, telemetryPath, "update", "false");

    expect(recovered).toEqual(expect.objectContaining({
      ok: true,
      state: expect.objectContaining({ revision: 1 }),
    }));
    expect(reclaimArtifacts(telemetryPath)).toEqual([]);
    expect(queueArtifacts(telemetryPath)).toEqual([]);
    expect(queueCleanupArtifacts(telemetryPath)).toEqual([]);
  });

  it("preserves live, malformed, permissive, symlinked, and hardlinked quarantine files", async () => {
    const { home, telemetryPath } = createState(true, 4);
    const holder = await startLockHolder(home, telemetryPath);
    await stopChild(holder.child);
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
    const configDir = dirname(telemetryPath);
    const liveReclaimer = {
      token: "123e4567-e89b-42d3-a456-426614174081",
      pid: process.pid,
      createdAt: Date.now() - 1_000,
    };
    const liveName = quarantineName(telemetryPath, liveReclaimer, holder.owner);
    const livePath = join(configDir, liveName);
    renameSync(`${telemetryPath}.lock`, livePath);

    const deadReclaimer = {
      token: "123e4567-e89b-42d3-a456-426614174082",
      pid: holder.owner.pid,
      createdAt: holder.owner.createdAt,
    };
    const malformedName = quarantineName(telemetryPath, deadReclaimer, {
      ...holder.owner,
      token: "123e4567-e89b-42d3-a456-426614174083",
    });
    const malformedPath = join(configDir, malformedName);
    writeFileSync(malformedPath, "not-json", { mode: 0o600 });

    const external = join(home, "external-quarantine-target");
    writeFileSync(external, JSON.stringify(holder.owner), { mode: 0o600 });
    const symlinkName = quarantineName(telemetryPath, {
      ...deadReclaimer,
      token: "123e4567-e89b-42d3-a456-426614174084",
    }, holder.owner);
    const symlinkPath = join(configDir, symlinkName);
    symlinkSync(external, symlinkPath, "file");

    const hardlinkName = quarantineName(telemetryPath, {
      ...deadReclaimer,
      token: "123e4567-e89b-42d3-a456-426614174085",
    }, holder.owner);
    const hardlinkPath = join(configDir, hardlinkName);
    linkSync(external, hardlinkPath);

    const permissiveName = quarantineName(telemetryPath, {
      ...deadReclaimer,
      token: "123e4567-e89b-42d3-a456-426614174086",
    }, holder.owner);
    const permissivePath = join(configDir, permissiveName);
    writeFileSync(permissivePath, JSON.stringify(holder.owner), { mode: 0o600 });
    chmodSync(permissivePath, 0o666);

    const result = await runWorker(home, telemetryPath, "update", "false");

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      state: { enabled: false, installId: INSTALL_ID, firstRunAt: FIRST_RUN_AT, revision: 5 },
    }));
    expect(reclaimArtifacts(telemetryPath)).toEqual([
      hardlinkName, liveName, malformedName, permissiveName, symlinkName,
    ].sort());
    expect(readFileSync(livePath, "utf8")).toBe(JSON.stringify(holder.owner));
    expect(readFileSync(malformedPath, "utf8")).toBe("not-json");
    expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(statSync(hardlinkPath).nlink).toBeGreaterThanOrEqual(2);
    if (process.platform !== "win32") expect(statSync(permissivePath).mode & 0o777).toBe(0o666);
    expect(readFileSync(external, "utf8")).toBe(JSON.stringify(holder.owner));
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
