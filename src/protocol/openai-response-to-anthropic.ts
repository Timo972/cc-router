import type { OpenAIResponseCompleted } from "./openai-responses-types.js";
import { OpenAIProtocolError, parseOpenAIFunctionArguments } from "./openai-function-call.js";

export type AnthropicStopReason = "end_turn" | "max_tokens" | "tool_use" | "refusal";

export type AnthropicResponseContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

/**
 * Anthropic stop reason for a terminal Responses payload. Shared by both
 * translation paths — this module for a collected response, and the streaming
 * normalizer for a terminal SSE event — so a turn that ends the same way is
 * reported the same way whether or not the client asked for a stream.
 *
 * Keys off `incomplete_details` rather than the event type or `status`: a
 * completed response carries none, so the same call is correct for both, and
 * the output-token ceiling is the one reason that maps onto an Anthropic stop
 * reason of its own. Any other incomplete reason still delivered content, so
 * `end_turn` stays the honest default.
 */
export function anthropicStopReasonForResponse(
  response: { incomplete_details?: { reason?: string } } | undefined,
): AnthropicStopReason {
  return response?.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "end_turn";
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicResponseContentBlock[];
  stop_reason: AnthropicStopReason;
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export function openAIResponseToAnthropicMessage(response: OpenAIResponseCompleted): AnthropicMessageResponse {
  const content: AnthropicResponseContentBlock[] = [];
  let sawRefusal = false;

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "refusal") {
          sawRefusal = true;
          content.push({ type: "text", text: part.refusal });
        }
      }
      continue;
    }

    if (item.type !== "function_call") continue;
    if (!item.call_id?.trim() || !item.name?.trim()) {
      throw new OpenAIProtocolError("Invalid OpenAI function call metadata");
    }
    content.push({
      type: "tool_use",
      id: item.call_id,
      name: item.name,
      input: parseOpenAIFunctionArguments(item.arguments),
    });
  }

  const stopReason = content.some(block => block.type === "tool_use")
    ? "tool_use"
    : sawRefusal
      ? "refusal"
      : anthropicStopReasonForResponse(response);

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model ?? "",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}
