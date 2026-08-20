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
import { stats, applyCodexUsage, boundModelId } from "./stats.js";
import type { LogEntry } from "./stats.js";
import { logWarn } from "./logger.js";
import type { SessionRouter } from "./session-router.js";
import { extractCodexSessionKey, sendOpenAINoEligibleResponse } from "./openai-routing.js";
import type { OpenAIAccount } from "../providers/openai/account-state.js";
import type { OpenAITokenPool } from "../providers/openai/token-pool.js";
import {
  runOpenAIIngress,
  mirrorUpstreamHeaders,
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
  /** Upstream attempts per client request (test override; default 3). */
  maxAttempts?: number;
  /** Delay before re-sending to the SAME account (test override). */
  sameAccountRetryDelayMs?: number;
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
  mirrorUpstreamHeaders(upstream.headers, (key, value) => res.setHeader(key, value));

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
  // Stop relaying the moment there is nobody to relay to. The ingress aborts
  // the upstream fetch on disconnect, which normally makes the pending read
  // reject on its own — but an upstream that has simply gone quiet leaves this
  // loop parked in `read()`, where no amount of polling `res.destroyed` would
  // ever run again. Racing the read against the close event is what actually
  // releases a stalled stream, so the account's upstream slot is not held for
  // a response nobody will receive.
  const DISCONNECTED = Symbol("client-disconnected");
  const disconnected = new Promise<typeof DISCONNECTED>(resolve => {
    if (res.destroyed) resolve(DISCONNECTED);
    else res.once("close", () => resolve(DISCONNECTED));
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), disconnected]);
      if (next === DISCONNECTED) {
        await reader.cancel().catch(() => {});
        break;
      }
      const { value, done } = next;
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
        model: boundModelId(req.body.model),
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
        model: boundModelId(req.body.model),
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
      method: req.method,
      // Only the Codex CLI speaks the Responses API to this proxy.
      source: "codex",
      openAIRouter: opts.openAIRouter,
      openAIPool: opts.openAIPool,
      prepareOpenAIAccount,
      forwardOpenAI,
      forwardBody: body,
      recordActivity,
      now,
      envelope: RESPONSES_ENVELOPE,
      onUpstreamAuthFailure: opts.onUpstreamAuthFailure,
      ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
      ...(opts.sameAccountRetryDelayMs !== undefined
        ? { sameAccountRetryDelayMs: opts.sameAccountRetryDelayMs }
        : {}),
      relay: async (upstream, res, entry, report) => {
        if (body.stream === true) {
          const observer = createCodexUsageObserver();
          // Only an upstream that actually promised a successful event stream
          // can be judged on whether that stream completed. A non-OK response
          // (a plain 401/429/5xx body) has no SSE events to observe, so
          // `failure()` would always report a missing completion — and
          // `sendUpstreamResponse` has already relayed the real status to the
          // client, so reporting 502 here would log a 502 for a client that
          // received a 429 and hide the actual failure from diagnostics.
          const streamed = upstream.ok
            && (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
          // Reported per chunk, not once at the end: this relay can throw
          // (or be cut short) after upstream has already announced a failure,
          // and the verdict has to survive that.
          await sendUpstreamResponse(upstream, res, chunk => {
            observer.push(chunk);
            if (observer.explicitFailure() !== undefined) report.upstreamReportedFailure = true;
          });
          applyCodexUsage(entry, observer.finish());
          // Bytes already written to the client are untouched — this only
          // changes the REPORTED status (used for stats/activity/cooldown),
          // matching a stream that upstream answered `200` but that ended in
          // a `response.failed`/`error` SSE event instead of completing.
          const synthesized = streamed && observer.failure() !== undefined;
          // A non-OK upstream has no SSE events to judge, so anything the
          // observer saw belongs to a body that was never an event stream.
          if (!streamed) report.upstreamReportedFailure = !upstream.ok;
          return { statusCode: synthesized ? 502 : upstream.status };
        }

        const collected = await collectCodexResponseStream(upstream, () => {
          report.upstreamReportedFailure = true;
        });
        // Mirror upstream headers (e.g. Retry-After, x-codex-*) before sending the
        // collected body, so failure responses reach the client unchanged per the
        // same contract the streaming path already honors via sendUpstreamResponse.
        // content-type is deliberately excluded here: Express's res.json() only sets
        // it when unset, so a mirrored content-type would silently win over the
        // application/json the .json() call below is supposed to set. .json()/.type()
        // remain the single source of truth for content-type, as today.
        mirrorUpstreamHeaders(upstream.headers, (key, value) => {
          if (key.toLowerCase() === "content-type") return;
          res.setHeader(key, value);
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
