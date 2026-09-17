import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore } from "../usage/store.js";

const dirs: string[] = [];
const stores: UsageStore[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "usage-test-")); dirs.push(dir); return dir; }
function open(dir: string) { const store = UsageStore.open(dir); stores.push(store); return store; }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("usage store", () => {
  it("replays cumulative observations and deduplicates revisions across restart", () => {
    const dir = directory(); const store = open(dir);
    const account = store.account("openai_subscription", "personal");
    const observation = { version: 1 as const, attemptId: "a", revision: 1, ts: "2026-01-01T00:00:00.000Z", accountKey: account.key, provider: account.provider, model: "fixture", complete: false,
      tokens: { input: 40, output: 0, cacheRead: 60, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 } };
    store.observe(observation); store.observe(observation); store.close();
    expect(UsageStore.read(dir).observations[0].tokens.input).toBe(40);
    const reopened = open(dir); reopened.observe(observation);
    reopened.observe({ ...observation, revision: 2, tokens: { ...observation.tokens, output: 20 }, complete: true });
    expect(reopened.snapshot().deltas.map(d => d.tokens.output)).toEqual([0, 20]);
    expect(reopened.snapshot().deltas.reduce((sum, d) => sum + d.tokens.input, 0)).toBe(40);
  });
});

import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { vi } from "vitest";
import * as fs from "node:fs";
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));
import type { UsageObservation } from "../usage/types.js";
function observation(store: UsageStore, patch: Partial<UsageObservation> = {}): UsageObservation {
  const account = store.account("openai_subscription", "personal");
  return { version: 1, attemptId: "a", revision: 1, ts: "2026-01-01T00:00:00.000Z", accountKey: account.key, provider: account.provider, model: "fixture", complete: false,
    tokens: { input: 40, output: 0, cacheRead: 60, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, ...patch };
}
function journal(dir: string) { return join(dir, JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).journal); }
function tokenSum(store: UsageStore) { const s = store.snapshot(); return [...s.deltas, ...s.aggregates].reduce((sum, d) => sum + d.tokens.input + d.tokens.output, 0); }

it("rejects competing writers but allows read-only snapshots", () => {
  const dir = directory(); const store = open(dir); store.observe(observation(store));
  expect(() => UsageStore.open(dir)).toThrow(/locked|writer/i);
  expect(UsageStore.read(dir).deltas).toHaveLength(1);
  store.close(); expect(open(dir).snapshot().deltas).toHaveLength(1);
});
it("recovers demonstrably dead local writer claims, not foreign claims", () => {
  const dir = directory(); const store = open(dir); store.close();
  const claim = `writer.${Buffer.from(hostname()).toString("hex")}.2147483647.dead.lock`;
  mkdirSync(join(dir, claim));
  const recovered = open(dir); expect(recovered.snapshot().warnings.join(" ")).toMatch(/unclean|dead|recover/i); recovered.close();
  mkdirSync(join(dir, `writer.${Buffer.from("other-host").toString("hex")}.2147483647.foreign.lock`));
  expect(() => UsageStore.open(dir)).toThrow(/locked|writer/i);
});
it("offline reads never repair a torn tail; writer recovery is visible after restart", () => {
  const dir = directory(); const store = open(dir); store.observe(observation(store)); store.close();
  const path = journal(dir); appendFileSync(path, '{"version":1,"type":'); const bytes = readFileSync(path);
  const read = UsageStore.read(dir); expect(read.deltas).toHaveLength(1); expect(read.health.status).toBe("degraded");
  expect(readFileSync(path)).toEqual(bytes);
  const recovered = open(dir); expect(recovered.snapshot().warnings.join(" ")).toMatch(/torn/i); recovered.close();
  expect(UsageStore.read(dir).warnings.join(" ")).toMatch(/torn/i);
});
it("refuses interior corruption without overwriting history", () => {
  const dir = directory(); const store = open(dir); store.close(); const path = journal(dir);
  writeFileSync(path, '{}\n{"broken":\n'); const bytes = readFileSync(path);
  expect(() => UsageStore.read(dir)).toThrow(/corrupt|invalid/i);
  expect(() => UsageStore.open(dir)).toThrow(/corrupt|invalid/i);
  expect(readFileSync(path)).toEqual(bytes);
});
it("rejects invalid and decreasing counters and changed identity or frozen rates", () => {
  const store = open(directory()); const first = observation(store, { rates: { input: 2, output: 8, source: "fixture", effectiveDate: "2026-01-01" } }); store.observe(first);
  for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => store.observe({ ...first, revision: 2, tokens: { ...first.tokens, input: value } })).toThrow();
  }
  expect(() => store.observe({ ...first, revision: 2, tokens: { ...first.tokens, input: 39 } })).toThrow(/decreas/i);
  expect(() => store.observe({ ...first, revision: 2, rates: { ...first.rates!, input: 3 } })).toThrow(/rates|immutable/i);
  expect(() => store.observe({ ...first, revision: 2, model: "other" })).toThrow(/identity|immutable/i);
  expect(() => store.observe({ ...first, revision: 2, tokens: { ...first.tokens, cacheWrite5m: 1 } })).toThrow();
  expect(() => store.observe({ ...first, revision: 1, tokens: { ...first.tokens, output: 1 } })).toThrow(/revision|conflict/i);
  expect(tokenSum(store)).toBe(40);
});
it("freezes unknown rates, rejects oversized/private fields, and detaches input and returned state", () => {
  const store = open(directory()); const first = observation(store); store.observe(first); first.tokens.input = 900;
  expect(store.snapshot().observations[0].tokens.input).toBe(40);
  expect(() => store.observe({ ...observation(store), revision: 2, rates: { input: 2, output: 8, source: "x", effectiveDate: "2026-01-01" } })).toThrow(/rates|immutable/i);
  expect(() => store.observe({ ...observation(store), model: "x".repeat(5000) })).toThrow();
  expect(() => store.observe({ ...observation(store), prompt: "private" } as UsageObservation)).toThrow();
  const snapshot = store.snapshot(); snapshot.accounts[0].alias = "mutated";
  expect(store.snapshot().accounts[0].alias).toBe("personal");
});
it("preserves rename, in-flight key, retirement costs, and separates alias reuse", () => {
  const store = open(directory()); const old = store.account("openai_subscription", "personal");
  store.setSubscription("personal", 31, "2026-01-01");
  expect(store.rename(old.provider, "personal", "renamed").key).toBe(old.key);
  store.observe({ ...observation(store), accountKey: old.key });
  store.retire(old.provider, "renamed");
  expect(store.snapshot().subscriptions[0].to).toBeUndefined();
  expect(store.account(old.provider, "renamed").key).not.toBe(old.key);
  expect(store.snapshot().subscriptions[0].accountKey).toBe(old.key);
});
it("compacts completed deltas once, retains active revisions and completed tombstones", () => {
  const dir = directory(); let store = open(dir); const a = observation(store);
  store.observe(a); store.observe({ ...a, attemptId: "b", complete: true });
  store.compact(); expect(store.snapshot().observations).toHaveLength(1); expect(store.snapshot().aggregates).toHaveLength(1);
  expect(tokenSum(store)).toBe(80); store.close(); store = open(dir);
  store.observe({ ...a, attemptId: "b", complete: true });
  expect(() => store.observe({ ...a, attemptId: "b", revision: 2, complete: true })).toThrow(/complete|final/i);
  store.observe({ ...a, revision: 2, complete: true, tokens: { ...a.tokens, output: 10 } });
  store.compact(); store.compact(); store.close();
  store = open(dir); expect(tokenSum(store)).toBe(90); expect(store.snapshot().observations).toHaveLength(0);
});
it("keeps old generation authoritative when manifest publication fails", () => {
  const dir = directory(); const store = open(dir); store.observe(observation(store, { complete: true }));
  const old = readFileSync(join(dir, "manifest.json"), "utf8");
  const original = fs.renameSync; const mock = vi.spyOn(fs, "renameSync").mockImplementation((a,b) => { if (String(b).endsWith("manifest.json")) throw new Error("disk full"); return original(a,b); });
  try { expect(() => store.compact()).toThrow(/disk full/); } finally { mock.mockRestore(); }
  expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe(old);
  expect(UsageStore.read(dir).deltas).toHaveLength(1); expect(store.snapshot().health.status).toBe("degraded");
});
it("ignores orphan generations after publication and does not double count retained old files", () => {
  const dir = directory(); const store = open(dir); store.observe(observation(store, { complete: true }));
  const oldPath = journal(dir); const old = readFileSync(oldPath); store.compact(); writeFileSync(oldPath, old);
  writeFileSync(join(dir, "state-orphan.json"), "corrupt orphan");
  expect(UsageStore.read(dir).aggregates[0].tokens.input).toBe(40);
  expect(UsageStore.read(dir).deltas).toHaveLength(0);
});
it("uses owner-only modes and read-only missing directories remain absent", () => {
  const dir = directory(); const missing = join(dir, "missing");
  expect(UsageStore.read(missing).trackingSince).toBeUndefined(); expect(readdirSync(dir)).toEqual([]);
  const store = open(missing); store.setSubscription(store.account("openai_subscription", "p").key, 0, "2026-01-01");
  if (process.platform !== "win32") {
    expect(statSync(missing).mode & 0o777).toBe(0o700);
    for (const path of readdirSync(missing)) expect(statSync(join(missing, path)).mode & 0o077).toBe(0);
  }
});
it("surfaces append errors and refuses subsequent writes on an uncertain journal", () => {
  const store = open(directory()); const record = observation(store);
  const mock = vi.spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("disk full"); });
  try { expect(() => store.observe(record)).toThrow(/disk full/); } finally { mock.mockRestore(); }
  expect(store.snapshot().deltas).toHaveLength(0); expect(store.snapshot().health.status).toBe("degraded");
  expect(() => store.observe(record)).toThrow(/unhealthy|failed|reopen/i);
});

it("does not revert subscription configuration when its file goes missing after compaction", () => {
  const dir = directory(); const store = open(dir); store.account("openai_subscription", "personal");
  store.setSubscription("personal", 31, "2026-01-01"); store.compact(); store.setSubscription("personal", 62, "2026-02-01"); store.close();
  rmSync(join(dir, "subscriptions.json"));
  expect(() => UsageStore.read(dir)).toThrow(/subscription|missing/i);
});
it("keeps a persistence failure visible to read-only readers and across clean close/reopen", () => {
  const dir = directory(); const store = open(dir); const record = observation(store);
  const mock = vi.spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("disk full"); });
  try { expect(() => store.observe(record)).toThrow(); } finally { mock.mockRestore(); }
  expect(UsageStore.read(dir).health.status).toBe("degraded");
  store.close(); const recovered = open(dir).snapshot(); expect(recovered.health.status).toBe("ok"); expect(recovered.gaps?.some(gap => gap.end)).toBe(true);
});
it("retries a reader whose old generation is retired after it read the manifest", () => {
  const dir = directory(); const store = open(dir); store.observe(observation(store, { complete: true }));
  const oldState = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).state;
  const original = fs.readFileSync; let raced = false;
  const mock = vi.spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(path).endsWith(oldState) && !raced) { raced = true; store.compact(); }
    return (original as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readFileSync);
  try { const read = UsageStore.read(dir); expect(read.aggregates[0].tokens.input).toBe(40); expect(read.deltas).toEqual([]); } finally { mock.mockRestore(); }
});
it("keeps published compaction authoritative when old-file retirement fails", () => {
  const dir = directory(); const store = open(dir); store.observe(observation(store, { complete: true }));
  const oldPath = journal(dir); const original = fs.unlinkSync;
  const mock = vi.spyOn(fs, "unlinkSync").mockImplementation(path => { if (String(path) === oldPath) throw new Error("cleanup interrupted"); return original(path); });
  try { expect(() => store.compact()).toThrow(/interrupted/); } finally { mock.mockRestore(); }
  const read = UsageStore.read(dir); expect(read.deltas).toEqual([]); expect(read.aggregates[0].tokens.input).toBe(40);
  store.close(); const reopened = open(dir); reopened.compact(); expect(tokenSum(reopened)).toBe(40);
});
it("rejects malformed persisted aggregate and cross-account delta identity", () => {
  const dir = directory(); const store = open(dir); const a = observation(store); store.observe(a);
  const b = store.account("openai_subscription", "other"); store.compact(); store.close();
  const path = join(dir, JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).state);
  const state = JSON.parse(readFileSync(path, "utf8")); state.deltas[0].accountKey = b.key; writeFileSync(path, JSON.stringify(state));
  expect(() => UsageStore.read(dir)).toThrow(/delta|identity|invalid/i);
});
it("rejects an oversized unterminated record instead of treating arbitrary data as torn tail", () => {
  const dir = directory(); const store = open(dir); store.close(); appendFileSync(journal(dir), "x".repeat(65537));
  expect(() => UsageStore.read(dir)).toThrow(/oversized|size/i);
});
it("reports interrupted shutdown when reading a dead writer without mutating its claim", () => {
  const dir = directory(); const store = open(dir); store.close();
  const claim = join(dir, `writer.${Buffer.from(hostname()).toString("hex")}.2147483647.dead.lock`); mkdirSync(claim);
  expect(UsageStore.read(dir).health.status).toBe("degraded"); expect(statSync(claim).isDirectory()).toBe(true);
});
it("does not clone historical state on each observation or identity write", () => {
  const store = open(directory()); const a = observation(store); store.observe({ ...a, complete: true }); store.compact();
  const clone = vi.spyOn(globalThis, "structuredClone");
  try {
    store.observe({ ...a, attemptId: "b" }); store.account("openai_subscription", "new-account");
    expect(clone.mock.calls.some(([value]) => value && typeof value === "object" && "observations" in value)).toBe(false);
  } finally { clone.mockRestore(); }
});
it("handles over ten thousand completed attempts without history-sized work per callback", () => {
  const dir = directory(); const store = open(dir); const a = observation(store, { complete: true });
  // Keep real journal writes/replay/compaction; remove only device-specific fsync latency.
  const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => {});
  const start = performance.now();
  try {
    for (let i = 0; i < 10001; i++) store.observe({ ...a, attemptId: `done-${i}` });
    store.compact();
    for (let i = 0; i < 10001; i++) store.observe({ ...a, attemptId: `done-${i}` });
    for (let i = 1; i <= 1000; i++) store.observe({ ...a, attemptId: "active", complete: false, revision: i, tokens: { ...a.tokens, output: i } });
    expect(tokenSum(store)).toBe(10002 * 40 + 1000);
    store.close(); const reopened = open(dir);
    expect(tokenSum(reopened)).toBe(10002 * 40 + 1000);
    console.info(`usage-core benchmark: 11001 persisted observations + 10001 compacted duplicate callbacks + compaction/restart: ${Math.round(performance.now() - start)}ms (fsync stubbed)`);
  } finally { sync.mockRestore(); }
}, 30000);
it("retries concurrent alias plus subscription publication instead of reporting false corruption", () => {
  const dir = directory(); const store = open(dir); const original = fs.readFileSync; let raced = false;
  const mock = vi.spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(path).endsWith("subscriptions.json") && !raced) {
      raced = true; store.account("openai_subscription", "new"); store.setSubscription("new", 31, "2026-01-01");
    }
    return (original as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readFileSync);
  try { const read = UsageStore.read(dir); expect(read.accounts).toHaveLength(1); expect(read.subscriptions).toHaveLength(1); } finally { mock.mockRestore(); }
});
it("keeps recovery loss visible if truncation succeeds but recovery sync fails", () => {
  const dir = directory(); const store = open(dir); store.close(); appendFileSync(journal(dir), '{"partial":');
  const originalSync = fs.fsyncSync; let failed = false;
  const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { if (!failed && fs.fstatSync(fd).isFile()) { failed = true; throw new Error("recovery sync failed"); } return originalSync(fd); });
  try { expect(() => UsageStore.open(dir)).toThrow(/recovery sync/); } finally { sync.mockRestore(); }
  expect(UsageStore.read(dir).health.status).toBe("degraded");
});
it("records repeated torn-tail recoveries as distinct bounded gaps and permits later healthy savings", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-01-01")); const dir = directory(); let store = open(dir);
    store.account("openai_subscription", "personal"); store.setSubscription("personal", 31, "2026-01-01"); store.close();
    vi.setSystemTime(new Date("2026-01-02")); appendFileSync(journal(dir), '{"partial":'); store = open(dir); store.close();
    vi.setSystemTime(new Date("2026-01-03")); appendFileSync(journal(dir), '{"partial":');
    expect(UsageStore.read(dir).health.status).toBe("degraded");
    store = open(dir); const state = store.snapshot();
    expect(state.health.status).toBe("ok"); expect(state.gaps?.filter(gap => gap.id.startsWith("torn-"))).toHaveLength(2);
    expect(queryUsage(state, { period: "day", date: "2026-01-04" }, "2026-01-05").costs.savingsUsd).toBe(-1);
  } finally { vi.useRealTimers(); }
});
import { queryUsage } from "../usage/query.js";
it("bounds a compacted torn-tail gap from the last known hour start, not its future end", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-01-01")); const dir = directory(); const store = open(dir);
    vi.setSystemTime(new Date("2026-01-01T10:01:00.000Z")); store.observe(observation(store, { complete: true, ts: new Date().toISOString() })); store.compact(); store.close();
    vi.setSystemTime(new Date("2026-01-01T10:05:00.000Z")); appendFileSync(journal(dir), '{"partial":');
    expect(UsageStore.read(dir).gaps?.find(g => g.id.startsWith("torn-"))?.start).toBe("2026-01-01T10:00:00.000Z");
  } finally { vi.useRealTimers(); }
});

it("attributes an append failure across midnight to the lost observation's day", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z")); const dir = directory(); let store = open(dir);
    store.account("openai_subscription", "personal"); store.setSubscription("personal", 31, "2026-01-01");
    const record = observation(store, { ts: "2026-01-01T23:59:59.999Z", complete: true });
    vi.setSystemTime(new Date("2026-01-02T00:00:00.001Z"));
    const write = vi.spyOn(fs, "writeSync").mockImplementationOnce(() => { throw new Error("boundary write failed"); });
    try { expect(() => store.observe(record)).toThrow(/boundary/); } finally { write.mockRestore(); }
    store.close(); vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z")); store = open(dir);
    const previous = queryUsage(store.snapshot(), { period: "day", date: "2026-01-01" }, "2026-01-03");
    expect(previous.costs.coverage.trackingComplete).toBe(false); expect(previous.costs.savingsUsd).toBeNull();
    expect(queryUsage(store.snapshot(), { period: "day", date: "2026-01-03" }, "2026-01-04").costs.savingsUsd).toBe(-1);
  } finally { vi.useRealTimers(); }
});
it.each(["state-", "subscriptions.json", "manifest.json"])("recovers interrupted first %s publication without overwriting established history", failedFile => {
  const dir = directory(); const real = fs.renameSync;
  const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to).split(/[\\/]/).at(-1)?.startsWith(failedFile)) throw new Error("initial publication failed");
    return real(from, to);
  });
  try { expect(() => UsageStore.open(dir)).toThrow(/initial publication/); } finally { rename.mockRestore(); }
  const recovered = open(dir); recovered.observe(observation(recovered, { complete: true })); recovered.close();
  expect(UsageStore.read(dir).deltas[0].tokens.input).toBe(40);
  fs.unlinkSync(join(dir, "manifest.json"));
  expect(() => UsageStore.open(dir)).toThrow(/manifest missing/);
});

it("compacts settled incomplete attempts while retaining provider-scoped daily coverage gaps", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-01-01")); const dir = directory(); const store = open(dir);
    store.account("openai_subscription", "personal"); store.account("anthropic_subscription", "claude");
    store.setSubscription("personal", 0, "2026-01-01"); store.setSubscription("claude", 0, "2026-01-01");
    const partial = observation(store, { ts: "2026-01-02T12:00:00.000Z", settled: true, complete: false });
    store.observe(partial); store.compact();
    expect(store.snapshot().observations).toHaveLength(0);
    expect(store.snapshot().aggregates[0].tokens.input).toBe(40);
    const selected = queryUsage(store.snapshot(), { period: "day", date: "2026-01-02", providers: ["openai_subscription"] }, "2026-01-03");
    expect(selected.costs.coverage.trackingComplete).toBe(false); expect(selected.costs.savingsUsd).toBeNull();
    expect(queryUsage(store.snapshot(), { period: "day", date: "2026-01-02", providers: ["anthropic_subscription"] }, "2026-01-03").costs.savingsUsd).toBe(0);
    expect(() => store.observe({ ...partial, revision: 2 })).toThrow(/complete|settled/);
    store.close(); expect(UsageStore.read(dir).gaps?.some(g => g.provider === "openai_subscription")).toBe(true);
  } finally { vi.useRealTimers(); }
});
