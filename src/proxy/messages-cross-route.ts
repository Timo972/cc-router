import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { selectRoute } from "../providers/route-selector.js";
import { anthropicToOpenAIResponses } from "../protocol/anthropic-to-openai.js";
import { openAIResponseToAnthropicMessage } from "../protocol/openai-response-to-anthropic.js";
import { OpenAIProtocolError } from "../protocol/openai-function-call.js";
import { createOpenAIStreamToAnthropicNormalizer } from "../protocol/openai-stream-to-anthropic.js";
import { encodeSseEvent, parseSseLines } from "../protocol/sse.js";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import type { AnthropicMessagesRequest } from "../protocol/anthropic-types.js";
import type { OpenAIFunctionCall, OpenAIResponseCompleted, OpenAIResponseOutputItem } from "../protocol/openai-responses-types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";

declare module "express-serve-static-core" {
  interface Request {
    _ccRawBody?: Buffer;
  }
}

type ForwardOpenAI = typeof forwardOpenAICodexResponse;

export interface MessagesCrossProviderRouteOptions {
  getOpenAIAccount: () => OpenAISubscriptionAccount | null;
  prepareOpenAIAccount?: (account: OpenAISubscriptionAccount) => Promise<boolean>;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
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
): Promise<void> {
  try {
    const contentType = upstream.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      if (requestedStream) {
        await sendOpenAIStreamAsAnthropic(upstream, res);
        return;
      }

      res.status(upstream.status).json(await collectOpenAIStreamAsAnthropicMessage(upstream));
      return;
    }

    if (!contentType.includes("application/json")) {
      res.status(upstream.status);
      res.setHeader("content-type", contentType || "text/plain");
      res.send(await upstream.text());
      return;
    }

    const json = await upstream.json() as OpenAIResponseCompleted;
    res.status(upstream.status).json(openAIResponseToAnthropicMessage(json));
  } catch (error) {
    if (!(error instanceof OpenAIProtocolError) || res.headersSent) throw error;
    res.status(502).json({
      type: "error",
      error: {
        type: "api_error",
        message: "Invalid or incomplete response from OpenAI",
      },
    });
  }
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
  let usage: OpenAIResponseCompleted["usage"] = {};
  let completed = false;
  const textByIndex = new Map<number, string>();
  const refusalByIndex = new Map<number, string>();
  const argumentsByIndex = new Map<number, string>();
  const pendingCallsByIndex = new Map<number, OpenAIFunctionCall>();
  const callsByIndex = new Map<number, OpenAIFunctionCall>();

  const applyEvent = (event: unknown) => {
    if (typeof event !== "object" || event === null) return;
    const openAIEvent = event as {
      type?: string;
      delta?: string;
      arguments?: string;
      output_index?: number;
      item?: { type?: string; call_id?: string; name?: string; arguments?: string };
      response?: {
        id?: string;
        model?: string;
        usage?: OpenAIResponseCompleted["usage"];
      };
    };
    const outputIndex = openAIEvent.output_index ?? 0;

    if (openAIEvent.type === "response.created") {
      id = openAIEvent.response?.id ?? id;
      model = openAIEvent.response?.model ?? model;
      return;
    }

    if (openAIEvent.type === "response.output_text.delta") {
      textByIndex.set(outputIndex, (textByIndex.get(outputIndex) ?? "") + (openAIEvent.delta ?? ""));
      return;
    }

    if (openAIEvent.type === "response.refusal.delta") {
      refusalByIndex.set(outputIndex, (refusalByIndex.get(outputIndex) ?? "") + (openAIEvent.delta ?? ""));
      return;
    }

    if (openAIEvent.type === "response.output_item.added") {
      const item = openAIEvent.item;
      if (item?.type === "function_call") {
        if (!item.call_id?.trim() || !item.name?.trim()) {
          throw new OpenAIProtocolError("Invalid OpenAI function call metadata");
        }
        pendingCallsByIndex.set(outputIndex, {
          type: "function_call",
          call_id: item.call_id,
          name: item.name,
          arguments: item.arguments ?? "",
        });
      }
      return;
    }

    if (openAIEvent.type === "response.function_call_arguments.delta") {
      if (!pendingCallsByIndex.has(outputIndex)) return;
      argumentsByIndex.set(outputIndex, (argumentsByIndex.get(outputIndex) ?? "") + (openAIEvent.delta ?? ""));
      return;
    }

    if (openAIEvent.type === "response.function_call_arguments.done") {
      if (pendingCallsByIndex.has(outputIndex) && !argumentsByIndex.has(outputIndex) && openAIEvent.arguments) {
        argumentsByIndex.set(outputIndex, openAIEvent.arguments);
      }
      return;
    }

    if (openAIEvent.type === "response.output_item.done") {
      const item = openAIEvent.item;
      const pending = pendingCallsByIndex.get(outputIndex);
      if (item?.type === "function_call" || pending) {
        const callId = item?.call_id || pending?.call_id;
        const name = item?.name || pending?.name;
        if (!callId?.trim() || !name?.trim()) {
          throw new OpenAIProtocolError("Invalid OpenAI function call metadata");
        }
        callsByIndex.set(outputIndex, {
          type: "function_call",
          call_id: callId,
          name,
          arguments: item?.arguments || argumentsByIndex.get(outputIndex) || pending?.arguments || "",
        });
        pendingCallsByIndex.delete(outputIndex);
      }
      return;
    }

    if (openAIEvent.type === "response.completed") {
      completed = true;
      id = openAIEvent.response?.id ?? id;
      model = openAIEvent.response?.model ?? model;
      usage = openAIEvent.response?.usage ?? usage;
      return;
    }

    if (openAIEvent.type === "response.failed" || openAIEvent.type === "response.incomplete") {
      throw new OpenAIProtocolError("OpenAI response stream did not complete successfully");
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

  if (!completed || pendingCallsByIndex.size > 0) {
    throw new OpenAIProtocolError("OpenAI response stream ended before completion");
  }

  const output: OpenAIResponseOutputItem[] = [...new Set([
    ...textByIndex.keys(),
    ...refusalByIndex.keys(),
    ...callsByIndex.keys(),
  ])]
    .sort((a, b) => a - b)
    .flatMap((index): OpenAIResponseOutputItem[] => {
      const call = callsByIndex.get(index);
      if (call) return [{ ...call, arguments: call.arguments || argumentsByIndex.get(index) || "" }];
      const text = textByIndex.get(index);
      const refusal = refusalByIndex.get(index);
      const content = [
        ...(text ? [{ type: "output_text" as const, text }] : []),
        ...(refusal ? [{ type: "refusal" as const, refusal }] : []),
      ];
      return content.length > 0 ? [{
        type: "message",
        role: "assistant",
        content,
      }] : [];
    });

  return openAIResponseToAnthropicMessage({ id, model, output, usage });
}

async function sendOpenAIStreamAsAnthropic(upstream: globalThis.Response, res: Response): Promise<void> {
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
  let completed = false;

  const writeProtocolError = () => {
    res.write(encodeSseEvent({
      type: "error",
      error: {
        type: "api_error",
        message: "Invalid or incomplete response from OpenAI",
      },
    }));
  };

  const forwardEvent = (event: unknown) => {
    const eventType = typeof event === "object" && event !== null
      ? (event as { type?: unknown }).type
      : undefined;
    if (eventType === "response.completed") completed = true;
    for (const mapped of normalizer.convert(event as Parameters<typeof normalizer.convert>[0])) {
      res.write(encodeSseEvent(mapped));
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }));
      remainder = parsed.remainder;
      for (const event of parsed.events) {
        forwardEvent(event);
      }
    }

    const tail = decoder.decode();
    if (tail || remainder) {
      const parsed = parseSseLines(remainder + tail + "\n");
      for (const event of parsed.events) {
        forwardEvent(event);
      }
    }

    if (!completed) {
      writeProtocolError();
    }
  } catch (error) {
    if (!(error instanceof OpenAIProtocolError)) throw error;
    writeProtocolError();
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

      const route = selectRoute(req.body.model, opts.modelRouting);
      if (route.provider !== "openai_subscription") {
        next();
        return;
      }

      const account = opts.getOpenAIAccount();
      if (!account) {
        res.status(503).json({
          type: "error",
          error: {
            type: "no_accounts",
            message: "No OpenAI subscription accounts are configured",
          },
        });
        return;
      }

      const ready = await prepareOpenAIAccount(account);
      if (!ready) {
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
      const upstream = await forwardOpenAI({
        account,
        body,
        stream: body.stream === true,
      });
      await sendOpenAIAsAnthropic(upstream, res, req.body.stream === true);
    },
  );
}
