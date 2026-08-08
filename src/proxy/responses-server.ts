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
import { stats, applyCodexUsage } from "./stats.js";
import type { LogEntry } from "./stats.js";
import { logWarn } from "./logger.js";
import type { SessionRouter } from "./session-router.js";
import { extractCodexSessionKey, sendOpenAINoEligibleResponse } from "./openai-routing.js";
import type { OpenAIAccount } from "../providers/openai/account-state.js";
import type { OpenAITokenPool } from "../providers/openai/token-pool.js";
import {
  runOpenAIIngress,
  EXCLUDED_UPSTREAM_RELAY_HEADERS,
  type ForwardOpenAI,
  type OpenAIIngressEnvelope,
} from "./openai-ingress.js";

export interface ResponsesRoutesOptions {
  openAIRouter: SessionRouter<OpenAIAccount>;
  openAIPool: OpenAITokenPool;
  prepareOpenAIAccount?: (account: OpenAIAccount) => Promise<boolean>;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
  recordActivity?: (entry: LogEntry) => void;
  now?: () => number;
  onUpstreamAuthFailure?: (account: OpenAIAccount) => void;
}

const RESPONSES_ENVELOPE: OpenAIIngressEnvelope = {
  wrap: (type, message) => ({ error: { type, message } }),
  sendNoEligible: (error, res, nowMs) => sendOpenAINoEligibleResponse(error, res, nowMs),
};

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
    if (!EXCLUDED_UPSTREAM_RELAY_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
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

    const body: OpenAIResponsesRequest = { ...req.body, model: route.upstreamModel };

    await runOpenAIIngress({
      res,
      sessionKey: extractCodexSessionKey(req, req.body),
      requestedModel: route.upstreamModel,
      path: "/v1/responses",
      openAIRouter: opts.openAIRouter,
      openAIPool: opts.openAIPool,
      prepareOpenAIAccount,
      forwardOpenAI,
      forwardBody: body,
      recordActivity,
      now,
      envelope: RESPONSES_ENVELOPE,
      onUpstreamAuthFailure: opts.onUpstreamAuthFailure,
      relay: async (upstream, res, entry) => {
        if (body.stream === true) {
          const observer = createCodexUsageObserver();
          await sendUpstreamResponse(upstream, res, chunk => observer.push(chunk));
          applyCodexUsage(entry, observer.finish());
          return { statusCode: upstream.status };
        }

        const collected = await collectCodexResponseStream(upstream);
        // Mirror upstream headers (e.g. Retry-After, x-codex-*) before sending the
        // collected body, so failure responses reach the client unchanged per the
        // same contract the streaming path already honors via sendUpstreamResponse.
        // content-type is deliberately excluded here: Express's res.json() only sets
        // it when unset, so a mirrored content-type would silently win over the
        // application/json the .json() call below is supposed to set. .json()/.type()
        // remain the single source of truth for content-type, as today.
        upstream.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (lower === "content-type") return;
          if (!EXCLUDED_UPSTREAM_RELAY_HEADERS.has(lower)) res.setHeader(key, value);
        });
        if (collected.kind === "json") {
          applyCodexUsage(entry, usageFromResponseBody(collected.body));
          res.status(collected.status).json(collected.body);
        } else {
          res.status(collected.status).type(collected.contentType ?? "text/plain").send(collected.body);
        }
        return { statusCode: collected.status };
      },
    });
  });
}
