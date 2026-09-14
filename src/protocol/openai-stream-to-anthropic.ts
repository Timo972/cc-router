import { anthropicStopReasonForResponse } from "./openai-response-to-anthropic.js";
import { OpenAIProtocolError, parseOpenAIFunctionArguments } from "./openai-function-call.js";
import { terminalResponsePayload } from "./openai-responses-collect.js";

interface OpenAIStreamEventItem {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface OpenAIStreamEvent {
  type?: string;
  delta?: string;
  output_index?: number;
  arguments?: string;
  item?: OpenAIStreamEventItem;
  response?: {
    id?: string;
    model?: string;
    incomplete_details?: { reason?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}


type AnthropicStreamEvent = Record<string, unknown>;

export interface OpenAIStreamToAnthropicNormalizer {
  convert(event: OpenAIStreamEvent): AnthropicStreamEvent[];
  reset(): void;
}

interface OpenBlock {
  index: number;
  kind: "text" | "tool_use";
  sentArguments: boolean;
  argumentsJson: string;
}

export function createOpenAIStreamToAnthropicNormalizer(): OpenAIStreamToAnthropicNormalizer {
  let blocks = new Map<number, OpenBlock>();
  let nextIndex = 0;
  let sawToolUse = false;
  let sawRefusal = false;

  const openTextBlock = (outputIndex: number): AnthropicStreamEvent[] => {
    if (blocks.has(outputIndex)) return [];
    const block: OpenBlock = { index: nextIndex++, kind: "text", sentArguments: false, argumentsJson: "" };
    blocks.set(outputIndex, block);
    return [{
      type: "content_block_start",
      index: block.index,
      content_block: { type: "text", text: "" },
    }];
  };

  const closeBlock = (outputIndex: number): AnthropicStreamEvent[] => {
    const block = blocks.get(outputIndex);
    if (!block) return [];
    blocks.delete(outputIndex);
    return [{ type: "content_block_stop", index: block.index }];
  };

  const reset = () => {
    blocks = new Map();
    nextIndex = 0;
    sawToolUse = false;
    sawRefusal = false;
  };

  return {
    reset,
    convert(event: OpenAIStreamEvent): AnthropicStreamEvent[] {
      const outputIndex = event.output_index ?? 0;

      if (event.type === "response.created") {
        reset();
        return [
          {
            type: "message_start",
            message: {
              id: event.response?.id ?? "",
              type: "message",
              role: "assistant",
              model: event.response?.model ?? "",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
        ];
      }

      if (event.type === "response.output_item.added") {
        if (event.item?.type !== "function_call" || blocks.has(outputIndex)) return [];
        if (!event.item.call_id?.trim() || !event.item.name?.trim()) {
          throw new OpenAIProtocolError("Invalid OpenAI function call metadata");
        }
        const block: OpenBlock = {
          index: nextIndex++,
          kind: "tool_use",
          sentArguments: false,
          argumentsJson: "",
        };
        blocks.set(outputIndex, block);
        sawToolUse = true;
        return [{
          type: "content_block_start",
          index: block.index,
          content_block: {
            type: "tool_use",
            id: event.item.call_id,
            name: event.item.name,
            input: {},
          },
        }];
      }

      if (event.type === "response.output_text.delta") {
        const prefix = openTextBlock(outputIndex);
        const block = blocks.get(outputIndex);
        return [
          ...prefix,
          {
            type: "content_block_delta",
            index: block?.index ?? 0,
            delta: { type: "text_delta", text: event.delta ?? "" },
          },
        ];
      }

      if (event.type === "response.refusal.delta") {
        sawRefusal = true;
        const prefix = openTextBlock(outputIndex);
        const block = blocks.get(outputIndex);
        return [...prefix, {
          type: "content_block_delta",
          index: block?.index ?? 0,
          delta: { type: "text_delta", text: event.delta ?? "" },
        }];
      }

      if (event.type === "response.function_call_arguments.delta") {
        const block = blocks.get(outputIndex);
        if (!block || block.kind !== "tool_use") return [];
        block.sentArguments = true;
        block.argumentsJson += event.delta ?? "";
        return [{
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: event.delta ?? "" },
        }];
      }

      if (event.type === "response.function_call_arguments.done") {
        const block = blocks.get(outputIndex);
        if (!block || block.kind !== "tool_use" || block.sentArguments || !event.arguments) return [];
        block.sentArguments = true;
        block.argumentsJson = event.arguments;
        return [{
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: event.arguments },
        }];
      }

      if (event.type === "response.output_item.done") {
        const block = blocks.get(outputIndex);
        const atomicArguments = block?.kind === "tool_use" && !block.sentArguments
          ? event.item?.arguments ?? ""
          : "";
        if (block?.kind === "tool_use") {
          if (atomicArguments) block.argumentsJson = atomicArguments;
          parseOpenAIFunctionArguments(block.argumentsJson);
        }
        const argumentEvent = block?.kind === "tool_use" && atomicArguments
          ? [{
              type: "content_block_delta",
              index: block.index,
              delta: { type: "input_json_delta", partial_json: atomicArguments },
            }]
          : [];
        return [...argumentEvent, ...closeBlock(outputIndex)];
      }

      // Both terminal Responses events must close the Anthropic message.
      // Emitting nothing for `response.incomplete` would end the HTTP stream
      // without `message_stop`, leaving the client waiting on a turn that is
      // already over.
      //
      // The same predicate the collector and the usage observer use, not the
      // event type alone: a terminal frame carrying no response object
      // (`"response":null`, an array, a string) is not a result, and those two
      // already treat it as a failed stream. Closing the message here anyway
      // would emit `stop_reason: end_turn` — telling the client a truncated
      // turn ended normally, the one outcome worse than a truncated stream.
      // Emitting nothing ends the body without `message_stop`, which is what
      // a stream that never reached a terminal event looks like, and what
      // clients already detect and surface as an error.
      if (terminalResponsePayload(event) !== undefined) {
        if ([...blocks.values()].some(block => block.kind === "tool_use")) {
          throw new OpenAIProtocolError("OpenAI function call ended before completion");
        }
        const usage = event.response?.usage ?? {};
        const prefix = [...blocks.keys()].flatMap(closeBlock);
        const stopReason = sawToolUse
          ? "tool_use"
          : sawRefusal
            ? "refusal"
            : anthropicStopReasonForResponse(event.response);
        reset();
        return [
          ...prefix,
          {
            type: "message_delta",
            // Same helper the collected-response translator uses, so an
            // incomplete turn reports the same stop reason on both paths.
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: usage.output_tokens ?? 0 },
          },
          { type: "message_stop" },
        ];
      }

      return [];
    },
  };
}

const defaultNormalizer = createOpenAIStreamToAnthropicNormalizer();

export function resetOpenAIStreamNormalizer(): void {
  defaultNormalizer.reset();
}

export function openAIStreamEventToAnthropicEvents(event: OpenAIStreamEvent): AnthropicStreamEvent[] {
  return defaultNormalizer.convert(event);
}
