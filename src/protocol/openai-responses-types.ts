export type OpenAIInputRole = "system" | "user" | "assistant" | "tool";

export interface OpenAIInputText {
  type: "input_text";
  text: string;
}

export interface OpenAIOutputText {
  type: "output_text";
  text: string;
}

export interface OpenAIFunctionCall {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface OpenAIFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type OpenAIInputContent =
  | OpenAIInputText
  | OpenAIOutputText
  | OpenAIFunctionCall
  | OpenAIFunctionCallOutput;

export interface OpenAIInputMessage {
  role: OpenAIInputRole;
  content: OpenAIInputContent[];
}

export interface OpenAITool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface OpenAIResponsesRequest {
  model: string;
  instructions?: string;
  input: OpenAIInputMessage[];
  tools?: OpenAITool[];
  max_output_tokens?: number;
  stream?: boolean;
  store?: boolean;
  /** Codex thread id — stable per conversation; used for sticky routing and upstream cache routing. */
  prompt_cache_key?: string;
}

export interface OpenAIResponseOutputMessage {
  type: "message";
  role?: "assistant";
  content: OpenAIOutputText[];
}

export interface OpenAIResponseCompleted {
  id: string;
  model?: string;
  output?: OpenAIResponseOutputMessage[];
  /** `"completed"` | `"incomplete"` | `"failed"` | `"in_progress"`. */
  status?: string;
  /** Present when `status` is `"incomplete"` — e.g. `"max_output_tokens"`. */
  incomplete_details?: { reason?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}
