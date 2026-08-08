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
import { usageFromResponseBody, type CodexUsageTotals } from "../protocol/openai-responses-collect.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";
import type { RouteContext } from "./types.js";
import { extractAnthropicRouteContext } from "./request-model.js";
import { stats, applyCodexUsage } from "./stats.js";
import type { LogEntry } from "./stats.js";
import type { SessionRouter } from "./session-router.js";
import { extractCodexSessionKey } from "./openai-routing.js";
import { sendAnthropicNoEligibleResponse } from "./anthropic-routing.js";
import type { OpenAIAccount } from "../providers/openai/account-state.js";
import type { OpenAITokenPool } from "../providers/openai/token-pool.js";
import {
  runOpenAIIngress,
  type ForwardOpenAI,
  type OpenAIIngressEnvelope,
} from "./openai-ingress.js";

declare module "express-serve-static-core" {
  interface Request {
    _ccRawBody?: Buffer;
    _ccRouteContext?: RouteContext;
  }
}

export interface MessagesCrossProviderRouteOptions {
  openAIRouter: SessionRouter<OpenAIAccount>;
  openAIPool: OpenAITokenPool;
  prepareOpenAIAccount?: (account: OpenAIAccount) => Promise<boolean>;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
  recordActivity?: (entry: LogEntry) => void;
  now?: () => number;
  onUpstreamAuthFailure?: (account: OpenAIAccount) => void;
}

const MESSAGES_ENVELOPE: OpenAIIngressEnvelope = {
  wrap: (type, message) => ({ type: "error", error: { type, message } }),
  sendNoEligible: (error, res, nowMs) => sendAnthropicNoEligibleResponse(error, res, nowMs),
};

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
  onUsage?: (usage: CodexUsageTotals | undefined) => void,
): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    if (requestedStream) {
      await sendOpenAIStreamAsAnthropic(upstream, res, onUsage);
      return;
    }

    const collected = await collectOpenAIStreamAsAnthropicMessage(upstream);
    onUsage?.(collected.usage);
    res.status(upstream.status).json(collected.message);
    return;
  }

  if (!contentType.includes("application/json")) {
    res.status(upstream.status);
    res.setHeader("content-type", contentType || "text/plain");
    res.send(await upstream.text());
    return;
  }

  const json = await upstream.json() as OpenAIResponseCompleted;
  onUsage?.(usageFromResponseBody(json));
  res.status(upstream.status).json(openAIResponseToAnthropicMessage(json));
}

async function collectOpenAIStreamAsAnthropicMessage(upstream: globalThis.Response): Promise<{
  message: ReturnType<typeof openAIResponseToAnthropicMessage>;
  usage: CodexUsageTotals | undefined;
}> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return {
      message: openAIResponseToAnthropicMessage({ id: "", model: "", output: [], usage: {} }),
      usage: undefined,
    };
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

  return {
    message: openAIResponseToAnthropicMessage({
      id,
      model,
      output: text ? [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      }] : [],
      usage,
    }),
    usage: usageFromResponseBody({ usage }),
  };
}

async function sendOpenAIStreamAsAnthropic(
  upstream: globalThis.Response,
  res: Response,
  onUsage?: (usage: CodexUsageTotals | undefined) => void,
): Promise<void> {
  res.status(upstream.status);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.flushHeaders?.();

  const normalizer = createOpenAIStreamToAnthropicNormalizer();
  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let remainder = "";

  const captureUsage = (event: unknown): void => {
    if (typeof event !== "object" || event === null) return;
    const typed = event as { type?: unknown; response?: unknown };
    if (typed.type !== "response.completed") return;
    onUsage?.(usageFromResponseBody(typed.response));
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }));
      remainder = parsed.remainder;
      for (const event of parsed.events) {
        captureUsage(event);
        for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
          res.write(encodeSseEvent(mapped));
        }
      }
    }

    const tail = decoder.decode();
    if (tail || remainder) {
      const parsed = parseSseLines(remainder + tail + "\n");
      for (const event of parsed.events) {
        captureUsage(event);
        for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
          res.write(encodeSseEvent(mapped));
        }
      }
    }
  } finally {
    res.end();
  }
}

export function mountMessagesCrossProviderRoute(
  app: Express,
  opts: MessagesCrossProviderRouteOptions,
): void {
  const forwardOpenAI = opts.forwardOpenAI ?? forwardOpenAICodexResponse;
  const prepareOpenAIAccount = opts.prepareOpenAIAccount ?? (async () => true);
  const recordActivity = opts.recordActivity ?? ((entry: LogEntry) => stats.addLog(entry));
  const now = opts.now ?? Date.now;

  app.post(
    "/v1/messages",
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        (req as Request)._ccRawBody = Buffer.from(buf);
      },
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      if (!isAnthropicMessagesRequest(req.body)) {
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
      if (route.provider !== "openai_subscription") {
        req._ccRouteContext = extractAnthropicRouteContext(requestedModel, opts.modelRouting);
        next();
        return;
      }

      const body = anthropicToOpenAIResponses(req.body, opts.modelRouting);
      const requestedStream = req.body.stream === true;

      await runOpenAIIngress({
        res,
        sessionKey: extractCodexSessionKey(req, req.body),
        requestedModel: route.upstreamModel,
        path: "/v1/messages",
        openAIRouter: opts.openAIRouter,
        openAIPool: opts.openAIPool,
        prepareOpenAIAccount,
        forwardOpenAI,
        forwardBody: body,
        recordActivity,
        now,
        envelope: MESSAGES_ENVELOPE,
        onUpstreamAuthFailure: opts.onUpstreamAuthFailure,
        relay: async (upstream, res, entry) => {
          await sendOpenAIAsAnthropic(upstream, res, requestedStream, usage => applyCodexUsage(entry, usage));
          return { statusCode: upstream.status };
        },
      });
    },
  );
}
