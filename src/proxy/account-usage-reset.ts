import type { CodexUsageFetchResult } from "../providers/openai/usage-fetch.js";
import type { CodexRateLimitsUpdate } from "../providers/openai/usage.js";
import type { RequestHandler } from "express";
import type { OpenAIAccount } from "../providers/openai/account-state.js";
import type { CodexResetResult } from "../providers/openai/usage-reset.js";

interface UsageResetOptions {
  findAccount(id: string): OpenAIAccount | undefined;
  prepare(account: OpenAIAccount): Promise<boolean>;
  consume(account: OpenAIAccount, requestId: string): Promise<CodexResetResult>;
  refresh(account: OpenAIAccount): Promise<CodexUsageFetchResult>;
  captureReset?(account: OpenAIAccount): (update: CodexRateLimitsUpdate) => void;
}
export function createUsageResetHandler(options: UsageResetOptions): RequestHandler {
  const inFlight = new WeakSet<OpenAIAccount>();
  // One retained snapshot per account allows an uncertain retry to reconcile
  // using the ORIGINAL quota evidence, not quota learned after the first spend.
  const snapshots = new WeakMap<OpenAIAccount, { id: string; reconcile?: (update: CodexRateLimitsUpdate) => void }>();
  return async (req, res) => {
    const id = req.params.id;
    const requestId: unknown = req.body?.redeemRequestId;
    if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
      res.status(400).json({ error: "redeemRequestId must be a UUID" });
      return;
    }
    const account = options.findAccount(id);
    if (!account) {
      res.status(404).json({ error: "ChatGPT account not found" });
      return;
    }
    if (inFlight.has(account)) {
      res.status(409).json({ error: "Reset already running for this account" });
      return;
    }
    inFlight.add(account);
    try {
      if (!await options.prepare(account)) {
        res.status(503).json({ error: "Account credentials unavailable; reset not submitted" });
        return;
      }
      if (options.findAccount(id) !== account) {
        res.status(404).json({ error: "ChatGPT account changed; reset not submitted" });
        return;
      }
      const previous = snapshots.get(account);
      const replay = previous?.id === requestId;
      const snapshot = replay ? previous : { id: requestId, reconcile: options.captureReset?.(account) };
      snapshots.set(account, snapshot);
      const result = await options.consume(account, requestId);
      if (result.code === "already_redeemed" && !replay) {
        // This UUID predates our ownership. Repeated historical replays must
        // never promote its newly captured quota snapshot into trusted evidence.
        snapshot.reconcile = undefined;
      }
      // Refresh even for no_credit/nothing_to_reset: the displayed snapshot may
      // be stale. Never fabricate windows or decrement credits locally.
      let usageRefreshed = false;
      if (options.findAccount(id) === account) {
        try {
          const usage = await options.refresh(account);
          usageRefreshed = usage.ok;
          if (usage.ok && (result.code === "reset" || (result.code === "already_redeemed" && replay))) {
            snapshot.reconcile?.(usage.update);
          }
        } catch { /* retain confirmed redemption */ }
      }
      res.json({ reset: { ...result, usageRefreshed } });
    } catch {
      res.status(502).json({ error: "Reset outcome unknown; retry with the same redemption ID" });
    } finally {
      inFlight.delete(account);
    }
  };
}
