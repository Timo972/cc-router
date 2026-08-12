import type { OpenAIResponseCompleted } from "./openai-responses-types.js";

export type AnthropicStopReason = "end_turn" | "max_tokens";

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
  content: Array<{ type: "text"; text: string }>;
  stop_reason: AnthropicStopReason;
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export function openAIResponseToAnthropicMessage(response: OpenAIResponseCompleted): AnthropicMessageResponse {
  const content = (response.output ?? [])
    .filter(item => item.type === "message")
    .flatMap(item => item.content)
    .filter(item => item.type === "output_text")
    .map(item => ({ type: "text" as const, text: item.text }));

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model ?? "",
    content,
    stop_reason: anthropicStopReasonForResponse(response),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}
