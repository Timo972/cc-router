import type { OpenAIResponseCompleted } from "./openai-responses-types.js";
import { OpenAIProtocolError, parseOpenAIFunctionArguments } from "./openai-function-call.js";

export type AnthropicResponseContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicResponseContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "refusal";
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

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model ?? "",
    content,
    stop_reason: content.some(block => block.type === "tool_use")
      ? "tool_use"
      : sawRefusal
        ? "refusal"
        : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}
