import express from "express";
import type { Express, Request, Response } from "express";
import { selectRoute } from "../providers/route-selector.js";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";
import {
  collectCodexResponseStream,
  createCodexUsageObserver,
  usageFromResponseBody,
} from "../protocol/openai-responses-collect.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";
import { stats, createLocalRoutingErrorLog, applyCodexUsage } from "./stats.js";
import type { LogEntry } from "./stats.js";
import { logWarn } from "./logger.js";
import { EmptyPoolError, NoEligibleAccountError } from "./account-pool.js";
import type { SessionRouter, RoutedAccountLease } from "./session-router.js";
import { acquireRequestRoute, routeReasonDetails, routeFailureDetails } from "./lease-lifecycle.js";
import { extractCodexSessionKey, sendOpenAINoEligibleResponse } from "./openai-routing.js";
import { applyCodexRateLimits, type OpenAIAccount } from "../providers/openai/account-state.js";
import { headersToRecord, parseCodexRateLimits } from "../providers/openai/usage.js";
import { applyCodexFailureRouting } from "../providers/openai/failure-routing.js";
import { needsOpenAIRefresh } from "../providers/openai/token-refresher.js";
import type { OpenAITokenPool } from "../providers/openai/token-pool.js";

type ForwardOpenAI = typeof forwardOpenAICodexResponse;

const HOP_BY_HOP_HEADERS = new Set(["content-length", "transfer-encoding", "connection", "keep-alive"]);

export interface ResponsesRoutesOptions {
  openAIRouter: SessionRouter<OpenAIAccount>;
  openAIPool: OpenAITokenPool;
  prepareOpenAIAccount?: (account: OpenAIAccount) => Promise<boolean>;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
  recordActivity?: (entry: LogEntry) => void;
  now?: () => number;
}

function isResponsesRequest(value: unknown): value is OpenAIResponsesRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { model?: unknown }).model === "string" &&
    Array.isArray((value as { input?: unknown }).input)
  );
}

async function sendUpstreamResponse(
  upstream: globalThis.Response,
  res: Response,
  onChunk?: (chunk: Uint8Array) => void,
): Promise<void> {
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
  });

  const contentType = upstream.headers.get("content-type");
  res.status(upstream.status);
  if (!upstream.body) {
    res.end();
    return;
  }

  if (contentType?.includes("text/event-stream")) {
    res.setHeader("cache-control", "no-cache");
    res.flushHeaders?.();
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        res.write(Buffer.from(value));
        onChunk?.(value);
      }
    }
  } finally {
    res.end();
  }
}

export function mountResponsesRoutes(app: Express, opts: ResponsesRoutesOptions): void {
  const forwardOpenAI = opts.forwardOpenAI ?? forwardOpenAICodexResponse;
  const prepareOpenAIAccount = opts.prepareOpenAIAccount ?? (async () => true);
  const recordActivity = opts.recordActivity ?? ((entry: LogEntry) => stats.addLog(entry));
  const now = opts.now ?? Date.now;

  app.post("/v1/responses", express.json({ limit: "10mb" }), async (req: Request, res: Response) => {
    if (!isResponsesRequest(req.body)) {
      res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: "Expected Responses request with string model and input array",
        },
      });
      return;
    }

    if (req.body.store === true) {
      recordActivity({
        ts: Date.now(),
        accountId: "-",
        model: req.body.model,
        type: "warn",
        statusCode: 400,
        path: "/v1/responses",
        details: "store:true rejected — Codex backend is stateless (store:false only)",
      });
      logWarn("responses", "store:true is not supported by the Codex backend; rejecting request");
      res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: "store:true is not supported: the Codex subscription backend operates only in stateless (store:false) mode.",
        },
      });
      return;
    }

    if (req.body.max_output_tokens !== undefined) {
      recordActivity({
        ts: Date.now(),
        accountId: "-",
        model: req.body.model,
        type: "warn",
        path: "/v1/responses",
        details: "max_output_tokens ignored — unsupported by the Codex backend",
      });
      logWarn("responses", "max_output_tokens is unsupported by the Codex backend and was dropped");
    }

    const route = selectRoute(req.body.model, opts.modelRouting);
    if (route.provider !== "openai_subscription") {
      res.status(501).json({
        error: {
          type: "unsupported_provider",
          message: `Responses ingress for ${route.provider} is not implemented yet`,
        },
      });
      return;
    }

    let selected: { route: RoutedAccountLease<OpenAIAccount>; release: () => void; details: string };
    try {
      selected = acquireRequestRoute(
        extractCodexSessionKey(req, req.body),
        res,
        opts.openAIRouter,
        { requestedModel: route.upstreamModel },
      );
    } catch (error) {
      if (error instanceof EmptyPoolError) {
        res.status(503).json({
          error: { type: "no_accounts", message: "No OpenAI subscription accounts are configured" },
        });
        return;
      }
      if (error instanceof NoEligibleAccountError) {
        recordActivity(createLocalRoutingErrorLog(error.reason, route.upstreamModel));
        sendOpenAINoEligibleResponse(error, res, now());
        return;
      }
      throw error;
    }

    const account = selected.route.account;
    const startedAt = now();
    const needed = needsOpenAIRefresh(account);
    const ready = await prepareOpenAIAccount(account);
    if (!ready) {
      selected.release();
      account.errorCount++;
      account.healthy = false;
      recordActivity({
        ts: now(),
        accountId: account.id,
        model: route.upstreamModel,
        type: "error",
        statusCode: 401,
        path: "/v1/responses",
        details: "openai token refresh failed",
      });
      res.status(401).json({
        error: { type: "authentication_error", message: "OpenAI subscription token refresh failed" },
      });
      return;
    }
    account.healthy = true;
    if (needed) account.lastRefresh = now();

    const body: OpenAIResponsesRequest = { ...req.body, model: route.upstreamModel };
    const upstream = await forwardOpenAI({ account, body, stream: body.stream === true });

    const headerRecord = headersToRecord(upstream.headers);
    applyCodexRateLimits(account, parseCodexRateLimits(headerRecord, now()), now());

    const failed = upstream.status === 401 || upstream.status === 429 || upstream.status >= 500;
    let details = routeReasonDetails(selected.route);
    if (failed) {
      account.errorCount++;
      account.consecutiveErrors++;
      stats.totalErrors++;
      const applied = applyCodexFailureRouting(
        upstream.status,
        headerRecord,
        selected.route,
        route.upstreamModel,
        opts.openAIRouter,
        opts.openAIPool,
        now,
      );
      details = routeFailureDetails(
        selected.route,
        upstream.status === 401 ? "token-invalid" : upstream.status === 429 ? "rate-limited" : "service-overloaded",
        applied.limitingScope,
      );
    } else {
      account.consecutiveErrors = 0;
      stats.totalRequests++;
    }

    const entry: LogEntry = {
      ts: startedAt,
      accountId: account.id,
      model: route.upstreamModel,
      type: failed ? "error" : "route",
      statusCode: upstream.status,
      path: "/v1/responses",
      details,
    };

    if (body.stream === true) {
      const observer = createCodexUsageObserver();
      await sendUpstreamResponse(upstream, res, chunk => observer.push(chunk));
      applyCodexUsage(entry, observer.finish());
    } else {
      const collected = await collectCodexResponseStream(upstream);
      if (collected.kind === "json") {
        applyCodexUsage(entry, usageFromResponseBody(collected.body));
        res.status(collected.status).json(collected.body);
      } else {
        res.status(collected.status).type(collected.contentType ?? "text/plain").send(collected.body);
      }
    }
    entry.durationMs = now() - startedAt;
    recordActivity(entry);
  });
}
