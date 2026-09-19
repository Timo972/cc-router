import express from "express";
import type { Request, Response, NextFunction } from "express";
import { UsageUnavailableError, type UsageRuntime } from "./runtime.js";
import { boundedString, finiteAmount, object, utcTimestamp, usageProvider, type UsageQuery } from "./types.js";

/** Mount only after the server's existing management bearer authentication. */
export function createUsageRouter(runtime: UsageRuntime) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.use(express.json({ limit: "8kb", strict: true }));
  const handle = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response) => {
    try { fn(req, res); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (error instanceof UsageUnavailableError || /persist|journal|writer|EACCES|ENOSPC|EIO/i.test(message)) {
        res.status(503).json({ error: "Usage history unavailable; check storage and writer ownership" });
      } else if (/overlap|already|conflict|ambiguous|no open|not found|unknown account/i.test(message)) {
        res.status(409).json({ error: "Conflicting subscription interval or account" });
      } else { res.status(400).json({ error: "Invalid usage query or subscription" }); }
    }
  };
  router.get("/", handle((req, res) => {
    const params = new URL(req.originalUrl, "http://localhost").searchParams;
    if ([...params.keys()].some(key => !["period", "date", "provider"].includes(key)) || params.getAll("period").length > 1 || params.getAll("date").length > 1 || params.getAll("provider").length > 3) throw new Error("Invalid query");
    const period = params.get("period") ?? "month";
    if (!["day", "week", "month", "year"].includes(period)) throw new Error("Invalid period");
    const date = params.get("date");
    if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !utcTimestamp(date))) throw new Error("Invalid date");
    const providers = params.getAll("provider");
    if (providers.includes("none") && providers.length !== 1) throw new Error("Invalid providers");
    const query: UsageQuery = { period: period as UsageQuery["period"], ...(date !== null ? { date } : {}),
      ...(providers.length ? { providers: providers[0] === "none" ? [] : providers.map(usageProvider) } : {}) };
    res.json(runtime.report(query));
  }));
  router.get("/subscriptions", handle((_req, res) => {
    const { accounts, subscriptions } = runtime.snapshot(); res.json({ accounts, subscriptions });
  }));
  router.post("/subscriptions", handle((req, res) => {
    const body = object(req.body, ["account", "monthlyUsd", "from"]);
    const account = boundedString(body.account, "account", 128); const amount = finiteAmount(body.monthlyUsd);
    const from = utcTimestamp(body.from); if (typeof body.from !== "string" || body.from.length !== 10) throw new Error("Invalid date");
    res.json(runtime.setSubscription(account, amount, from.slice(0, 10)));
  }));
  router.post("/subscriptions/end", handle((req, res) => {
    const body = object(req.body, ["account", "on"]); const account = boundedString(body.account, "account", 128);
    const on = utcTimestamp(body.on); if (typeof body.on !== "string" || body.on.length !== 10) throw new Error("Invalid date");
    res.json(runtime.endSubscription(account, on.slice(0, 10)));
  }));
  router.use((_req, res) => { res.status(404).json({ error: "Unknown usage endpoint" }); });
  router.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status(400).json({ error: "Invalid usage request body" }); });
  return router;
}
