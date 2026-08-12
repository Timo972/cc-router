import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { selectRoute } from "../providers/route-selector.js";
import { anthropicToOpenAIResponses } from "../protocol/anthropic-to-openai.js";
import { openAIResponseToAnthropicMessage } from "../protocol/openai-response-to-anthropic.js";
import { createOpenAIStreamToAnthropicNormalizer } from "../protocol/openai-stream-to-anthropic.js";
import { encodeSseEvent, parseSseLines } from "../protocol/sse.js";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import type { AnthropicMessagesRequest } from "../protocol/anthropic-types.js";
import type { OpenAIResponseCompleted } from "../protocol/openai-responses-types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";
import type { RouteContext } from "./types.js";
import { extractAnthropicRouteContext } from "./request-model.js";
import {
  annotateActiveSpan,
  classifyExpectedRuntimeFailure,
  recordSafeLog,
  recordUnexpectedException,
} from "../telemetry/facade.js";

declare module "express-serve-static-core" {
  interface Request {
    _ccRawBody?: Buffer;
    _ccRouteContext?: RouteContext;
    _ccTelemetryStreaming?: boolean;
  }
}

type ForwardOpenAI = typeof forwardOpenAICodexResponse;

export interface MessagesCrossProviderRouteOptions {
  getOpenAIAccount: () => OpenAISubscriptionAccount | null;
  prepareOpenAIAccount?: (account: OpenAISubscriptionAccount) => Promise<boolean>;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
  prepareOpenAIAccountOwnsDiagnostics?: boolean;
}

function isAnthropicMessagesRequest(value: unknown): value is AnthropicMessagesRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { messages?: unknown }).messages)
  );
}

async function sendOpenAIAsAnthropic(
  upstream: globalThis.Response,
  res: Response,
  requestedStream: boolean,
): Promise<MessageDeliveryTelemetry> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    if (requestedStream) {
      return sendOpenAIStreamAsAnthropic(upstream, res);
    }

    const message = await collectOpenAIStreamAsAnthropicMessage(upstream);
    res.status(upstream.status).json(message);
    return telemetryForMessage(message, "complete");
  }

  if (!contentType.includes("application/json")) {
    res.status(upstream.status);
    res.setHeader("content-type", contentType || "text/plain");
    res.send(await upstream.text());
    return { streamOutcome: "complete" };
  }

  const json = await upstream.json() as OpenAIResponseCompleted;
  const message = openAIResponseToAnthropicMessage(json);
  res.status(upstream.status).json(message);
  return telemetryForMessage(message, "complete");
}

interface MessageDeliveryTelemetry {
  streamOutcome: "complete" | "upstream_error" | "cancelled" | "other";
  inputTokens?: number;
  outputTokens?: number;
}

function telemetryForMessage(
  message: ReturnType<typeof openAIResponseToAnthropicMessage>,
  streamOutcome: MessageDeliveryTelemetry["streamOutcome"],
): MessageDeliveryTelemetry {
  return {
    streamOutcome,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

async function collectOpenAIStreamAsAnthropicMessage(upstream: globalThis.Response): Promise<ReturnType<typeof openAIResponseToAnthropicMessage>> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return openAIResponseToAnthropicMessage({ id: "", model: "", output: [], usage: {} });
  }

  const decoder = new TextDecoder();
  let remainder = "";
  let id = "";
  let model = "";
  let text = "";
  let usage: OpenAIResponseCompleted["usage"] = {};

  const applyEvent = (event: unknown) => {
    if (typeof event !== "object" || event === null) return;
    const openAIEvent = event as {
      type?: string;
      delta?: string;
      response?: {
        id?: string;
        model?: string;
        usage?: OpenAIResponseCompleted["usage"];
      };
    };

    if (openAIEvent.type === "response.created") {
      id = openAIEvent.response?.id ?? id;
      model = openAIEvent.response?.model ?? model;
      return;
    }

    if (openAIEvent.type === "response.output_text.delta") {
      text += openAIEvent.delta ?? "";
      return;
    }

    if (openAIEvent.type === "response.completed") {
      id = openAIEvent.response?.id ?? id;
      model = openAIEvent.response?.model ?? model;
      usage = openAIEvent.response?.usage ?? usage;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }));
    remainder = parsed.remainder;
    parsed.events.forEach(applyEvent);
  }

  const tail = decoder.decode();
  if (tail || remainder) {
    parseSseLines(remainder + tail + "\n").events.forEach(applyEvent);
  }

  return openAIResponseToAnthropicMessage({
    id,
    model,
    output: text ? [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    }] : [],
    usage,
  });
}

async function sendOpenAIStreamAsAnthropic(
  upstream: globalThis.Response,
  res: Response,
): Promise<MessageDeliveryTelemetry> {
  res.status(upstream.status);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.flushHeaders?.();

  const normalizer = createOpenAIStreamToAnthropicNormalizer();
  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end();
    return { streamOutcome: "other" };
  }

  const decoder = new TextDecoder();
  let remainder = "";
  let sawCompleted = false;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const observeTelemetry = (event: unknown): void => {
    if (typeof event !== "object" || event === null) return;
    const candidate = event as {
      type?: string;
      response?: { usage?: { input_tokens?: number; output_tokens?: number } };
    };
    if (candidate.type !== "response.completed") return;
    sawCompleted = true;
    inputTokens = candidate.response?.usage?.input_tokens;
    outputTokens = candidate.response?.usage?.output_tokens;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }));
      remainder = parsed.remainder;
      for (const event of parsed.events) {
        observeTelemetry(event);
        for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
          res.write(encodeSseEvent(mapped));
        }
      }
    }

    const tail = decoder.decode();
    if (tail || remainder) {
      const parsed = parseSseLines(remainder + tail + "\n");
      for (const event of parsed.events) {
        observeTelemetry(event);
        for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
          res.write(encodeSseEvent(mapped));
        }
      }
    }
  } finally {
    res.end();
  }
  return {
    streamOutcome: sawCompleted ? "complete" : "other",
    inputTokens,
    outputTokens,
  };
}

function requestSource(req: Request): "cli" | "desktop" | "api" {
  if (req.headers["x-claude-code-session-id"] !== undefined) return "cli";
  if (req.headers["x-api-key"] !== undefined) return "desktop";
  return "api";
}

function modelFamily(model: string): "fable" | "sonnet" | "opus" | "haiku" | "codex" | "other" {
  const normalized = model.toLowerCase();
  if (normalized.includes("codex") || normalized.startsWith("gpt-") || normalized.startsWith("openai/gpt-")) {
    return "codex";
  }
  for (const family of ["fable", "sonnet", "opus", "haiku"] as const) {
    if (normalized.includes(family)) return family;
  }
  return "other";
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

export function mountMessagesCrossProviderRoute(
  app: Express,
  opts: MessagesCrossProviderRouteOptions,
): void {
  const forwardOpenAI = opts.forwardOpenAI ?? forwardOpenAICodexResponse;
  const forwardOwnsDiagnostics = opts.forwardOpenAI === undefined;
  const prepareOwnsDiagnostics = opts.prepareOpenAIAccountOwnsDiagnostics === true;
  const prepareOpenAIAccount = opts.prepareOpenAIAccount ?? (async () => true);

  app.post(
    "/v1/messages",
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        (req as Request)._ccRawBody = Buffer.from(buf);
      },
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const startedAt = Date.now();
      if (!isAnthropicMessagesRequest(req.body)) {
        annotateActiveSpan("proxy.request", {
          httpMethod: "POST",
          route: "messages",
          requestSource: requestSource(req),
          httpStatusCode: 400,
          outcome: "upstream_error",
        });
        res.status(400).json({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Expected Anthropic Messages request with messages array",
          },
        });
        return;
      }

      const requestedModel = typeof req.body.model === "string" ? req.body.model : undefined;
      const route = selectRoute(requestedModel, opts.modelRouting);
      const provider = route.provider === "openai_subscription" ? "openai" : "anthropic";
      const streaming = req.body.stream === true;
      req._ccTelemetryStreaming = streaming;
      annotateActiveSpan("proxy.request", {
        httpMethod: "POST",
        provider,
        route: "messages",
        modelFamily: modelFamily(route.upstreamModel),
        requestSource: requestSource(req),
        streaming,
      });
      if (route.provider !== "openai_subscription") {
        req._ccRouteContext = extractAnthropicRouteContext(requestedModel, opts.modelRouting);
        next();
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
          type: "error",
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
            type: "error",
            error: {
              type: "authentication_error",
              message: "OpenAI subscription token refresh failed",
            },
          });
          return;
        }

        const body = anthropicToOpenAIResponses(req.body, opts.modelRouting);
        failurePhase = "forward";
        const upstream = await forwardOpenAI({
          account,
          body,
          stream: body.stream === true,
        });
        failurePhase = "delivery";
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
        const delivery = await sendOpenAIAsAnthropic(upstream, res, streaming);
        annotateActiveSpan("proxy.request", {
          streamOutcome: streaming ? delivery.streamOutcome : undefined,
          inputTokens: delivery.inputTokens,
          outputTokens: delivery.outputTokens,
          operationDurationMs: Date.now() - startedAt,
        });
      } catch (error) {
        const reason = classifyExpectedRuntimeFailure(error);
        annotateActiveSpan("proxy.request", {
          outcome: reason === "timeout" ? "timeout" : "upstream_error",
          streamOutcome: streaming ? reason === "timeout" ? "timeout" : "upstream_error" : undefined,
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
    },
  );
}
