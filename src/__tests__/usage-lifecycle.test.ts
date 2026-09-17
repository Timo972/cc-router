vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UsageStore } from "../usage/store.js";
import { coordinateAccountWrite, recoverAccountTransition, registerUsageWriter, usageDirectoryForAccounts, withUsageRename } from "../usage/account-lifecycle.js";
const dirs: string[] = []; const closers: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); closers.splice(0).reverse().forEach(f => f()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
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
