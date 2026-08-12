import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { selectRoute } from "../providers/route-selector.js";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";
import {
  annotateActiveSpan,
  classifyExpectedRuntimeFailure,
  recordSafeLog,
  recordUnexpectedException,
} from "../telemetry/facade.js";

type ForwardOpenAI = typeof forwardOpenAICodexResponse;

export interface ResponsesRoutesOptions {
  getOpenAIAccount: () => OpenAISubscriptionAccount | null;
  prepareOpenAIAccount?: (account: OpenAISubscriptionAccount) => Promise<boolean>;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
}

function isResponsesRequest(value: unknown): value is OpenAIResponsesRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { model?: unknown }).model === "string" &&
    Array.isArray((value as { input?: unknown }).input)
  );
}

async function sendUpstreamResponse(upstream: globalThis.Response, res: Response): Promise<"complete"> {
  const contentType = upstream.headers.get("content-type");
  if (contentType) res.setHeader("content-type", contentType);

  res.status(upstream.status);
  if (!upstream.body) {
    res.end();
    return "complete";
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
      if (value) res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
  return "complete";
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
  const prepareOpenAIAccount = opts.prepareOpenAIAccount ?? (async () => true);

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

    try {
      const ready = await prepareOpenAIAccount(account);
      if (!ready) {
        annotateActiveSpan("proxy.request", {
          httpStatusCode: 401,
          outcome: "upstream_error",
          operationDurationMs: Date.now() - startedAt,
        });
        recordSafeLog({
          operation: "oauth.refresh",
          provider: "openai",
          reason: "unauthorized",
          outcome: "upstream_error",
          httpStatusCode: 401,
          operationDurationMs: Date.now() - startedAt,
          severity: "warn",
        });
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
      const upstream = await forwardOpenAI({
        account,
        body,
        stream: body.stream === true,
      });
      const outcome = responseOutcome(upstream.status);
      annotateActiveSpan("proxy.request", {
        httpStatusCode: upstream.status,
        outcome,
        operationDurationMs: Date.now() - startedAt,
      });
      if (upstream.status === 401 || upstream.status === 403
        || upstream.status === 429 || upstream.status === 529) {
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
        streamOutcome: streaming ? streamOutcome : undefined,
        operationDurationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const reason = classifyExpectedRuntimeFailure(error);
      annotateActiveSpan("proxy.request", {
        outcome: reason === "timeout" ? "timeout" : "upstream_error",
        streamOutcome: reason === "timeout" ? "timeout" : "upstream_error",
        operationDurationMs: Date.now() - startedAt,
      });
      if (reason) {
        recordSafeLog({
          operation: "provider.inference",
          provider: "openai",
          reason,
          outcome: reason === "timeout" ? "timeout" : "upstream_error",
          operationDurationMs: Date.now() - startedAt,
          severity: "error",
        });
      } else {
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
