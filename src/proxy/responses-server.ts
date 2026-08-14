import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { selectRoute } from "../providers/route-selector.js";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";
import {
  collectCodexResponseStream,
  createCodexResponseTerminalObserver,
} from "../protocol/openai-responses-collect.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";
import {
  annotateActiveSpan,
  classifyExpectedRuntimeFailure,
  recordSafeLog,
  recordUnexpectedException,
} from "../telemetry/facade.js";
import { stats } from "./stats.js";
import type { LogEntry } from "./stats.js";
import { logWarn } from "./logger.js";

type ForwardOpenAI = typeof forwardOpenAICodexResponse;

export interface ResponsesRoutesOptions {
  getOpenAIAccount: () => OpenAISubscriptionAccount | null;
  prepareOpenAIAccount?: (account: OpenAISubscriptionAccount) => Promise<boolean>;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
  prepareOpenAIAccountOwnsDiagnostics?: boolean;
  recordActivity?: (entry: LogEntry) => void;
}

function isResponsesRequest(value: unknown): value is OpenAIResponsesRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { model?: unknown }).model === "string" &&
    Array.isArray((value as { input?: unknown }).input)
  );
}

const SAFE_UPSTREAM_RESPONSE_HEADERS = ["content-type", "retry-after"] as const;

function copySafeUpstreamResponseHeaders(
  upstream: globalThis.Response,
  res: Response,
  names: readonly (typeof SAFE_UPSTREAM_RESPONSE_HEADERS)[number][] = SAFE_UPSTREAM_RESPONSE_HEADERS,
): void {
  for (const name of names) {
    const value = upstream.headers.get(name);
    if (value !== null) res.setHeader(name, value);
  }
}

type ResponseStreamOutcome = "complete" | "upstream_error";

async function sendUpstreamResponse(
  upstream: globalThis.Response,
  res: Response,
): Promise<ResponseStreamOutcome> {
  const contentType = upstream.headers.get("content-type");
  copySafeUpstreamResponseHeaders(upstream, res);

  res.status(upstream.status);
  if (!upstream.body) {
    if (upstream.ok && contentType?.includes("text/event-stream")) {
      res.destroy();
      return "upstream_error";
    }
    res.end();
    return upstream.ok ? "complete" : "upstream_error";
  }

  const observeTerminal = upstream.ok && contentType?.includes("text/event-stream");
  if (observeTerminal) {
    res.setHeader("cache-control", "no-cache");
    res.flushHeaders?.();
  }

  const reader = upstream.body.getReader();
  const observer = observeTerminal ? createCodexResponseTerminalObserver() : undefined;
  let shouldAbort = false;
  let streamOutcome: ResponseStreamOutcome = upstream.ok ? "complete" : "upstream_error";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        const observed = observer?.push(value);
        if (observed?.kind === "overflow" || observed?.kind === "malformed") {
          streamOutcome = "upstream_error";
          shouldAbort = true;
          void reader.cancel().catch(() => undefined);
          break;
        }
        res.write(Buffer.from(value));
      }
    }
    if (observer) {
      const terminal = observer.finish();
      if (terminal.kind === "failed" || terminal.kind === "error") {
        streamOutcome = "upstream_error";
      } else if (terminal.kind === "missing"
        || terminal.kind === "overflow"
        || terminal.kind === "malformed") {
        streamOutcome = "upstream_error";
        shouldAbort = true;
      }
    }
  } catch (error) {
    shouldAbort = true;
    throw error;
  } finally {
    if (shouldAbort) res.destroy();
    else res.end();
  }
  return streamOutcome;
}

function requestSource(req: Request): "cli" | "desktop" | "api" {
  if (req.headers["x-claude-code-session-id"] !== undefined) return "cli";
  if (req.headers["x-api-key"] !== undefined) return "desktop";
  return "api";
}

function modelFamily(model: string): "codex" | "other" {
  const normalized = model.toLowerCase();
  return normalized.includes("codex") || normalized.startsWith("gpt-") || normalized.startsWith("openai/gpt-")
    ? "codex"
    : "other";
}

function responseOutcome(status: number): "complete" | "rate_limited" | "upstream_error" {
  if (status >= 200 && status < 400) return "complete";
  return status === 429 ? "rate_limited" : "upstream_error";
}

function responseReason(status: number): "unauthorized" | "forbidden" | "rate_limited" | "upstream_4xx" | "upstream_5xx" {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "upstream_5xx" : "upstream_4xx";
}

export function mountResponsesRoutes(app: Express, opts: ResponsesRoutesOptions): void {
  const forwardOpenAI = opts.forwardOpenAI ?? forwardOpenAICodexResponse;
  const forwardOwnsDiagnostics = opts.forwardOpenAI === undefined;
  const prepareOwnsDiagnostics = opts.prepareOpenAIAccountOwnsDiagnostics === true;
  const prepareOpenAIAccount = opts.prepareOpenAIAccount ?? (async () => true);
  const recordActivity = opts.recordActivity ?? ((entry: LogEntry) => stats.addLog(entry));

  app.post("/v1/responses", express.json({ limit: "10mb" }), async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const startedAt = Date.now();
    if (!isResponsesRequest(req.body)) {
      annotateActiveSpan("proxy.request", {
        httpMethod: "POST",
        provider: "openai",
        route: "responses",
        requestSource: requestSource(req),
        httpStatusCode: 400,
        outcome: "upstream_error",
      });
      res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: "Expected Responses request with string model and input array",
        },
      });
      return;
    }

    const route = selectRoute(req.body.model, opts.modelRouting);
    if (req.body.store === true) {
      annotateActiveSpan("proxy.request", {
        httpMethod: "POST",
        provider: route.provider === "openai_subscription" ? "openai" : "anthropic",
        route: "responses",
        modelFamily: modelFamily(route.upstreamModel),
        requestSource: requestSource(req),
        streaming: req.body.stream === true,
        httpStatusCode: 400,
        outcome: "upstream_error",
        operationDurationMs: Date.now() - startedAt,
      });
      recordActivity({
        ts: Date.now(),
        accountId: "-",
        model: req.body.model,
        type: "warn",
        statusCode: 400,
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
        details: "max_output_tokens ignored — unsupported by the Codex backend",
      });
      logWarn("responses", "max_output_tokens is unsupported by the Codex backend and was dropped");
    }

    const streaming = req.body.stream === true;
    annotateActiveSpan("proxy.request", {
      httpMethod: "POST",
      provider: route.provider === "openai_subscription" ? "openai" : "anthropic",
      route: "responses",
      modelFamily: modelFamily(route.upstreamModel),
      requestSource: requestSource(req),
      streaming,
    });
    if (route.provider !== "openai_subscription") {
      annotateActiveSpan("proxy.request", {
        httpStatusCode: 501,
        outcome: "upstream_error",
        operationDurationMs: Date.now() - startedAt,
      });
      res.status(501).json({
        error: {
          type: "unsupported_provider",
          message: `Responses ingress for ${route.provider} is not implemented yet`,
        },
      });
      return;
    }

    const account = opts.getOpenAIAccount();
    if (!account) {
      annotateActiveSpan("proxy.request", {
        httpStatusCode: 503,
        outcome: "upstream_error",
        accountPoolSize: 0,
        operationDurationMs: Date.now() - startedAt,
      });
      recordSafeLog({
        operation: "proxy.request",
        provider: "openai",
        reason: "other",
        outcome: "upstream_error",
        httpStatusCode: 503,
        accountPoolSize: 0,
        operationDurationMs: Date.now() - startedAt,
        severity: "warn",
      });
      res.status(503).json({
        error: {
          type: "no_accounts",
          message: "No OpenAI subscription accounts are configured",
        },
      });
      return;
    }

    let failurePhase: "prepare" | "forward" | "delivery" = "prepare";
    try {
      const ready = await prepareOpenAIAccount(account);
      if (!ready) {
        annotateActiveSpan("proxy.request", {
          httpStatusCode: 401,
          outcome: "upstream_error",
          operationDurationMs: Date.now() - startedAt,
        });
        if (!prepareOwnsDiagnostics) {
          recordSafeLog({
            operation: "oauth.refresh",
            provider: "openai",
            reason: "unauthorized",
            outcome: "upstream_error",
            httpStatusCode: 401,
            operationDurationMs: Date.now() - startedAt,
            severity: "warn",
          });
        }
        res.status(401).json({
          error: {
            type: "authentication_error",
            message: "OpenAI subscription token refresh failed",
          },
        });
        return;
      }

      const body: OpenAIResponsesRequest = {
        ...req.body,
        model: route.upstreamModel,
      };
      failurePhase = "forward";
      const upstream = await forwardOpenAI({
        account,
        body,
        stream: body.stream === true,
      });
      failurePhase = "delivery";
      if (body.stream === true) {
        const outcome = responseOutcome(upstream.status);
        annotateActiveSpan("proxy.request", {
          httpStatusCode: upstream.status,
          outcome,
          operationDurationMs: Date.now() - startedAt,
        });
        if (!forwardOwnsDiagnostics && (upstream.status === 401 || upstream.status === 403
          || upstream.status === 429 || upstream.status === 529)) {
          recordSafeLog({
            operation: "provider.inference",
            provider: "openai",
            reason: responseReason(upstream.status),
            outcome,
            httpStatusCode: upstream.status,
            operationDurationMs: Date.now() - startedAt,
            severity: "warn",
          });
        }
        const streamOutcome = await sendUpstreamResponse(upstream, res);
        annotateActiveSpan("proxy.request", {
          outcome: streamOutcome === "upstream_error" && upstream.ok ? "upstream_error" : outcome,
          streamOutcome,
          operationDurationMs: Date.now() - startedAt,
        });
        return;
      }

      const collected = await collectCodexResponseStream(upstream);
      copySafeUpstreamResponseHeaders(upstream, res, ["retry-after"]);
      const outcome = responseOutcome(collected.status);
      annotateActiveSpan("proxy.request", {
        httpStatusCode: collected.status,
        outcome,
        operationDurationMs: Date.now() - startedAt,
      });
      const collectionFailed = collected.status >= 400 && collected.status !== upstream.status;
      if (collectionFailed || (!forwardOwnsDiagnostics && (collected.status === 401
        || collected.status === 403 || collected.status === 429 || collected.status === 529))) {
        recordSafeLog({
          operation: "provider.inference",
          provider: "openai",
          reason: responseReason(collected.status),
          outcome,
          httpStatusCode: collected.status,
          operationDurationMs: Date.now() - startedAt,
          severity: "warn",
        });
      }
      if (collected.kind === "json") {
        res.status(collected.status).json(collected.body);
      } else {
        res.status(collected.status).type(collected.contentType ?? "text/plain").send(collected.body);
      }
    } catch (error) {
      const reason = classifyExpectedRuntimeFailure(error);
      annotateActiveSpan("proxy.request", {
        outcome: reason === "timeout" ? "timeout" : "upstream_error",
        streamOutcome: reason === "timeout" ? "timeout" : "upstream_error",
        operationDurationMs: Date.now() - startedAt,
      });
      const leafOwnsFailure = failurePhase === "prepare"
        ? prepareOwnsDiagnostics
        : failurePhase === "forward"
          ? forwardOwnsDiagnostics
          : false;
      if (!leafOwnsFailure && reason) {
        recordSafeLog({
          operation: "provider.inference",
          provider: "openai",
          reason,
          outcome: reason === "timeout" ? "timeout" : "upstream_error",
          operationDurationMs: Date.now() - startedAt,
          severity: "error",
        });
      } else if (!leafOwnsFailure) {
        recordUnexpectedException(error, {
          category: "runtime",
          reason: "other",
          operation: "provider.inference",
          provider: "openai",
        });
      }
      next(error);
    }
  });
}
