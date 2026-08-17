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
import {
  terminalResponsePayload,
  usageFromTerminalEvent,
  usageFromResponseBody,
  type CodexUsageTotals,
} from "../protocol/openai-responses-collect.js";
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
  mirrorUpstreamHeaders,
  runOpenAIIngress,
  type ForwardOpenAI,
  type OpenAIIngressEnvelope,
  type OpenAIIngressRelayResult,
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

/** Longest upstream error snippet echoed back when the body isn't JSON. */
const MAX_UPSTREAM_ERROR_MESSAGE_LENGTH = 200;

/** How a relayed stream ended. `explicit` distinguishes a failure upstream
 *  stated outright from one inferred from a stream that simply stopped —
 *  which a client hanging up produces just as well. */
interface StreamFailure {
  message: string | undefined;
  explicit: boolean;
}

/** Anthropic error `type` for a relayed upstream HTTP failure status. */
function anthropicErrorTypeForStatus(status: number): string {
  if (status === 429) return "rate_limit_error";
  if (status === 401) return "authentication_error";
  if (status >= 500) return "upstream_error";
  return "invalid_request_error";
}

/**
 * Best-effort human-readable message for a non-OK upstream response: prefer
 * a JSON `error.message`, else fall back to a bounded, control-character-free
 * snippet of the raw body, else a generic status-only message.
 */
function extractUpstreamErrorMessage(bodyText: string, status: number): string {
  const trimmed = bodyText.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } };
      const message = parsed.error?.message;
      if (typeof message === "string" && message) return message;
    } catch {
      // Not JSON — fall through to a bounded text snippet below.
    }
    const snippet = trimmed.replace(/[\x00-\x1f\x7f]/g, "").slice(0, MAX_UPSTREAM_ERROR_MESSAGE_LENGTH);
    if (snippet) return snippet;
  }
  return `Upstream request failed with status ${status}`;
}

/**
 * Relay an upstream Codex response in Anthropic Messages shape and report the
 * status the client actually received — which is not always `upstream.status`:
 * the Codex backend signals in-stream failures as a `response.failed`/`error`
 * SSE event on an HTTP 200, and those must not be reported as success.
 */
async function sendOpenAIAsAnthropic(
  upstream: globalThis.Response,
  res: Response,
  requestedStream: boolean,
  entry: LogEntry,
): Promise<OpenAIIngressRelayResult> {
  const onUsage = (usage: CodexUsageTotals | undefined) => applyCodexUsage(entry, usage);

  // A non-OK response is never a Responses payload, whatever its content-type
  // — parsing it as an event stream or a completed response would translate a
  // real upstream failure (401/429/5xx) into an empty "success". Handle it
  // before any content-type dispatch and relay the upstream status verbatim,
  // never a synthesized 502.
  if (!upstream.ok) {
    const bodyText = await upstream.text();
    // Mirror the safe upstream headers so a client can honor the server's
    // backoff: without Retry-After a 429 tells the caller to slow down but not
    // for how long. content-type is skipped for the same reason as the
    // /v1/responses collected path — res.json() below only sets it when unset,
    // so a mirrored value would silently win over the JSON envelope's own.
    mirrorUpstreamHeaders(upstream.headers, (key, value) => {
      if (key.toLowerCase() === "content-type") return;
      res.setHeader(key, value);
    });
    res.status(upstream.status).json({
      type: "error",
      error: {
        type: anthropicErrorTypeForStatus(upstream.status),
        message: extractUpstreamErrorMessage(bodyText, upstream.status),
      },
    });
    return { statusCode: upstream.status, upstreamReportedFailure: true };
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    if (requestedStream) {
      // Headers are already flushed by the time a mid-stream failure surfaces,
      // so the client keeps the partial stream; reporting 502 here keeps the
      // activity log and error totals honest about what happened.
      const failure = await sendOpenAIStreamAsAnthropic(upstream, res, onUsage);
      if (failure.message === undefined) return { statusCode: upstream.status };
      return { statusCode: 502, ...(failure.explicit ? { upstreamReportedFailure: true } : {}) };
    }

    const collected = await collectOpenAIStreamAsAnthropicMessage(upstream);
    onUsage(collected.usage);
    if (collected.failure !== undefined) {
      // Mirrors collectCodexResponseStream on the /v1/responses path: a stream
      // that ended in failure is a 502, never an empty 200 "success".
      res.status(502).json({
        type: "error",
        error: { type: "upstream_error", message: collected.failure },
      });
      return { statusCode: 502, ...(collected.failureExplicit ? { upstreamReportedFailure: true } : {}) };
    }
    res.status(upstream.status).json(collected.message);
    return { statusCode: upstream.status };
  }

  if (!contentType.includes("application/json")) {
    res.status(upstream.status);
    res.setHeader("content-type", contentType || "text/plain");
    res.send(await upstream.text());
    return { statusCode: upstream.status };
  }

  const json = await upstream.json() as OpenAIResponseCompleted;
  onUsage(usageFromResponseBody(json));
  res.status(upstream.status).json(openAIResponseToAnthropicMessage(json));
  return { statusCode: upstream.status };
}

async function collectOpenAIStreamAsAnthropicMessage(upstream: globalThis.Response): Promise<{
  message: ReturnType<typeof openAIResponseToAnthropicMessage>;
  usage: CodexUsageTotals | undefined;
  failure: string | undefined;
  failureExplicit: boolean;
}> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    // An event-stream response with no body cannot have reached a terminal
    // event. Reporting it as a failure keeps the caller from fabricating an
    // empty 200.
    return {
      message: openAIResponseToAnthropicMessage({ id: "", model: "", output: [], usage: {} }),
      usage: undefined,
      failure: "Upstream response had no body",
      // Upstream's own doing: a body absent before a single byte was read is
      // not something a client disconnect could have produced.
      failureExplicit: true,
    };
  }

  const decoder = new TextDecoder();
  let remainder = "";
  let id = "";
  let model = "";
  let text = "";
  let failure: string | undefined;
  let completed = false;
  let usage: OpenAIResponseCompleted["usage"] = {};
  let status: string | undefined;
  let incompleteDetails: { reason?: string } | undefined;

  const applyEvent = (event: unknown) => {
    if (typeof event !== "object" || event === null) return;
    const openAIEvent = event as {
      type?: string;
      delta?: string;
      error?: { message?: string };
      response?: {
        id?: string;
        model?: string;
        status?: string;
        incomplete_details?: { reason?: string };
        error?: { message?: string };
        usage?: OpenAIResponseCompleted["usage"];
      };
    };

    if (openAIEvent.type === "response.failed") {
      failure = openAIEvent.response?.error?.message ?? "Response failed";
      return;
    }

    if (openAIEvent.type === "error") {
      failure = openAIEvent.error?.message ?? "Upstream error event";
      return;
    }

    if (openAIEvent.type === "response.created") {
      id = openAIEvent.response?.id ?? id;
      model = openAIEvent.response?.model ?? model;
      return;
    }

    if (openAIEvent.type === "response.output_text.delta") {
      text += openAIEvent.delta ?? "";
      return;
    }

    if (terminalResponsePayload(event) !== undefined) {
      id = openAIEvent.response?.id ?? id;
      model = openAIEvent.response?.model ?? model;
      usage = openAIEvent.response?.usage ?? usage;
      // How the turn ended has to survive into the reconstructed response
      // below: it is what tells the translator to report `max_tokens` rather
      // than an `end_turn` that would make a truncated answer look deliberate.
      status = openAIEvent.response?.status ?? status;
      incompleteDetails = openAIEvent.response?.incomplete_details ?? incompleteDetails;
      completed = true;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }), { tolerant: true });
    remainder = parsed.remainder;
    parsed.events.forEach(applyEvent);
  }

  const tail = decoder.decode();
  if (tail || remainder) {
    parseSseLines(remainder + tail + "\n", { tolerant: true }).events.forEach(applyEvent);
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
      ...(status ? { status } : {}),
      ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
    }),
    usage: usageFromResponseBody({ usage }),
    // Tolerant parsing skips a malformed frame rather than aborting the read,
    // which keeps a bad nonterminal frame from truncating the stream — but it
    // also means a malformed *terminal* frame (`response.completed` or
    // `response.incomplete`) would silently vanish. Without an observed
    // terminal event there is no answer to return, so a stream that ends
    // without one (dropped terminal frame, or an upstream that simply stopped
    // mid-flight) is a failure rather than an empty success. An explicit
    // `response.failed`/`error` message wins, since it says more about what
    // went wrong.
    failure: failure ?? (completed ? undefined : "Upstream stream ended without a terminal response event"),
    failureExplicit: failure !== undefined,
  };
}

/** Reports how the stream ended: the failure message when it ended in one,
 *  and whether upstream stated that failure outright. */
async function sendOpenAIStreamAsAnthropic(
  upstream: globalThis.Response,
  res: Response,
  onUsage?: (usage: CodexUsageTotals | undefined) => void,
): Promise<StreamFailure> {
  res.status(upstream.status);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.flushHeaders?.();

  const normalizer = createOpenAIStreamToAnthropicNormalizer();
  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end();
    // No body means no terminal response event was ever possible either —
    // mirror collectOpenAIStreamAsAnthropicMessage's `!reader` case below
    // rather than reporting an empty stream as a success.
    return { message: "Upstream response had no body", explicit: true };
  }

  const decoder = new TextDecoder();
  let remainder = "";
  // Usage is applied once, after the stream ends: `applyCodexUsage`
  // accumulates into the process-wide totals, so calling it per terminal event
  // would double-count a stream that carried more than one. Mirrors
  // `createCodexUsageObserver`'s finish()-once contract.
  let totals: CodexUsageTotals | undefined;
  let failure: string | undefined;
  let completed = false;

  const inspect = (event: unknown): void => {
    totals = usageFromTerminalEvent(event) ?? totals;
    if (typeof event !== "object" || event === null) return;
    const typed = event as { type?: unknown; error?: { message?: string }; response?: { error?: { message?: string } } };
    if (typed.type === "response.failed") {
      failure = typed.response?.error?.message ?? "Response failed";
    } else if (typed.type === "error") {
      failure = typed.error?.message ?? "Upstream error event";
    } else if (terminalResponsePayload(event) !== undefined) {
      completed = true;
    }
  };

  const relayEvents = (events: unknown[]): void => {
    for (const event of events) {
      inspect(event);
      for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
        res.write(encodeSseEvent(mapped));
      }
    }
  };

  try {
    while (true) {
      // A client disconnect ends this loop through the upstream fetch: the
      // ingress aborts its signal, which rejects the pending read. That is the
      // cancellation path for every relay here — `sendUpstreamResponse` adds a
      // close-event race on top only because it also relays bodies that may
      // not honour the signal.
      const { value, done } = await reader.read();
      if (done) break;

      // Tolerant: one malformed frame must not abort the relay (which would
      // silently truncate the client's stream) nor discard the valid events
      // decoded from the same chunk.
      const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }), { tolerant: true });
      remainder = parsed.remainder;
      relayEvents(parsed.events);
    }

    const tail = decoder.decode();
    if (tail || remainder) {
      relayEvents(parseSseLines(remainder + tail + "\n", { tolerant: true }).events);
    }
  } finally {
    res.end();
    onUsage?.(totals);
  }
  // Mirrors collectOpenAIStreamAsAnthropicMessage: tolerant parsing skips a
  // malformed frame rather than aborting the relay, which also means a
  // malformed *terminal* frame (`response.completed` or `response.incomplete`)
  // would silently vanish. Without an observed terminal event the client
  // received a partial answer, not a finished one, so it is reported as a
  // failure (bytes already relayed to the client are unaffected — only the
  // status used for stats/activity changes). An explicit response.failed/error
  // message wins, since it says more about what went wrong.
  // `explicit` separates what upstream stated outright from what we inferred
  // from a stream that stopped: a client disconnect truncates the stream too,
  // so only the former is evidence the account itself failed.
  return {
    message: failure ?? (completed ? undefined : "Upstream stream ended without a terminal response event"),
    explicit: failure !== undefined,
  };
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
        relay: (upstream, res, entry) => sendOpenAIAsAnthropic(upstream, res, requestedStream, entry),
      });
    },
  );
}
