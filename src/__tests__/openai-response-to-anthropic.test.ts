import { describe, expect, it } from "vitest";
import { openAIResponseToAnthropicMessage } from "../protocol/openai-response-to-anthropic.js";
import { createOpenAIStreamToAnthropicNormalizer } from "../protocol/openai-stream-to-anthropic.js";

describe("openAIResponseToAnthropicMessage", () => {
  it("maps a completed OpenAI Responses JSON body to an Anthropic message JSON body", () => {
    expect(openAIResponseToAnthropicMessage({
      id: "resp_1",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Done." },
          ],
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    })).toEqual({
      id: "resp_1",
      type: "message",
      role: "assistant",
      model: "gpt-5.5",
      content: [
        { type: "text", text: "Done." },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    });
  });
  it("reports max_tokens for a response that stopped at the output-token ceiling", () => {
    const message = openAIResponseToAnthropicMessage({
      id: "resp_1",
      model: "gpt-5.6-luna",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Par" }],
      }],
      usage: { input_tokens: 4, output_tokens: 7 },
    });

    expect(message.stop_reason).toBe("max_tokens");
    expect(message.content).toEqual([{ type: "text", text: "Par" }]);
  });

  it("keeps end_turn for an incomplete response stopped for another reason", () => {
    expect(openAIResponseToAnthropicMessage({
      id: "resp_1",
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
    }).stop_reason).toBe("end_turn");
  });

  it("agrees with the streaming normalizer on the stop reason for the same turn", () => {
    // The two translation paths must not disagree about how a turn ended just
    // because the client asked for a stream.
    const response = {
      id: "resp_1",
      model: "gpt-5.6-luna",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      usage: { input_tokens: 4, output_tokens: 7 },
    };

    const collected = openAIResponseToAnthropicMessage(response);

    const normalizer = createOpenAIStreamToAnthropicNormalizer();
    normalizer.convert({ type: "response.created", response: { id: response.id } });
    const streamed = normalizer.convert({ type: "response.incomplete", response });
    const delta = streamed.find(e => e.type === "message_delta") as
      { delta?: { stop_reason?: string } } | undefined;

    expect(delta?.delta?.stop_reason).toBe(collected.stop_reason);
    expect(collected.stop_reason).toBe("max_tokens");
  });
});
