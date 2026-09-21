import express from "express";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { startUsageRuntime } from "../usage/runtime.js";
import { createUsageRouter } from "../usage/http.js";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
async function fixture(unavailable = false) {
  const dir = mkdtempSync(join(tmpdir(), "usage-http-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  if (unavailable) writeFileSync(join(dir, "blocked"), "x");
  const runtime = startUsageRuntime(unavailable ? join(dir, "blocked") : dir, [{ id: "work", provider: "openai_subscription" }]); cleanup.push(() => runtime.close());
  const app = express();
  app.use("/cc-router/usage", (req, res, next) => { if (req.headers.authorization !== "Bearer secret") { res.sendStatus(401); return; } next(); }, createUsageRouter(runtime));
  const server: Server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); }); cleanup.push(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/cc-router/usage`;
  return { runtime, request: (path = "", body?: unknown, auth = true) => fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { ...(auth ? { authorization: "Bearer secret" } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) };
}
it("requires bearer auth; returns bounded no-store UTC report and empty provider selection", async () => {
  const { request } = await fixture(); expect((await request("", undefined, false)).status).toBe(401);
  const response = await request("?period=month&date=2026-02-01&provider=none"); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json(); expect(body.buckets).toHaveLength(28); expect(body.days).toHaveLength(365); expect(body.accounts).toEqual([]);
  expect(JSON.stringify(body)).not.toMatch(/accessToken|refreshToken|profile|email/);
});
it("rejects invalid dates, periods, providers, nested and duplicate parameters", async () => {
  const { request } = await fixture();
  for (const query of ["period=bad", "date=2026-02-30", "provider=bad", "provider=none&provider=openai_subscription", "date[]=2026-01-01", "period=day&period=year"]) expect((await request(`?${query}`)).status, query).toBe(400);
});
it("lists, sets and ends subscriptions with interval conflicts", async () => {
  const { request } = await fixture(); expect((await request("/subscriptions")).status).toBe(200);
  expect((await request("/subscriptions", { account: "work", monthlyUsd: 20, from: "2026-09-01" })).status).toBe(200);
  expect((await request("/subscriptions", { account: "work", monthlyUsd: 30, from: "2026-08-02" })).status).toBe(409);
  expect((await request("/subscriptions/end", { account: "work", on: "2026-10-01" })).status).toBe(200);
  expect((await request("/subscriptions", { account: "work", monthlyUsd: -1, from: "2026-09-01" })).status).toBe(400);
  const body = await (await request("/subscriptions")).json(); expect(body.subscriptions).toHaveLength(1);
});
it("storage unavailable returns 503, unknown routes 404 instead of proxying upstream", async () => {
  const { request } = await fixture(true); expect((await request()).status).toBe(503); expect((await request("/subscriptions")).status).toBe(503); expect((await request("/old-path")).status).toBe(404);
});
