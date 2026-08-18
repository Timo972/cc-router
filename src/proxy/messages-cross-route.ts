import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { selectRoute } from "../providers/route-selector.js";
import { anthropicToOpenAIResponses } from "../protocol/anthropic-to-openai.js";
import { openAIResponseToAnthropicMessage } from "../protocol/openai-response-to-anthropic.js";
import { createOpenAIStreamToAnthropicNormalizer } from "../protocol/openai-stream-to-anthropic.js";
import { createBoundedSseLineParser, encodeSseEvent } from "../protocol/sse.js";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import type { AnthropicMessagesRequest } from "../protocol/anthropic-types.js";
import type { OpenAIResponseCompleted, OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";
import {
  MAX_CODEX_COLLECTED_RESPONSE_BYTES,
  MAX_CODEX_STREAM_EVENT_BYTES,
  RESPONSE_SIZE_ERROR,
  readBodyWithinLimit,
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
import { sendAnthropicNoEligibleResponse, detectAnthropicClientSource } from "./anthropic-routing.js";
import type { OpenAIAccount } from "../providers/openai/account-state.js";
import type { OpenAITokenPool } from "../providers/openai/token-pool.js";
import {
  mirrorUpstreamHeaders,
  runOpenAIIngress,
  type ForwardOpenAI,
  type OpenAIIngressEnvelope,
  type OpenAIIngressRelayResult,
  type OpenAIIngressTelemetry,
  type OpenAIRelayReport,
} from "./openai-ingress.js";
import { annotateActiveSpan, recordUnexpectedException } from "../telemetry/facade.js";
import { writeResponseChunk } from "./response-write.js";

declare module "express-serve-static-core" {
  interface Request {
    _ccRawBody?: Buffer;
    _ccRouteContext?: RouteContext;
    _ccTelemetryStreaming?: boolean;
  }
}

export interface MessagesCrossProviderRouteOptions {
  openAIRouter: SessionRouter<OpenAIAccount>;
  openAIPool: OpenAITokenPool;
  prepareOpenAIAccount?: (account: OpenAIAccount) => Promise<boolean>;
  prepareOpenAIAccountOwnsDiagnostics?: boolean;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
  recordActivity?: (entry: LogEntry) => void;
  now?: () => number;
  onUpstreamAuthFailure?: (account: OpenAIAccount) => void;
  /** Injectable only for deterministic composition/privacy tests. */
  telemetry?: OpenAIIngressTelemetry;
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

function requestSource(req: Request): "cli" | "desktop" | "api" {
  if (req.headers["x-claude-code-session-id"] !== undefined) return "cli";
  if (req.headers["x-api-key"] !== undefined) return "desktop";
  return "api";
}

/** Longest upstream error snippet echoed back when the body isn't JSON. */
const MAX_UPSTREAM_ERROR_MESSAGE_LENGTH = 200;

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

function sendBoundedUpstreamFailure(
  res: Response,
  report: OpenAIRelayReport,
  message: string,
): OpenAIIngressRelayResult {
  report.upstreamReportedFailure = true;
  res.status(502).json({
    type: "error",
    error: { type: "upstream_error", message },
  });
  return { statusCode: 502 };
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
  report: OpenAIRelayReport,
  signal: AbortSignal,
): Promise<OpenAIIngressRelayResult> {
  const onUsage = (usage: CodexUsageTotals | undefined) => applyCodexUsage(entry, usage);

  // A non-OK response is never a Responses payload, whatever its content-type
  // — parsing it as an event stream or a completed response would translate a
  // real upstream failure (401/429/5xx) into an empty "success". Handle it
  // before any content-type dispatch and relay the upstream status verbatim
  // when its body is readable within the shared bound. A body overflow/read
  // failure is itself synthesized as the same safe 502 used by Responses.
  if (!upstream.ok) {
    const read = await readBodyWithinLimit(upstream, MAX_CODEX_COLLECTED_RESPONSE_BYTES, signal);
    // Mirror the safe upstream headers so a client can honor the server's
    // backoff: without Retry-After a 429 tells the caller to slow down but not
    // for how long. content-type is skipped for the same reason as the
    // /v1/responses collected path — res.json() below only sets it when unset,
    // so a mirrored value would silently win over the JSON envelope's own.
    mirrorUpstreamHeaders(upstream.headers, (key, value) => {
      if (key.toLowerCase() === "content-type") return;
      res.setHeader(key, value);
    });
    if (read.kind === "overflow") return sendBoundedUpstreamFailure(res, report, RESPONSE_SIZE_ERROR);
    if (read.kind === "cancelled") return { statusCode: upstream.status };
    if (read.kind === "error") return sendBoundedUpstreamFailure(res, report, "Malformed upstream stream");
    res.status(upstream.status).json({
      type: "error",
      error: {
        type: anthropicErrorTypeForStatus(upstream.status),
        message: extractUpstreamErrorMessage(read.body, upstream.status),
      },
    });
    report.upstreamReportedFailure = true;
    return { statusCode: upstream.status };
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    if (requestedStream) {
      // Headers are already flushed by the time a mid-stream failure surfaces,
      // so the client keeps the partial stream; reporting 502 here keeps the
      // activity log and error totals honest about what happened.
      const failure = await sendOpenAIStreamAsAnthropic(upstream, res, onUsage, report);
      return { statusCode: failure === undefined ? upstream.status : 502 };
    }

    const collected = await collectOpenAIStreamAsAnthropicMessage(upstream, report, signal);
    if (collected.cancelled) return { statusCode: upstream.status };
    onUsage(collected.usage);
    if (collected.failure !== undefined) {
      // Mirrors collectCodexResponseStream on the /v1/responses path: a stream
      // that ended in failure is a 502, never an empty 200 "success".
      res.status(502).json({
        type: "error",
        error: { type: "upstream_error", message: collected.failure },
      });
      return { statusCode: 502 };
    }
    res.status(upstream.status).json(collected.message);
    return { statusCode: upstream.status };
  }

  if (!contentType.includes("application/json")) {
    const read = await readBodyWithinLimit(upstream, MAX_CODEX_COLLECTED_RESPONSE_BYTES, signal);
    if (read.kind === "overflow") return sendBoundedUpstreamFailure(res, report, RESPONSE_SIZE_ERROR);
    if (read.kind === "cancelled") return { statusCode: upstream.status };
    if (read.kind === "error") return sendBoundedUpstreamFailure(res, report, "Malformed upstream stream");
    res.status(upstream.status);
    res.setHeader("content-type", contentType || "text/plain");
    res.send(read.body);
    return { statusCode: upstream.status };
  }

  // A successful JSON response with no body is intrinsically malformed. The
  // generic bounded reader treats a bodyless response observed after abort as
  // cancellation so bodyless text keeps its existing passthrough ownership;
  // classify the stricter JSON contract here before that transport-neutral
  // result can hide the upstream protocol failure.
  if (!upstream.body) {
    return sendBoundedUpstreamFailure(res, report, "Malformed upstream JSON body");
  }
  const read = await readBodyWithinLimit(upstream, MAX_CODEX_COLLECTED_RESPONSE_BYTES, signal);
  if (read.kind === "overflow") return sendBoundedUpstreamFailure(res, report, RESPONSE_SIZE_ERROR);
  if (read.kind === "cancelled") return { statusCode: upstream.status };
  if (read.kind === "error") return sendBoundedUpstreamFailure(res, report, "Malformed upstream stream");
  let json: OpenAIResponseCompleted;
  try {
    json = JSON.parse(read.body) as OpenAIResponseCompleted;
  } catch {
    return sendBoundedUpstreamFailure(res, report, "Malformed upstream JSON body");
  }
  onUsage(usageFromResponseBody(json));
  res.status(upstream.status).json(openAIResponseToAnthropicMessage(json));
  return { statusCode: upstream.status };
}

async function collectOpenAIStreamAsAnthropicMessage(
  upstream: globalThis.Response,
  report: OpenAIRelayReport,
  signal: AbortSignal,
): Promise<{
  message: ReturnType<typeof openAIResponseToAnthropicMessage>;
  usage: CodexUsageTotals | undefined;
  failure: string | undefined;
  cancelled?: boolean;
}> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    // An event-stream response with no body cannot have reached a terminal
    // event. Reporting it as a failure keeps the caller from fabricating an
    // empty 200 — and it is upstream's doing, not a truncation a client
    // disconnect could account for, so the ingress must not write it off as a
    // cancellation when both happen at once.
    report.upstreamReportedFailure = true;
    return {
      message: openAIResponseToAnthropicMessage({ id: "", model: "", output: [], usage: {} }),
      usage: undefined,
      failure: "Upstream response had no body",
    };
  }

  let cancelPromise: Promise<void> | undefined;
  const cancelReader = (): Promise<void> => {
    cancelPromise ??= reader.cancel().catch(() => undefined);
    return cancelPromise;
  };
  const onAbort = (): void => {
    void cancelReader();
  };
  const emptyMessage = () => openAIResponseToAnthropicMessage({
    id: "",
    model: "",
    output: [],
    usage: {},
  });
  const failCollection = async (message: string) => {
    report.upstreamReportedFailure = true;
    await cancelReader();
    return {
      message: emptyMessage(),
      usage: undefined,
      failure: message,
    };
  };
  const cancelCollection = async () => {
    await cancelReader();
    return {
      message: emptyMessage(),
      usage: undefined,
      failure: undefined,
      cancelled: true,
    };
  };

  if (signal.aborted) return cancelCollection();
  signal.addEventListener("abort", onAbort, { once: true });

  const parser = createBoundedSseLineParser(MAX_CODEX_STREAM_EVENT_BYTES, { tolerant: true });
  let id = "";
  let model = "";
  let text = "";
  let failure: string | undefined;
  let completed = false;
  let usage: OpenAIResponseCompleted["usage"] = {};
  let status: string | undefined;
  let incompleteDetails: { reason?: string } | undefined;
  let totalBytes = 0;
  let outputBytes = 0;
  let overflowed = false;
  let malformed = false;

  const applyEvent = (event: unknown) => {
    if (typeof event !== "object" || event === null) return;
    const openAIEvent = event as {
      type?: string;
      delta?: unknown;
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

    // Reported the moment it is seen, not when this function returns: the
    // read after it can be cut short by a client disconnect, and losing the
    // verdict there turns a real backend failure into a benign cancellation.
    if (openAIEvent.type === "response.failed") {
      failure = openAIEvent.response?.error?.message ?? "Response failed";
      report.upstreamReportedFailure = true;
      return;
    }

    if (openAIEvent.type === "error") {
      failure = openAIEvent.error?.message ?? "Upstream error event";
      report.upstreamReportedFailure = true;
      return;
    }

    if (openAIEvent.type === "response.created") {
      id = openAIEvent.response?.id ?? id;
      model = openAIEvent.response?.model ?? model;
      return;
    }

    if (openAIEvent.type === "response.output_text.delta") {
      const delta = openAIEvent.delta;
      if (typeof delta !== "string") {
        malformed = true;
        return;
      }
      outputBytes += Buffer.byteLength(delta);
      if (outputBytes > MAX_CODEX_COLLECTED_RESPONSE_BYTES) {
        overflowed = true;
        return;
      }
      text += delta;
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

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_CODEX_COLLECTED_RESPONSE_BYTES) {
        return await failCollection(RESPONSE_SIZE_ERROR);
      }
      const result = await parser.push(value, event => {
        applyEvent(event);
        return !overflowed && !malformed;
      });
      if (malformed) return await failCollection("Malformed upstream stream");
      if (result === "overflow" || overflowed) {
        return await failCollection(RESPONSE_SIZE_ERROR);
      }
    }

    const finished = await parser.finish(event => {
      applyEvent(event);
      return !overflowed && !malformed;
    });
    if (malformed) return await failCollection("Malformed upstream stream");
    if (finished === "overflow" || overflowed) {
      return await failCollection(RESPONSE_SIZE_ERROR);
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
    };
  } catch {
    if (signal.aborted && !report.upstreamReportedFailure) return await cancelCollection();
    return await failCollection(failure ?? "Malformed upstream stream");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Returns the upstream failure message when the stream ended in one. */
async function sendOpenAIStreamAsAnthropic(
  upstream: globalThis.Response,
  res: Response,
  onUsage: ((usage: CodexUsageTotals | undefined) => void) | undefined,
  report: OpenAIRelayReport,
): Promise<string | undefined> {
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
    report.upstreamReportedFailure = true;
    return "Upstream response had no body";
  }

  const parser = createBoundedSseLineParser(MAX_CODEX_STREAM_EVENT_BYTES, { tolerant: true });
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
    // Recorded as observed — an aborted read can reject on the very next
    // chunk, and this verdict has to outlive that.
    if (typed.type === "response.failed") {
      failure = typed.response?.error?.message ?? "Response failed";
      report.upstreamReportedFailure = true;
    } else if (typed.type === "error") {
      failure = typed.error?.message ?? "Upstream error event";
      report.upstreamReportedFailure = true;
    } else if (terminalResponsePayload(event) !== undefined) {
      completed = true;
    }
  };

  let readerFinished = false;
  let readerCancelled = false;
  const cancelReader = async (): Promise<void> => {
    if (readerFinished || readerCancelled) return;
    readerCancelled = true;
    await reader.cancel().catch(() => undefined);
  };

  const relayEvent = async (event: unknown): Promise<boolean> => {
    inspect(event);
    for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
      if (!await writeResponseChunk(res, encodeSseEvent(mapped))) {
        await cancelReader();
        return false;
      }
    }
    return true;
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

      if (!value) continue;
      // Tolerant: one malformed frame must not abort the relay (which would
      // silently truncate the client's stream) nor discard the valid events
      // decoded from the same chunk. Oversized framing is different: retaining
      // it would be unbounded, so cancel the source and report a closed failure.
      const parsed = await parser.push(value, relayEvent);
      if (parsed === "overflow") {
        failure = RESPONSE_SIZE_ERROR;
        report.upstreamReportedFailure = true;
        await cancelReader();
        break;
      }
      if (parsed === "stopped") break;
    }

    if (!readerCancelled) {
      readerFinished = true;
      const parsed = await parser.finish(relayEvent);
      if (parsed === "overflow") {
        failure = RESPONSE_SIZE_ERROR;
        report.upstreamReportedFailure = true;
      }
    }
  } catch (error) {
    await cancelReader();
    throw error;
  } finally {
    if (!res.destroyed && !res.writableEnded) res.end();
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
  return failure ?? (completed ? undefined : "Upstream stream ended without a terminal response event");
}

export function mountMessagesCrossProviderRoute(
  app: Express,
  opts: MessagesCrossProviderRouteOptions,
): void {
  const forwardOpenAI = opts.forwardOpenAI ?? forwardOpenAICodexResponse;
  const forwardOpenAIOwnsDiagnostics = opts.forwardOpenAI === undefined;
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
        annotateActiveSpan("proxy.request", {
          httpMethod: "POST",
          provider: "other",
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
      req._ccTelemetryStreaming = req.body.stream === true;
      const route = selectRoute(requestedModel, opts.modelRouting);
      if (route.provider !== "openai_subscription") {
        req._ccRouteContext = extractAnthropicRouteContext(requestedModel, opts.modelRouting);
        next();
        return;
      }

      let body: OpenAIResponsesRequest;
      try {
        body = anthropicToOpenAIResponses(req.body, opts.modelRouting);
      } catch (error) {
        recordUnexpectedException(error, {
          category: "runtime",
          reason: "other",
          operation: "proxy.request",
          provider: "openai",
        });
        next(error);
        return;
      }
      const requestedStream = req.body.stream === true;

      await runOpenAIIngress({
        res,
        sessionKey: extractCodexSessionKey(req, req.body),
        requestedModel: route.upstreamModel,
        path: "/v1/messages",
        requestSource: requestSource(req),
        method: req.method,
        // A Claude-shaped client that happens to route to an OpenAI backend is
        // still that client — classify it the way the Claude path does.
        source: detectAnthropicClientSource(req.headers),
        openAIRouter: opts.openAIRouter,
        openAIPool: opts.openAIPool,
        prepareOpenAIAccount,
        forwardOpenAI,
        forwardBody: body,
        recordActivity,
        now,
        envelope: MESSAGES_ENVELOPE,
        onUpstreamAuthFailure: opts.onUpstreamAuthFailure,
        prepareOpenAIAccountOwnsDiagnostics: opts.prepareOpenAIAccountOwnsDiagnostics === true,
        forwardOpenAIOwnsDiagnostics,
        telemetry: opts.telemetry,
        relay: (upstream, res, entry, report, signal) =>
          sendOpenAIAsAnthropic(upstream, res, requestedStream, entry, report, signal),
      });
    },
  );
}
