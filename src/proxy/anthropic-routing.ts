import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { acquireRequestRoute } from "./lease-lifecycle.js";
import { normalizeSessionId, type RoutedAccountLease, type SessionRouter } from "./session-router.js";
import { EmptyPoolError } from "./token-pool.js";
import type { Account } from "./types.js";

const SESSION_HEADER = "x-claude-code-session-id";

type RoutedRequest = Request & {
  _ccAccount?: Account;
  _ccRoute?: RoutedAccountLease;
  _ccReleaseLease?: () => void;
};

/** Extract exactly one native HTTP session header field without joined duplicates. */
export function extractClaudeSessionId(request: IncomingMessage): string | undefined {
  const distinct = request.headersDistinct;
  if (distinct !== undefined) {
    const values = distinct[SESSION_HEADER];
    if (!values || values.length !== 1) return undefined;
    return normalizeSessionId(values[0]);
  }

  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== SESSION_HEADER) continue;
    values.push(request.rawHeaders[index + 1] ?? "");
  }
  if (values.length !== 1) return undefined;
  return normalizeSessionId(values[0]);
}

export interface AnthropicRoutingMiddlewareOptions {
  sessionRouter: SessionRouter;
  onEmptyPool?: (error: EmptyPoolError, request: Request, response: Response) => void;
}

/** Acquire the production route and bind its lease to downstream termination. */
export function createAnthropicRoutingMiddleware(
  options: AnthropicRoutingMiddlewareOptions,
): RequestHandler {
  return (request, response, next) => {
    const routedRequest = request as RoutedRequest;
    try {
      const selected = acquireRequestRoute(
        extractClaudeSessionId(request),
        response,
        options.sessionRouter,
        request._ccRouteContext,
      );
      routedRequest._ccRoute = selected.route;
      routedRequest._ccReleaseLease = selected.release;
      routedRequest._ccAccount = selected.route.account;
      next();
    } catch (error) {
      if (error instanceof EmptyPoolError && options.onEmptyPool) {
        options.onEmptyPool(error, request, response);
        return;
      }
      next(error);
    }
  };
}

export interface AnthropicRefreshMiddlewareOptions {
  needsRefresh(account: Account): boolean;
  /** Refresh and durably persist rotated credentials before resolving true. */
  refresh(account: Account): Promise<boolean>;
  onRefreshFailure(account: Account): void;
}

function requestTerminated(request: Request, response: Response): boolean {
  return request.aborted || response.destroyed || response.writableEnded;
}

/** Prepare the selected account, but never continue after downstream termination. */
export function createAnthropicRefreshMiddleware(
  options: AnthropicRefreshMiddlewareOptions,
): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    const routedRequest = request as RoutedRequest;
    const account = routedRequest._ccAccount;
    const release = routedRequest._ccReleaseLease;
    if (!account || !release) {
      next(new Error("Anthropic route missing before refresh"));
      return;
    }

    try {
      if (options.needsRefresh(account)) {
        const ok = await options.refresh(account);
        if (requestTerminated(request, response)) {
          release();
          return;
        }
        if (!ok) {
          release();
          options.onRefreshFailure(account);
          response.status(401).json({
            type: "error",
            error: {
              type: "authentication_error",
              message: "Anthropic subscription token refresh failed",
            },
          });
          return;
        }
      }

      if (requestTerminated(request, response)) {
        release();
        return;
      }
      next();
    } catch (error) {
      release();
      if (requestTerminated(request, response)) return;
      next(error);
    }
  };
}
