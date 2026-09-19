vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync), openSync: vi.fn(fs.openSync), unlinkSync: vi.fn(fs.unlinkSync) };
});
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync, statSync, openSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { UsageStore } from "../usage/store.js";
import { coordinateAccountWrite, recoverAccountTransition, registerUsageWriter, usageDirectoryForAccounts, withUsageRename } from "../usage/account-lifecycle.js";
const dirs: string[] = []; const closers: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.mocked(openSync).mockRestore(); vi.mocked(unlinkSync).mockRestore(); closers.splice(0).reverse().forEach(f => f()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const before = [{ id: "old", provider: "openai_subscription" as const }]; const after = [{ id: "new", provider: "openai_subscription" as const }];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "usage-lifecycle-")); dirs.push(dir); const file = join(dir, "accounts.json"); const usage = usageDirectoryForAccounts(file); const store = UsageStore.open(usage); closers.push(() => store.close()); store.account("openai_subscription", "old"); writeFileSync(file, JSON.stringify(before)); return { file, usage, store }; }
it("renames offline without changing account key or subscription, with no secret sidecar", () => {
  const { file, usage, store } = fixture(); const key = store.snapshot().accounts[0]!.key; store.setSubscription("old", 20, "2026-01-01"); store.close();
  withUsageRename(file, "old", "new", () => coordinateAccountWrite(file, before, after, () => writeFileSync(file, JSON.stringify(after))));
  const snapshot = UsageStore.read(usage); expect(snapshot.accounts).toEqual([{ key, provider: "openai_subscription", alias: "new" }]); expect(snapshot.subscriptions[0]?.accountKey).toBe(key); expect(existsSync(join(usage, "account-transition.json"))).toBe(false);
});
it("rolls alias back when credential persistence fails", () => {
  const { file, usage, store } = fixture(); store.close();
  expect(() => withUsageRename(file, "old", "new", () => coordinateAccountWrite(file, before, after, () => { throw new Error("disk full"); }))).toThrow("disk full");
  expect(UsageStore.read(usage).accounts[0]?.alias).toBe("old"); expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(before);
});
it.each([[before], [after]])("recovers a crash between alias journal and credential publication (%j)", records => {
  const { usage, store } = fixture(); const key = store.snapshot().accounts[0]!.key;
  writeFileSync(join(usage, "account-transition.json"), JSON.stringify({ version: 1, before, after, rename: { oldId: "old", newId: "new" } }));
  store.rename("openai_subscription", "old", "new");
  recoverAccountTransition(store, usage, records);
  expect(store.snapshot().accounts).toEqual([{ key, provider: "openai_subscription", alias: records[0]!.id }]); expect(existsSync(join(usage, "account-transition.json"))).toBe(false);
});
it("retirement and same-name readd creates a new key even with a live writer", () => {
  const { file, usage, store } = fixture(); const key = store.snapshot().accounts[0]!.key; const unregister = registerUsageWriter(usage, store); closers.push(unregister);
  coordinateAccountWrite(file, before, [], () => writeFileSync(file, "[]"));
  coordinateAccountWrite(file, [], before, () => writeFileSync(file, JSON.stringify(before)));
  expect(store.snapshot().accounts).toHaveLength(2); expect(store.snapshot().accounts.find(a => !a.retired)?.key).not.toBe(key);
});
it("refuses ambiguous recovery rather than discarding history", () => {
  const { usage, store } = fixture(); writeFileSync(join(usage, "account-transition.json"), JSON.stringify({ version: 1, before, after, rename: { oldId: "old", newId: "new" } }));
  expect(() => recoverAccountTransition(store, usage, [{ id: "other", provider: "openai_subscription" }])).toThrow(/transition/i);
  expect(existsSync(join(usage, "account-transition.json"))).toBe(true);
});

it("pending metadata publication failure never mutates credentials or aliases", () => {
  const { file, usage, store } = fixture(); const unregister = registerUsageWriter(usage, store); closers.push(unregister);
  const persist = vi.fn(); vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("pending fs failure"); });
  expect(() => withUsageRename(file, "old", "new", () => coordinateAccountWrite(file, before, after, persist))).toThrow("pending fs failure");
  expect(persist).not.toHaveBeenCalled(); expect(store.snapshot().accounts[0]?.alias).toBe("old"); expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(before);
});
// Directory fsyncs are no-ops on Windows, so the publication ordering is only observable elsewhere.
const posix = process.platform !== "win32";
it.skipIf(!posix)("syncs the accounts directory after publication and before retiring the transition", () => {
  // The rename in the journal is fsync'd, but a writer that only fsyncs the temp file leaves the
  // accounts.json rename volatile. Retiring the sidecar before the directory is durable lets a
  // power loss keep the new alias while accounts.json reverts, splitting the account from its history.
  const { file, usage, store } = fixture(); store.close(); const events: string[] = []; const realOpen = vi.mocked(openSync).getMockImplementation()!; const realUnlink = vi.mocked(unlinkSync).getMockImplementation()!;
  vi.mocked(openSync).mockImplementation(((path: Parameters<typeof openSync>[0], flags?: Parameters<typeof openSync>[1], mode?: Parameters<typeof openSync>[2]) => { if (path === dirname(file) && flags === "r") events.push("sync-accounts-dir"); return realOpen(path, flags, mode); }) as typeof openSync);
  vi.mocked(unlinkSync).mockImplementation(path => { if (String(path).endsWith("account-transition.json")) events.push("clear-transition"); return realUnlink(path); });
  withUsageRename(file, "old", "new", () => coordinateAccountWrite(file, before, after, () => { writeFileSync(file, JSON.stringify(after)); events.push("publish"); }));
  expect(events).toEqual(["publish", "sync-accounts-dir", "clear-transition"]); expect(UsageStore.read(usage).accounts[0]?.alias).toBe("new"); expect(existsSync(join(usage, "account-transition.json"))).toBe(false);
});
it.skipIf(!posix)("rolls back when the accounts directory sync fails after publication", () => {
  const { file, usage, store } = fixture(); store.close(); let published = false; const realOpen = vi.mocked(openSync).getMockImplementation()!;
  vi.mocked(openSync).mockImplementation(((path: Parameters<typeof openSync>[0], flags?: Parameters<typeof openSync>[1], mode?: Parameters<typeof openSync>[2]) => {
    if (published && path === dirname(file) && flags === "r") { published = false; throw new Error("directory sync failure"); }
    return realOpen(path, flags, mode);
  }) as typeof openSync);
  expect(() => withUsageRename(file, "old", "new", () => coordinateAccountWrite(file, before, after, () => { writeFileSync(file, JSON.stringify(after)); published = true; }))).toThrow("directory sync failure");
  expect(UsageStore.read(usage).accounts[0]?.alias).toBe("old"); expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(before); expect(existsSync(join(usage, "account-transition.json"))).toBe(false);
});
it("rolls back a credential writer that throws after it published", () => {
  const { file, usage, store } = fixture(); store.close();
  expect(() => withUsageRename(file, "old", "new", () => coordinateAccountWrite(file, before, after, () => { writeFileSync(file, JSON.stringify(after)); throw new Error("post-publish sync failure"); }))).toThrow("post-publish sync failure");
  expect(UsageStore.read(usage).accounts[0]?.alias).toBe("old"); expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(before);
});
it("retains owner-only credential-free pending deletion if usage retirement fails after credential commit", () => {
  const { file, usage, store } = fixture(); const fail = vi.fn(); closers.push(registerUsageWriter(usage, store, fail));
  const secretRecords = before.map(a => ({ ...a, accessToken: "private-access", refreshToken: "private-refresh", profile: { email: "private@example.test" } }));
  vi.spyOn(store, "retire").mockImplementationOnce(() => { throw new Error("journal write failed"); });
  coordinateAccountWrite(file, secretRecords, [], () => writeFileSync(file, "[]"));
  expect(fail).toHaveBeenCalledOnce(); expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  const pending = join(usage, "account-transition.json"); const text = readFileSync(pending, "utf8"); expect(text).not.toMatch(/private|Token|profile|email/);
  if (process.platform !== "win32") expect(statSync(pending).mode & 0o777).toBe(0o600);
  recoverAccountTransition(store, usage, []); expect(store.snapshot().accounts[0]?.retired).toBe(true); expect(existsSync(pending)).toBe(false);
});
it("refuses offline mutation while a live unregistered writer owns history", () => {
  const { file } = fixture(); const persist = vi.fn();
  expect(() => withUsageRename(file, "old", "new", () => coordinateAccountWrite(file, before, after, persist))).toThrow(); expect(persist).not.toHaveBeenCalled();
});
it("startup recovers pending rename before reconciling aliases without inventing a new identity", async () => {
  const { startUsageRuntime } = await import("../usage/runtime.js");
  const { usage, store } = fixture(); const key = store.snapshot().accounts[0]!.key; store.setSubscription("old", 20, "2026-01-01");
  writeFileSync(join(usage, "account-transition.json"), JSON.stringify({ version: 1, before, after, rename: { oldId: "old", newId: "new" } })); store.close();
  const runtime = startUsageRuntime(usage, after); closers.push(() => runtime.close());
  expect(runtime.snapshot().accounts).toEqual([{ key, provider: "openai_subscription", alias: "new" }]); expect(runtime.snapshot().subscriptions[0]?.accountKey).toBe(key);
});

it("initializes the first account beside preconfigured usage pricing", async () => {
  const { mkdirSync } = await import("node:fs"); const dir = mkdtempSync(join(tmpdir(), "usage-initial-account-")); dirs.push(dir);
  const file = join(dir, "accounts.json"), usage = usageDirectoryForAccounts(file); mkdirSync(usage); const pricing = '{"version":1,"models":[]}'; writeFileSync(join(usage, "pricing.json"), pricing);
  coordinateAccountWrite(file, [], after, () => writeFileSync(file, JSON.stringify(after)));
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(after); expect(UsageStore.read(usage).accounts[0]?.alias).toBe("new");
  expect(readFileSync(join(usage, "pricing.json"), "utf8")).toBe(pricing); expect(existsSync(join(usage, "account-transition.json"))).toBe(false);
});
it.each([false, true])("restores an originally missing accounts file on initialization failure (published=%s)", async published => {
  const { mkdirSync } = await import("node:fs"); const dir = mkdtempSync(join(tmpdir(), "usage-initial-rollback-")); dirs.push(dir);
  const file = join(dir, "accounts.json"), usage = usageDirectoryForAccounts(file); mkdirSync(usage);
  expect(() => coordinateAccountWrite(file, [], after, () => {
    const pending = JSON.parse(readFileSync(join(usage, "account-transition.json"), "utf8")); expect(pending.previousFileExisted).toBe(false);
    if (published) writeFileSync(file, JSON.stringify(after)); throw new Error("initial credential write failed");
  })).toThrow("initial credential write failed");
  expect(existsSync(file)).toBe(false); expect(existsSync(join(usage, "account-transition.json"))).toBe(false); expect(UsageStore.read(usage).accounts).toEqual([]);
});
