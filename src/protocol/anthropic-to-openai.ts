import type { AnthropicContent, AnthropicMessagesRequest } from "./anthropic-types.js";
import type { OpenAIInputItem, OpenAIInputRole, OpenAIResponsesRequest } from "./openai-responses-types.js";
import { parseModelRef } from "./model-ref.js";
import type { ModelRoutingConfig } from "./model-ref.js";

function stringifySystem(system: AnthropicMessagesRequest["system"]): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return system.map(block => block.text).join("\n");
}

function messageToOpenAIItems(role: OpenAIInputRole, content: AnthropicContent): OpenAIInputItem[] {
  const textType = role === "assistant" ? "output_text" as const : "input_text" as const;
  if (typeof content === "string") {
    return [{ role, content: [{ type: textType, text: content }] }];
  }

  const items: OpenAIInputItem[] = [];
  let pendingText: Array<{ type: typeof textType; text: string }> = [];
  const flushText = () => {
    if (pendingText.length === 0) return;
    items.push({ role, content: pendingText });
    pendingText = [];
  };

  for (const block of content) {
    if (block.type === "text") {
      pendingText.push({ type: textType, text: block.text });
      continue;
    }

    flushText();
    if (block.type === "tool_use") {
      items.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
      continue;
    }

    items.push({
      type: "function_call_output",
      call_id: block.tool_use_id,
      output: typeof block.content === "string"
        ? block.content
        : block.content.map(item => item.text).join("\n"),
    });
  }

  flushText();
  return items;
}

export function anthropicToOpenAIResponses(
  req: AnthropicMessagesRequest,
  modelRouting: ModelRoutingConfig = {},
): OpenAIResponsesRequest {
  const parsed = parseModelRef(req.model, modelRouting);
  return {
    model: parsed.upstreamModel,
    instructions: stringifySystem(req.system),
    input: req.messages.flatMap(message => messageToOpenAIItems(message.role, message.content)),
    tools: req.tools?.map(tool => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    })),
    max_output_tokens: req.max_tokens,
    stream: req.stream,
  };
}
