export type OpenAIInputRole = "system" | "user" | "assistant" | "tool";

export interface OpenAIInputText {
  type: "input_text";
  text: string;
}

export interface OpenAIOutputText {
  type: "output_text";
  text: string;
}

export interface OpenAIRefusal {
  type: "refusal";
  refusal: string;
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

export type OpenAIInputContent = OpenAIInputText | OpenAIOutputText;

export interface OpenAIInputMessage {
  role: OpenAIInputRole;
  content: OpenAIInputContent[];
}

// Responses function calls and their outputs are top-level input items.
export type OpenAIInputItem = OpenAIInputMessage | OpenAIFunctionCall | OpenAIFunctionCallOutput;

export interface OpenAITool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface OpenAIResponsesRequest {
  model: string;
  instructions?: string;
  input: OpenAIInputItem[];
  tools?: OpenAITool[];
  max_output_tokens?: number;
  stream?: boolean;
  store?: boolean;
}

export interface OpenAIResponseOutputMessage {
  type: "message";
  role?: "assistant";
  content: Array<OpenAIOutputText | OpenAIRefusal>;
}

export type OpenAIResponseOutputItem = OpenAIResponseOutputMessage | OpenAIFunctionCall;

export interface OpenAIResponseCompleted {
  id: string;
  model?: string;
  output?: OpenAIResponseOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}
