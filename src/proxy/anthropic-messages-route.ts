import { request as httpRequest, type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Express, Request, RequestHandler, Response } from "express";
import {
  createAnthropicRefreshMiddleware,
  createAnthropicRoutingMiddleware,
  extractClaudeSessionId,
  type AnthropicRoutingMiddlewareOptions,
} from "./anthropic-routing.js";
import {
  acquireRequestRoute,
  applyUpstreamFailureRoutingDetailed,
  routeFailureDetails,
  routeReasonDetails,
} from "./lease-lifecycle.js";
import type { RoutedAccountLease, SessionRouter } from "./session-router.js";
import { EmptyPoolError, NoEligibleAccountError, type TokenPool } from "./token-pool.js";
import type { Account } from "./types.js";
import { applyRateLimitHeaders } from "../providers/anthropic/rate-limit-headers.js";
import { attachAnthropicResponseCapture } from "./anthropic-response-capture.js";
import { boundModelId, stats } from "./stats.js";
import type { LogEntry } from "./stats.js";
import { logError, logRoute } from "./logger.js";
import {
  MAX_UPSTREAM_ATTEMPTS,
  SAME_ACCOUNT_RETRY_DELAY_MS,
  isRetryableUpstreamStatus,
  retryDelay,
} from "./upstream-retry.js";

const OAUTH_BETA = "oauth-2025-04-20";

/**
 * CRITICAL: api.anthropic.com requires the "oauth-2025-04-20" beta flag to
 * accept OAuth tokens (sk-ant-oat01-*). Without it the request is rejected
 * with "OAuth authentication is currently not supported." APPEND — do NOT
 * replace — so existing betas (tools, computer-use, etc.) are preserved.
 */
export function withOAuthBeta(existing: unknown): string {
  const betas = existing === undefined || existing === null || existing === ""
    ? []
    : String(existing).split(",").map(beta => beta.trim()).filter(Boolean);
  if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
  return betas.join(",");
}

export interface AnthropicMessagesRouteOptions {
  /** Upstream base URL — https://api.anthropic.com or a LiteLLM endpoint. */
  target: string;
  /** Applies only until upstream response headers arrive, exactly like the
   *  generic /v1 proxy's `proxyTimeout` — a started stream is never cut. */
  timeoutMs: number;
  pool: TokenPool;
  sessionRouter: SessionRouter;
  needsRefresh(account: Account): boolean;
  /** Refresh and durably persist rotated credentials before resolving true. */
  refresh(account: Account): Promise<boolean>;
  onRefreshFailure(account: Account): void;
  onEmptyPool?: AnthropicRoutingMiddlewareOptions["onEmptyPool"];
  onNoEligibleAccount?: AnthropicRoutingMiddlewareOptions["onNoEligibleAccount"];
  /** A relayed upstream 401 means the token is stale — lets the caller kick
   *  off a background refresh so the NEXT request succeeds. */
  onUpstream401?: (account: Account) => void;
  /** After a 429's cooldown bookkeeping: lets the caller refresh usage in the
   *  background and narrow an ambiguity-owned global cooldown. */
  onRateLimited?: (route: RoutedAccountLease, ambiguousCooldownToken: number | undefined) => void;
  recordActivity?: (entry: LogEntry) => void;
  /** Upstream attempts per client request (test override; default 3). */
  maxAttempts?: number;
  /** Delay before re-sending to the SAME account (test override). */
  sameAccountRetryDelayMs?: number;
  now?: () => number;
}

/** Join a target base path with the request's original URL (path + query). */
function joinTargetPath(target: URL, originalUrl: string): string {
  const basePath = target.pathname.replace(/\/+$/, "");
  return basePath === "" ? originalUrl : `${basePath}${originalUrl}`;
}

/**
 * Build the upstream request headers from the client's. Mirrors the header
 * behavior of the agent-less http-proxy transport the generic /v1 route
 * uses (`connection: close`, `changeOrigin` host rewrite) plus this proxy's
 * own auth handling: the placeholder bearer the client sent is replaced with
 * the routed account's OAuth token, `x-api-key` is dropped because OAuth
 * authentication uses Authorization Bearer and having both set can conflict
 * at Anthropic's side, and the OAuth beta flag is appended.
 */
function buildUpstreamHeaders(
  req: Request,
  target: URL,
  account: Account,
  bodyLength: number,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ...req.headers };
  // The buffered body is re-framed with an explicit length; the client's own
  // framing headers no longer describe what is sent.
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  delete headers["x-api-key"];
  headers["connection"] = "close";
  headers["host"] = target.host;
  headers["authorization"] = `Bearer ${account.tokens.accessToken}`;
  headers["anthropic-beta"] = withOAuthBeta(req.headers["anthropic-beta"]);
  headers["content-length"] = String(bodyLength);
  return headers;
}

interface ForwardedAttempt {
  request: ClientRequest;
  response: Promise<IncomingMessage>;
}

function forwardAttempt(opts: {
  target: URL;
  path: string;
  method: string;
  headers: OutgoingHttpHeaders;
  body: Buffer;
  timeoutMs: number;
}): ForwardedAttempt {
  const secure = opts.target.protocol === "https:";
  const requestFn = secure ? httpsRequest : httpRequest;
  const upstreamRequest = requestFn({
    host: opts.target.hostname,
    port: opts.target.port !== "" ? Number(opts.target.port) : secure ? 443 : 80,
    method: opts.method,
    path: opts.path,
    headers: opts.headers,
    // Parity with the generic /v1 proxy: agent-less, one connection per
    // request, closed by the `connection: close` request header.
    agent: false,
    timeout: opts.timeoutMs,
  });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    upstreamRequest.on("response", upstream => {
      // The pre-response timeout must never cut a stream that has started.
      upstreamRequest.setTimeout(0);
      // The response may be HELD unconsumed while a retry decision resolves
      // (re-acquire, token refresh) — a socket error in that window must not
      // become an unhandled 'error' crash. The relay adds its own handler on
      // top of this guard when the response is actually sent to the client.
      upstream.on("error", () => {});
      resolve(upstream);
    });
    upstreamRequest.on("error", reject);
    upstreamRequest.on("timeout", () => {
      upstreamRequest.destroy(new Error(`Upstream request timed out after ${opts.timeoutMs}ms`));
    });
  });
  upstreamRequest.end(opts.body);
  return { request: upstreamRequest, response };
}

/**
 * Relay an upstream response to the client verbatim: status, status message,
 * every header, and the raw (still possibly compressed) body bytes. Matches
 * the observable behavior of http-proxy 1.18's outgoing passes, including
 * its HTTP/1.0 accommodations, so moving /v1/messages off the generic proxy
 * changes nothing about what a client receives.
 */
function relayUpstreamResponse(upstream: IncomingMessage, req: Request, res: Response): void {
  if (req.httpVersion === "1.0") {
    delete upstream.headers["transfer-encoding"];
    upstream.headers["connection"] = (req.headers["connection"] as string | undefined) ?? "close";
  } else if (req.httpVersion !== "2.0" && !upstream.headers["connection"]) {
    upstream.headers["connection"] = (req.headers["connection"] as string | undefined) ?? "keep-alive";
  }

  res.statusCode = upstream.statusCode ?? 502;
  if (upstream.statusMessage) res.statusMessage = upstream.statusMessage;
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (value !== undefined) res.setHeader(key, value);
  }
  // A mid-body upstream failure cannot be recovered into a valid response —
  // tear the client connection down rather than ending it cleanly, so the
  // client sees a broken transfer instead of a silently truncated body.
  upstream.once("error", () => {
    if (!res.writableEnded) res.destroy();
  });
  upstream.pipe(res);
}

/**
 * Claude-bound POST /v1/messages with router-side failover: a 429 or 5xx
 * received before any response byte is relayed retries on whichever account
 * the pool would hand a brand-new request (a different one after a 429's
 * cooldown, the same one after a plain 5xx), bounded by the shared attempt
 * budget. When nothing is eligible the failed upstream response is relayed
 * unchanged — the pass-through contract this route inherits is the fallback,
 * not the default. Streaming stays byte-transparent; the route never
 * synthesizes or transforms response bytes.
 */
export function mountAnthropicMessagesRoute(
  app: Express,
  opts: AnthropicMessagesRouteOptions,
): void {
  const target = new URL(opts.target);
  const recordActivity = opts.recordActivity ?? ((entry: LogEntry) => stats.addLog(entry));
  const now = opts.now ?? Date.now;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_UPSTREAM_ATTEMPTS);
  const sameAccountDelayMs = opts.sameAccountRetryDelayMs ?? SAME_ACCOUNT_RETRY_DELAY_MS;

  // Only requests whose raw body was buffered by the cross-provider dispatch
  // can be retried (and re-sent at all) — anything else falls through to the
  // generic /v1 proxy exactly as before this route existed.
  const requireBufferedBody: RequestHandler = (req, _res, next) => {
    if (!req._ccRawBody) {
      next("route");
      return;
    }
    next();
  };

  const handler = async (req: Request, res: Response): Promise<void> => {
    const rawBody = req._ccRawBody!;
    const context = req._ccRouteContext;
    const sessionHeader = extractClaudeSessionId(req);
    const path = joinTargetPath(target, req.originalUrl);
    let route = req._ccRoute!;
    let release = req._ccReleaseLease!;
    const source = route.sessionId !== undefined
      ? "cli" as const
      : req.headers["x-api-key"]
      ? "desktop" as const
      : "api" as const;
    const model = boundModelId(context?.requestedModel ?? "-");
    const startedAt = now();
    stats.totalRequests++;

    // A client that hangs up takes the in-flight upstream attempt (and any
    // pending retry) with it. `writableEnded` guards the normal-completion
    // close; only a premature close is a disconnect.
    const clientGone = new AbortController();
    let inFlight: ClientRequest | undefined;
    res.once("close", () => {
      if (!res.writableEnded) clientGone.abort();
    });
    clientGone.signal.addEventListener("abort", () => {
      inFlight?.destroy(new Error("client disconnected"));
    });

    // Parity with the generic proxy's incoming-socket timeout: armed until
    // the first upstream response headers arrive, then cleared for good so a
    // long-lived stream is never cut (see anthropic-proxy.ts).
    req.socket.setTimeout(opts.timeoutMs);

    for (let attempt = 1; ; attempt++) {
      const account = route.account;
      const attemptStartedAt = now();
      req._ccAccount = account;
      logRoute(
        account.id,
        account.requestCount,
        Math.round((account.tokens.expiresAt - now()) / 60_000),
      );

      const forwarded = forwardAttempt({
        target,
        path,
        method: req.method,
        headers: buildUpstreamHeaders(req, target, account, rawBody.byteLength),
        body: rawBody,
        timeoutMs: opts.timeoutMs,
      });
      inFlight = forwarded.request;

      let upstream: IncomingMessage;
      try {
        upstream = await forwarded.response;
      } catch (error) {
        release();
        // A hung-up client rejects this await through the abort above. That
        // is a cancellation, not an upstream failure — there is no client
        // left to receive a 502, and the generic proxy does not log client
        // resets either.
        if (clientGone.signal.aborted || res.writableEnded) return;
        const message = error instanceof Error ? error.message : String(error);
        stats.totalErrors++;
        logError("proxy", 0, message);
        recordActivity({
          ts: attemptStartedAt,
          accountId: account.id,
          model,
          type: "error",
          statusCode: 0,
          method: req.method,
          path: req.path,
          source,
          details: routeFailureDetails(route, "proxy-error"),
          durationMs: now() - attemptStartedAt,
        });
        if (!res.headersSent) {
          // Match Anthropic's error response format so Claude Code handles it
          // gracefully — same shape the generic proxy's error handler sends.
          res.status(502).json({
            type: "error",
            error: { type: "proxy_error", message },
          });
        }
        return;
      }
      req.socket.setTimeout(0);

      const status = upstream.statusCode ?? 0;
      // Routing state changes implied by the failure — cooldowns and sticky
      // binding invalidation — run before any retry decision, so the
      // re-acquisition below already sees the failed account excluded.
      const failureRouting = applyUpstreamFailureRoutingDetailed(
        status,
        upstream.headers,
        route,
        opts.sessionRouter,
        opts.pool,
        now,
      );

      const entry: LogEntry = {
        ts: attemptStartedAt,
        accountId: account.id,
        model,
        type: "route",
        statusCode: status,
        method: req.method,
        path: req.path,
        source,
        details: routeReasonDetails(route),
        durationMs: now() - attemptStartedAt,
      };

      if (status === 401) {
        // Token invalid or expired mid-request. Forward the 401 to the client
        // (Claude Code will retry on 401) and schedule a background refresh
        // so the next request succeeds.
        stats.totalErrors++;
        account.errorCount++;
        entry.type = "error";
        entry.details = routeFailureDetails(route, "token-invalid");
        logError(account.id, 401, "Token invalid — scheduling background refresh");
        opts.onUpstream401?.(account);
      } else if (status === 429) {
        stats.totalErrors++;
        account.errorCount++;
        entry.type = "error";
        entry.details = routeFailureDetails(route, "rate-limited", failureRouting.limitingScope);
        logError(account.id, 429, `Rate limited — cooldown ${failureRouting.cooldownSeconds ?? 60}s`);
        // Lets the caller refresh usage in the background and narrow only
        // ambiguity-owned global state when fresh usage proves a
        // requested-model exhaustion.
        opts.onRateLimited?.(route, failureRouting.ambiguousCooldownToken);
      } else if (status === 529) {
        // Anthropic service overloaded — short cooldown on this account.
        stats.totalErrors++;
        account.errorCount++;
        entry.type = "error";
        entry.details = routeFailureDetails(route, "service-overloaded");
        logError(account.id, 529, "Service overloaded — cooldown 30s");
      } else if (status >= 500) {
        // A plain 5xx takes no cooldown: it says nothing about the account's
        // capacity and can even be request-specific, so cooling the account
        // down would punish it for upstream's (or the request's) problem.
        stats.totalErrors++;
        account.errorCount++;
        entry.type = "error";
        entry.details = routeFailureDetails(route, "upstream-error");
        logError(account.id, status, "Upstream server error");
      }

      // Capture rate limit utilization from response headers — failed
      // attempts carry them too.
      applyRateLimitHeaders(account, upstream.headers);

      // ── Router-side failover/retry ────────────────────────────────────────
      // Decided at response headers: not a single byte has been relayed yet.
      // Everything below resolves BEFORE the held failure response is
      // abandoned, so any dead end still relays it unchanged.
      if (isRetryableUpstreamStatus(status) && attempt < maxAttempts && !clientGone.signal.aborted) {
        let next: { route: RoutedAccountLease; release: () => void } | undefined;
        try {
          next = acquireRequestRoute(sessionHeader, res, opts.sessionRouter, context);
        } catch (error) {
          // Nothing eligible to fail over to — pass the failure through.
          // Only routing-level rejections are expected here; anything else is
          // a bug worth a log line, though pass-through stays the safe outcome.
          if (!(error instanceof NoEligibleAccountError) && !(error instanceof EmptyPoolError)) {
            const message = error instanceof Error ? error.message : String(error);
            logError("proxy", 0, `unexpected routing failure during retry: ${message}`);
          }
          next = undefined;
        }
        if (next && status === 429 && next.route.account.id === account.id) {
          // Re-sending a 429 to the account that produced it would only
          // reproduce the rate limit. The cooldown normally guarantees a
          // different account here; if it ever does not, pass through.
          next.release();
          next = undefined;
        }
        if (next && opts.needsRefresh(next.route.account)) {
          let refreshed = false;
          try {
            refreshed = await opts.refresh(next.route.account);
          } catch {
            refreshed = false;
          }
          if (!refreshed) {
            // The callback owns error stats/logging, exactly as it does for
            // the refresh middleware on the first attempt.
            opts.onRefreshFailure(next.route.account);
            next.release();
            next = undefined;
          }
        }
        if (clientGone.signal.aborted || res.writableEnded) {
          next?.release();
          release();
          upstream.destroy();
          return;
        }
        if (next) {
          // Committed: record the failed attempt and abandon its response.
          entry.details = `${entry.details}:will-retry`;
          recordActivity(entry);
          upstream.destroy();
          release();
          const sameAccount = next.route.account.id === account.id;
          route = next.route;
          release = next.release;
          req._ccRoute = route;
          req._ccReleaseLease = release;
          // An immediate same-account replay would hit whatever transient
          // condition produced the 5xx still in progress; a failover to a
          // different account needs no pause.
          if (sameAccount) {
            await retryDelay(sameAccountDelayMs, clientGone.signal);
            if (clientGone.signal.aborted || res.writableEnded) {
              release();
              return;
            }
          }
          continue;
        }
      }

      // The client may have left while the response headers (or the retry
      // decision) were in flight — the abort listener has already torn the
      // upstream request down, so there is nothing to relay and no reader to
      // relay it to. The attempt's bookkeeping above still stands; only a
      // response that upstream itself answered cleanly gets the cancellation
      // marker, mirroring the OpenAI ingress.
      // The final attempt's entry describes the whole client request: it
      // starts at the request and spans every attempt (and retry delay),
      // exactly like the OpenAI ingress — so ts + durationMs always equals
      // the moment the entry was finalized. Failed :will-retry entries keep
      // their own per-attempt window.
      entry.ts = startedAt;
      entry.durationMs = now() - startedAt;

      if (clientGone.signal.aborted || res.writableEnded) {
        if (entry.type === "route") {
          entry.details = entry.details ? `${entry.details} client-cancelled` : "client-cancelled";
        }
        recordActivity(entry);
        upstream.destroy();
        release();
        return;
      }

      // ── Final: relay this response byte-transparently ─────────────────────
      // The entry is recorded now (headers time) and mutated in place by the
      // usage capture; the dashboard picks the values up on its next poll —
      // same contract as the generic proxy path.
      recordActivity(entry);
      attachAnthropicResponseCapture(upstream, res, entry, startedAt);
      relayUpstreamResponse(upstream, req, res);
      return;
    }
  };

  app.post(
    "/v1/messages",
    requireBufferedBody,
    createAnthropicRoutingMiddleware({
      sessionRouter: opts.sessionRouter,
      ...(opts.onEmptyPool ? { onEmptyPool: opts.onEmptyPool } : {}),
      ...(opts.onNoEligibleAccount ? { onNoEligibleAccount: opts.onNoEligibleAccount } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    }),
    createAnthropicRefreshMiddleware({
      needsRefresh: opts.needsRefresh,
      refresh: opts.refresh,
      onRefreshFailure: opts.onRefreshFailure,
    }),
    (req, res, next) => {
      void handler(req, res).catch(next);
    },
  );
}
