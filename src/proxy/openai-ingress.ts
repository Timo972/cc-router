import type { Response } from "express";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";
import { applyCodexRateLimits, type OpenAIAccount } from "../providers/openai/account-state.js";
import { headersToRecord, parseCodexRateLimits } from "../providers/openai/usage.js";
import { applyCodexFailureRouting } from "../providers/openai/failure-routing.js";
import { needsOpenAIRefresh } from "../providers/openai/token-refresher.js";
import type { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { stats, boundModelId, createLocalRoutingErrorLog } from "./stats.js";
import type { LogEntry } from "./stats.js";
import { logError } from "./logger.js";
import { EmptyPoolError, NoEligibleAccountError } from "./account-pool.js";
import type { SessionRouter, RoutedAccountLease } from "./session-router.js";
import { acquireRequestRoute, routeReasonDetails, routeFailureDetails } from "./lease-lifecycle.js";

/**
 * Mirrors `anthropic-routing.ts`'s `requestTerminated` check. This ingress
 * path never threads the raw `Request` through (only `Response`), so it
 * checks just the response side: `res.destroyed`/`res.writableEnded` are
 * enough to detect a client that disconnected while we were off awaiting a
 * token refresh.
 */
function responseTerminated(res: Response): boolean {
  return res.destroyed || res.writableEnded;
}

export type ForwardOpenAI = typeof forwardOpenAICodexResponse;

/**
 * Cooldown applied when a *local* token refresh fails. Matches the upstream-401
 * cooldown in `failure-routing.ts`: a refresh that cannot produce a usable token
 * is an auth failure, and without a cooldown the pool would immediately hand the
 * same account back to the next request.
 */
const REFRESH_FAILURE_COOLDOWN_MS = 30_000;

/**
 * Response headers that must never be mirrored to the local client when
 * relaying an upstream response verbatim:
 *  - hop-by-hop headers per RFC 7230 §6.1 (content-length, transfer-encoding,
 *    connection, keep-alive, te, trailer, upgrade, proxy-authenticate,
 *    proxy-authorization) are meaningless (or actively wrong/dangerous) once
 *    re-framed by our own HTTP server — e.g. `upgrade` would claim a protocol
 *    switch never negotiated with this client, and the two `proxy-*` headers
 *    are scoped to the upstream hop's own (unrelated) proxy auth.
 *  - content-encoding is dropped because undici's fetch() already
 *    transparently decompresses the body while leaving this header intact —
 *    forwarding it would tell the client to gunzip bytes that are no longer
 *    compressed. Deliberate drop, not RFC hop-by-hop.
 *  - set-cookie must never leak the upstream service's session cookies to a
 *    local client. Deliberate drop, not RFC hop-by-hop.
 */
export const EXCLUDED_UPSTREAM_RELAY_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "content-encoding",
  "set-cookie",
]);

/**
 * The `Connection` header can nominate additional header names as hop-by-hop
 * for this specific response (RFC 7230 §6.1), beyond the fixed set above —
 * e.g. `Connection: close, X-Internal-Token` means `X-Internal-Token` is also
 * hop-by-hop here and must not reach the client.
 */
function connectionNominatedHeaders(source: Headers): Set<string> {
  const nominated = new Set<string>();
  const connection = source.get("connection");
  if (!connection) return nominated;
  for (const token of connection.split(",")) {
    const name = token.trim().toLowerCase();
    if (name) nominated.add(name);
  }
  return nominated;
}

/**
 * Single place that decides which upstream response headers are safe to
 * mirror to the local client, so every relay site shares the same policy
 * instead of re-implementing the exclusion set (and the dynamic `Connection`
 * nomination) inline. `apply` is called once per header that passes the
 * filter, in `source`'s own iteration order — callers still own their own
 * per-header special cases (e.g. content-type) by skipping in `apply`.
 */
export function mirrorUpstreamHeaders(source: Headers, apply: (name: string, value: string) => void): void {
  const nominated = connectionNominatedHeaders(source);
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (EXCLUDED_UPSTREAM_RELAY_HEADERS.has(lower)) return;
    if (nominated.has(lower)) return;
    apply(key, value);
  });
}

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
    res, sessionKey, path, openAIRouter, openAIPool,
    prepareOpenAIAccount, forwardOpenAI, forwardBody, recordActivity, now,
    envelope, relay, onUpstreamAuthFailure,
  } = opts;
  // The model comes from a client-controlled body and is retained in the
  // activity ring buffer below. Bound it once, here, so every activity entry,
  // routing context and bucket lookup on this path carries an identifier that
  // cannot grow with the request. The body forwarded upstream is untouched —
  // it still carries whatever model the caller asked for.
  const requestedModel = boundModelId(opts.requestedModel);

  // A client that hangs up must take the upstream request with it. Releasing
  // the lease (which the response's own close listener does) only returns the
  // account's *local* capacity — without this the Codex request keeps
  // streaming to a socket nobody is reading, so the pool counts the account
  // idle and routes more work onto an upstream slot that is still occupied.
  //
  // Registered before the lease is acquired so this listener runs before the
  // lifecycle's release, and `once` so it cleans itself up. A normal end also
  // emits `close`, hence the `writableEnded` guard: only a premature close is
  // a disconnect.
  const clientGone = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) clientGone.abort();
  });

  let selected: { route: RoutedAccountLease<OpenAIAccount>; release: () => void; details: string };
  try {
    selected = acquireRequestRoute(sessionKey, res, openAIRouter, { requestedModel });
  } catch (error) {
    if (error instanceof EmptyPoolError) {
      stats.totalErrors++;
      res.status(503).json(envelope.wrap("no_accounts", "No OpenAI subscription accounts are configured"));
      return;
    }
    if (error instanceof NoEligibleAccountError) {
      // Local rejections are client-facing failures and must show up in the
      // shared error total, exactly as the Anthropic routing middleware counts
      // its own no-eligible-account rejections.
      stats.totalErrors++;
      recordActivity(createLocalRoutingErrorLog(error.reason, requestedModel));
      envelope.sendNoEligible(error, res, now());
      return;
    }
    // Never let an unexpected routing failure crash the daemon or reject
    // this handler's promise — no account lease was taken, so there is
    // nothing to release.
    stats.totalErrors++;
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
    stats.totalErrors++;
    // Intentionally does not touch `account.healthy`: a single failed
    // refresh fails only this request. Disabling the account here would
    // hard-block it from every future request until a manual recovery, even
    // though the very next request naturally retries the refresh.
    //
    // It must, however, break session affinity and cool the account down.
    // A sticky binding survives this failure, so without both the session
    // would re-acquire the same broken account on every retry and never fail
    // over — 401ing forever while healthy accounts sit idle.
    if (selected.route.sessionId !== undefined && selected.route.bindingGeneration !== undefined) {
      openAIRouter.invalidate(selected.route.sessionId, account.id, selected.route.bindingGeneration);
    }
    openAIPool.setGlobalCooldownForAccount(account, REFRESH_FAILURE_COOLDOWN_MS);
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
  if (responseTerminated(res)) {
    // The client disconnected while the token refresh was in flight. Forwarding
    // now would burn an upstream request nobody can receive the response to.
    // Just release the lease and stop — no response to send, and it is safe to
    // release again even if the response's own close/finish listener already
    // did so (`attachLeaseLifecycle`'s release() is idempotent).
    selected.release();
    return;
  }
  account.healthy = true;
  if (needed) account.lastRefresh = now();

  let upstream: globalThis.Response;
  try {
    upstream = await forwardOpenAI({
      account,
      body: forwardBody,
      stream: forwardBody.stream === true,
      signal: clientGone.signal,
    });
  } catch (error) {
    // A client that hung up mid-forward rejects this call through the abort
    // above. That is a cancellation, not an upstream failure: the account did
    // nothing wrong, so counting it would push a healthy account toward the
    // unhealthy threshold and a cooldown for nothing more than a user pressing
    // Ctrl-C, and there is no client left to receive a 502 or to whom an
    // "upstream_error:network" entry would mean anything. Mirrors the
    // pre-forward disconnect branch above, which also just releases and stops.
    if (clientGone.signal.aborted || responseTerminated(res)) {
      selected.release();
      return;
    }
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
  // Tracks whether `account.errorCount`/`consecutiveErrors` were already
  // incremented for this request by the upstream-classification branch below,
  // so a relay-synthesized failure (e.g. a byte-transparent stream that
  // observed an upstream `response.failed`/`error` event on an otherwise-200
  // response) can still increment them once further down without double
  // counting an upstream 401/429/5xx that already did.
  let accountFailureCounted = false;
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
      accountFailureCounted = true;
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
        upstream.status === 401 ? "token-invalid"
          : upstream.status === 429 ? "rate-limited"
          // Only 503/529 are treated as upstream overload for cooldown
          // purposes; labelling an isolated 500/502/504 "service-overloaded"
          // would contradict the routing decision actually taken.
          : upstream.status === 503 || upstream.status === 529 ? "service-overloaded"
          : "upstream-error",
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
    // The recorded status is what this request *became*, which is a failure
    // whether or not another HTTP response can still be sent. Leaving it at
    // the upstream's 200 in the headers-already-sent case produced an
    // activity entry typed "error" carrying statusCode 200 — a diagnostic
    // that contradicts itself, and one that reads as a success in any view
    // that keys off the status.
    finalStatus = 502;
    if (!res.headersSent) {
      res.status(502).json(envelope.wrap("upstream_error", `OpenAI response relay failed: ${message}`));
    } else {
      if (!res.writableEnded && !res.destroyed) res.destroy();
    }
  }

  // A client that hung up during the relay produces every symptom of a
  // failure without there being one: the aborted body rejects the reader (so
  // `relayFailed`), and a stream cut short never reaches its terminal event
  // (so the observer synthesizes a 502). Neither is the account's doing, and
  // charging them would let routine Ctrl-C walk a healthy account to the
  // unhealthy threshold. Only the abort signal can say this — `res` reads as
  // "terminated" after every normal response too.
  //
  // Upstream's own verdict still stands: a 429 is a 429 whether or not the
  // client stayed to read it.
  const clientCancelled = clientGone.signal.aborted;

  // Activity/stats must reflect what the client actually received, not just
  // the raw upstream signal: the non-streaming collector can synthesize a
  // local 502 from an upstream 200 whose SSE stream ended in
  // `response.failed` (or malformed/incomplete), and a relay failure is
  // always a client-facing failure regardless of the upstream status.
  const failedFinal = upstreamFailed || (!clientCancelled && (relayFailed || finalStatus >= 400));
  if (clientCancelled && !upstreamFailed) {
    // Record what the client had actually received when it left, not the 502
    // its own disconnect manufactured.
    finalStatus = upstream.status;
    entry.details = details ? `${details} client-cancelled` : "client-cancelled";
  }
  if (failedFinal) {
    stats.totalErrors++;
    // Upstream classification above only counts 401/429/5xx against the
    // account. A relay-synthesized failure on an otherwise-successful
    // upstream status (e.g. a streamed `response.failed` event, or a relay
    // exception after upstream returned 200) is just as real a failure for
    // this account and must not be dropped on the floor.
    if (!accountFailureCounted) {
      account.errorCount++;
      account.consecutiveErrors++;
    }
  } else {
    account.consecutiveErrors = 0;
    stats.totalRequests++;
  }
  entry.type = failedFinal ? "error" : "route";
  entry.statusCode = finalStatus;
  entry.durationMs = now() - startedAt;
  recordActivity(entry);
}
