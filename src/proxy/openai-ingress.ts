import type { Response } from "express";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";
import { applyCodexRateLimits, type OpenAIAccount } from "../providers/openai/account-state.js";
import { headersToRecord, parseCodexRateLimits } from "../providers/openai/usage.js";
import { applyCodexFailureRouting } from "../providers/openai/failure-routing.js";
import { needsOpenAIRefresh } from "../providers/openai/token-refresher.js";
import type { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { stats, createLocalRoutingErrorLog } from "./stats.js";
import type { LogEntry } from "./stats.js";
import { logError } from "./logger.js";
import { EmptyPoolError, NoEligibleAccountError } from "./account-pool.js";
import type { SessionRouter, RoutedAccountLease } from "./session-router.js";
import { acquireRequestRoute, routeReasonDetails, routeFailureDetails } from "./lease-lifecycle.js";

export type ForwardOpenAI = typeof forwardOpenAICodexResponse;

/**
 * Response headers that must never be mirrored to the local client when
 * relaying an upstream response verbatim:
 *  - hop-by-hop headers (content-length, transfer-encoding, connection,
 *    keep-alive) are meaningless (or actively wrong) once re-framed by our
 *    own HTTP server.
 *  - content-encoding is dropped because undici's fetch() already
 *    transparently decompresses the body while leaving this header intact —
 *    forwarding it would tell the client to gunzip bytes that are no longer
 *    compressed.
 *  - set-cookie must never leak the upstream service's session cookies to a
 *    local client.
 */
export const EXCLUDED_UPSTREAM_RELAY_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "content-encoding",
  "set-cookie",
]);

/** Route-specific error envelope shape (OpenAI Responses vs. Anthropic Messages). */
export interface OpenAIIngressEnvelope {
  /** Wrap an `{type, message}` pair in this route's top-level error shape. */
  wrap(type: string, message: string): unknown;
  /** Send the route-shaped local rejection for a routing-level failure. */
  sendNoEligible(error: NoEligibleAccountError, res: Response, nowMs: number): void;
}

/** Result of relaying the upstream response to the client. */
export interface OpenAIIngressRelayResult {
  /** The status code actually sent to the client — may differ from the raw
   * upstream HTTP status when the relay synthesizes a failure (e.g. a
   * non-streaming collector that turns an upstream `response.failed` SSE
   * event, arriving on a 200, into a local 502). */
  statusCode: number;
}

export interface OpenAIIngressOptions {
  res: Response;
  sessionKey: unknown;
  requestedModel: string;
  path: string;
  openAIRouter: SessionRouter<OpenAIAccount>;
  openAIPool: OpenAITokenPool;
  prepareOpenAIAccount: (account: OpenAIAccount) => Promise<boolean>;
  forwardOpenAI: ForwardOpenAI;
  forwardBody: OpenAIResponsesRequest;
  recordActivity: (entry: LogEntry) => void;
  now: () => number;
  envelope: OpenAIIngressEnvelope;
  /** Route-specific relay: byte-transparent SSE mirror for /v1/responses,
   * Anthropic-shape translation for /v1/messages. Must report the
   * client-facing status, even when it differs from `upstream.status`. */
  relay: (upstream: globalThis.Response, res: Response, entry: LogEntry) => Promise<OpenAIIngressRelayResult>;
  /** Invoked (best-effort, fire-and-forget from the caller's perspective)
   * when a relayed upstream response carries a 401 — lets the caller kick
   * off a background subscription-token refresh outside the request path. */
  onUpstreamAuthFailure?: (account: OpenAIAccount) => void;
}

/**
 * Shared OpenAI/Codex ingress lifecycle: acquire a sticky account lease,
 * refresh its token if needed, forward the request, classify the upstream
 * failure for cooldown/eligibility purposes, relay the response to the
 * client, then record activity/stats keyed on what the client actually
 * received. Every awaited step is guarded so a rejection here can only ever
 * produce a local error response — it must never crash the daemon or leave
 * an unhandled rejection behind.
 */
export async function runOpenAIIngress(opts: OpenAIIngressOptions): Promise<void> {
  const {
    res, sessionKey, requestedModel, path, openAIRouter, openAIPool,
    prepareOpenAIAccount, forwardOpenAI, forwardBody, recordActivity, now,
    envelope, relay, onUpstreamAuthFailure,
  } = opts;

  let selected: { route: RoutedAccountLease<OpenAIAccount>; release: () => void; details: string };
  try {
    selected = acquireRequestRoute(sessionKey, res, openAIRouter, { requestedModel });
  } catch (error) {
    if (error instanceof EmptyPoolError) {
      res.status(503).json(envelope.wrap("no_accounts", "No OpenAI subscription accounts are configured"));
      return;
    }
    if (error instanceof NoEligibleAccountError) {
      recordActivity(createLocalRoutingErrorLog(error.reason, requestedModel));
      envelope.sendNoEligible(error, res, now());
      return;
    }
    // Never let an unexpected routing failure crash the daemon or reject
    // this handler's promise — no account lease was taken, so there is
    // nothing to release.
    const message = error instanceof Error ? error.message : String(error);
    logError("proxy", 500, `unexpected routing failure: ${message}`);
    recordActivity({
      ts: now(),
      accountId: "proxy",
      model: requestedModel,
      type: "error",
      statusCode: 500,
      path,
      details: "proxy_error:acquire",
    });
    res.status(500).json(envelope.wrap("proxy_error", "Unexpected routing error"));
    return;
  }

  const account = selected.route.account;
  const startedAt = now();
  const needed = needsOpenAIRefresh(account);
  let ready: boolean;
  try {
    ready = await prepareOpenAIAccount(account);
  } catch (error) {
    // A throwing refresh must behave exactly like a `false` return, never
    // crash the request (or the daemon).
    const message = error instanceof Error ? error.message : String(error);
    logError(account.id, 401, `openai token refresh threw: ${message}`);
    ready = false;
  }
  if (!ready) {
    selected.release();
    account.errorCount++;
    // Intentionally does not touch `account.healthy`: a single failed
    // refresh fails only this request. Disabling the account here would
    // hard-block it from every future request until a manual recovery, even
    // though the very next request naturally retries the refresh.
    recordActivity({
      ts: now(),
      accountId: account.id,
      model: requestedModel,
      type: "error",
      statusCode: 401,
      path,
      details: "openai token refresh failed",
    });
    res.status(401).json(envelope.wrap("authentication_error", "OpenAI subscription token refresh failed"));
    return;
  }
  account.healthy = true;
  if (needed) account.lastRefresh = now();

  let upstream: globalThis.Response;
  try {
    upstream = await forwardOpenAI({ account, body: forwardBody, stream: forwardBody.stream === true });
  } catch (error) {
    // A rejected forward call (network failure) must produce a local 502,
    // never an unhandled rejection. The lease releases via the response's
    // own finish/close lifecycle once this response is sent.
    account.errorCount++;
    stats.totalErrors++;
    const message = error instanceof Error ? error.message : String(error);
    logError(account.id, 502, `openai request failed: ${message}`);
    recordActivity({
      ts: startedAt,
      accountId: account.id,
      model: requestedModel,
      type: "error",
      statusCode: 502,
      path,
      details: "upstream_error:network",
      durationMs: now() - startedAt,
    });
    res.status(502).json(envelope.wrap("upstream_error", `OpenAI request failed: ${message}`));
    return;
  }

  // Cooldown/eligibility react to the raw upstream signal — this must not
  // change based on how the relay later renders the response to the client.
  const upstreamFailed = upstream.status === 401 || upstream.status === 429 || upstream.status >= 500;
  let details = routeReasonDetails(selected.route);
  try {
    // Header/rate-limit parsing and cooldown bookkeeping run on live upstream
    // data between the two request-level try/catches above — a throw here
    // (e.g. an unreadable header) must degrade to "skip this bookkeeping",
    // never crash the daemon or leave the relay below un-reached.
    const headerRecord = headersToRecord(upstream.headers);
    applyCodexRateLimits(account, parseCodexRateLimits(headerRecord, now()), now());

    if (upstreamFailed) {
      account.errorCount++;
      account.consecutiveErrors++;
      const applied = applyCodexFailureRouting(
        upstream.status,
        headerRecord,
        selected.route,
        requestedModel,
        openAIRouter,
        openAIPool,
        now,
      );
      details = routeFailureDetails(
        selected.route,
        upstream.status === 401 ? "token-invalid" : upstream.status === 429 ? "rate-limited" : "service-overloaded",
        applied.limitingScope,
      );
      if (upstream.status === 401) onUpstreamAuthFailure?.(account);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(account.id, upstream.status, `openai response classification failed: ${message}`);
  }

  const entry: LogEntry = {
    ts: startedAt,
    accountId: account.id,
    model: requestedModel,
    type: "route",
    path,
    details,
  };

  let finalStatus = upstream.status;
  let relayFailed = false;
  try {
    const result = await relay(upstream, res, entry);
    finalStatus = result.statusCode;
  } catch (error) {
    // Never let a relay failure become an unhandled rejection. Only send a
    // local response if no upstream bytes have reached the client yet —
    // otherwise the client already has a partial response and the best we
    // can do is tear the connection down.
    relayFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    logError(account.id, 502, `openai response relay failed: ${message}`);
    if (!res.headersSent) {
      finalStatus = 502;
      res.status(502).json(envelope.wrap("upstream_error", `OpenAI response relay failed: ${message}`));
    } else {
      if (!res.writableEnded && !res.destroyed) res.destroy();
    }
  }

  // Activity/stats must reflect what the client actually received, not just
  // the raw upstream signal: the non-streaming collector can synthesize a
  // local 502 from an upstream 200 whose SSE stream ended in
  // `response.failed` (or malformed/incomplete), and a relay failure is
  // always a client-facing failure regardless of the upstream status.
  const failedFinal = upstreamFailed || relayFailed || finalStatus >= 400;
  if (failedFinal) {
    stats.totalErrors++;
  } else {
    account.consecutiveErrors = 0;
    stats.totalRequests++;
  }
  entry.type = failedFinal ? "error" : "route";
  entry.statusCode = finalStatus;
  entry.durationMs = now() - startedAt;
  recordActivity(entry);
}
