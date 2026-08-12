interface OpenAIStreamEvent {
  type?: string;
  delta?: string;
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

/**
 * Anthropic stop reason for a terminal Responses event. `response.incomplete`
 * ends the turn just as `response.completed` does — it is how the Responses API
 * reports a result that stopped early — and the output-token ceiling maps
 * directly onto Anthropic's own `max_tokens`. Any other incomplete reason still
 * delivered content, so `end_turn` stays the honest default.
 */
function anthropicStopReason(event: OpenAIStreamEvent): string {
  if (event.type !== "response.incomplete") return "end_turn";
  return event.response?.incomplete_details?.reason === "max_output_tokens"
    ? "max_tokens"
    : "end_turn";
}

type AnthropicStreamEvent = Record<string, unknown>;

export interface OpenAIStreamToAnthropicNormalizer {
  convert(event: OpenAIStreamEvent): AnthropicStreamEvent[];
  reset(): void;
}

export function createOpenAIStreamToAnthropicNormalizer(): OpenAIStreamToAnthropicNormalizer {
  let textBlockStarted = false;

  const ensureTextBlockStarted = (): AnthropicStreamEvent[] => {
    if (textBlockStarted) return [];
    textBlockStarted = true;
    return [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ];
  };

  const reset = () => {
    textBlockStarted = false;
  };

  return {
    reset,
    convert(event: OpenAIStreamEvent): AnthropicStreamEvent[] {
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

      if (event.type === "response.output_text.delta") {
        return [
          ...ensureTextBlockStarted(),
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: event.delta ?? "" },
          },
        ];
      }

      // Both terminal Responses events must close the Anthropic message.
      // Emitting nothing for `response.incomplete` would end the HTTP stream
      // without `message_stop`, leaving the client waiting on a turn that is
      // already over.
      if (event.type === "response.completed" || event.type === "response.incomplete") {
        const usage = event.response?.usage ?? {};
        const prefix = textBlockStarted
          ? [{ type: "content_block_stop", index: 0 }]
          : [];
        reset();
        return [
          ...prefix,
          {
            type: "message_delta",
            delta: { stop_reason: anthropicStopReason(event), stop_sequence: null },
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
