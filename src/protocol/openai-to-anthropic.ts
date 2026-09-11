import type {
  AnthropicContent,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "./anthropic-types.js";
import type {
  OpenAIFunctionCall,
  OpenAIFunctionCallOutput,
  OpenAIInputContent,
  OpenAIInputItem,
  OpenAIInputMessage,
  OpenAIResponsesRequest,
} from "./openai-responses-types.js";
import { parseModelRef } from "./model-ref.js";

function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return { value: args };
  }
}

function textFromOpenAI(block: OpenAIInputContent): string {
  return block.text;
}

function messageContentToAnthropic(message: OpenAIInputMessage): AnthropicContent {
  const blocks = message.content.map((block): AnthropicTextBlock => ({
    type: "text",
    text: textFromOpenAI(block),
  }));
  if (blocks.length === 1) return blocks[0].text;
  return blocks;
}

function normalizeRole(role: OpenAIInputMessage["role"]): "user" | "assistant" {
  return role === "assistant" ? "assistant" : "user";
}

type AnthropicMessage = AnthropicMessagesRequest["messages"][number];
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

function isFunctionCall(item: OpenAIInputItem): item is OpenAIFunctionCall {
  return "type" in item && item.type === "function_call";
}

function isFunctionCallOutput(item: OpenAIInputItem): item is OpenAIFunctionCallOutput {
  return "type" in item && item.type === "function_call_output";
}

function inputItemsToAnthropicMessages(input: OpenAIInputItem[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  const append = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last?.role === role) {
      const existing = typeof last.content === "string"
        ? [{ type: "text" as const, text: last.content }]
        : last.content;
      last.content = [...existing, ...blocks];
      return;
    }
    messages.push({ role, content: blocks });
  };

  for (const item of input) {
    if (isFunctionCall(item)) {
      append("assistant", [{
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: parseArguments(item.arguments),
      }]);
    } else if (isFunctionCallOutput(item)) {
      append("user", [{ type: "tool_result", tool_use_id: item.call_id, content: item.output }]);
    } else {
      const content = messageContentToAnthropic(item);
      append(normalizeRole(item.role), typeof content === "string"
        ? [{ type: "text", text: content }]
        : content);
    }
  }

  return messages.map(message => {
    if (Array.isArray(message.content) && message.content.length === 1 && message.content[0].type === "text") {
      return { ...message, content: message.content[0].text };
    }
    return message;
  });
}

export function openAIResponsesToAnthropic(req: OpenAIResponsesRequest): AnthropicMessagesRequest {
  const parsed = parseModelRef(req.model);
  return {
    model: parsed.upstreamModel,
    system: req.instructions,
    messages: inputItemsToAnthropicMessages(req.input),
    tools: req.tools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    max_tokens: req.max_output_tokens,
    stream: req.stream,
  };
}
