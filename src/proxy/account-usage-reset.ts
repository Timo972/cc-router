import type { RequestHandler } from "express";
import type { CodexRateLimitsUpdate } from "../providers/openai/usage.js";
import { ResetNotSubmittedError, RESET_OUTCOME_UNKNOWN } from "./reset-errors.js";

export interface UsageResetOptions<A extends object, R extends { code: string }> {
  provider: "openai" | "anthropic";
  findAccount(id: string): A | undefined;
  prepare(account: A): Promise<boolean>;
  /** `retry`: the client already sent this id without learning the outcome. `offer`: the terms it confirmed. */
  consume(account: A, requestId: string, attempt: { retry: boolean; offer?: unknown }): Promise<R>;
  refresh(account: A): Promise<{ ok: boolean }>;
  /** Replay status from the provider's own id binding, when it outlives the account object. */
  isReplay?(account: A, requestId: string): boolean;
  /** OpenAI only: reconcile quota cooldowns from the evidence captured before the spend. */
  captureReset?(account: A): (update: CodexRateLimitsUpdate) => void;
}
export function createUsageResetHandler<A extends object, R extends { code: string }>(options: UsageResetOptions<A, R>): RequestHandler {
  const inFlight = new WeakSet<A>();
  // One retained snapshot per account allows an uncertain retry to reconcile
  // using the ORIGINAL quota evidence, not quota learned after the first spend.
  const snapshots = new WeakMap<A, { id: string; reconcile?: (update: CodexRateLimitsUpdate) => void }>();
  return async (req, res) => {
    const id = req.params.id;
    const requestId: unknown = req.body?.redeemRequestId;
    if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
      res.status(400).json({ error: "redeemRequestId must be a UUID" });
      return;
    }
    const account = options.findAccount(id);
    if (!account) {
      res.status(404).json({ error: "Account not found" });
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
        res.status(404).json({ error: "Account changed; reset not submitted" });
        return;
      }
      const previous = snapshots.get(account);
      const sameSnapshot = previous?.id === requestId;
      // Read before consume: consuming is what records the id as sent.
      const replay = options.isReplay ? options.isReplay(account, requestId) : sameSnapshot;
      const snapshot = sameSnapshot ? previous : { id: requestId, reconcile: options.captureReset?.(account) };
      snapshots.set(account, snapshot);
      const result = await options.consume(account, requestId, { retry: req.body?.retry === true, offer: req.body?.offer });
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
            snapshot.reconcile?.((usage as { ok: true; update: CodexRateLimitsUpdate }).update);
          }
        } catch { /* retain confirmed redemption */ }
      }
      res.json({ reset: { provider: options.provider, ...result, usageRefreshed, replay } });
    } catch (error) {
      if (error instanceof ResetNotSubmittedError) {
        res.status(error.status).json({ error: error.message, ...(error.abandon ? { abandon: true } : {}) });
        return;
      }
      res.status(502).json({ error: RESET_OUTCOME_UNKNOWN });
    } finally {
      inFlight.delete(account);
    }
  };
}
