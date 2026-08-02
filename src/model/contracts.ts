export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultBlock = {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
};

export type AssistantBlock = TextBlock | ToolUseBlock;
export type UserBlock = TextBlock | ToolResultBlock;

export type ConversationMessage =
  | { role: "user"; content: string | UserBlock[] }
  | { role: "assistant"; content: AssistantBlock[] };

export type ModelToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  strict?: boolean;
};

export type ModelRequest = {
  system: string;
  messages: ConversationMessage[];
  tools: ModelToolDefinition[];
  maxTokens: number;
  mode?: "agent" | "summary";
};

export type ModelIdentity = {
  provider: "anthropic" | "openrouter" | "injected";
  model: string;
};

export type TokenEstimate = {
  tokens: number;
  source: "provider" | "conservative_local";
  fingerprint?: string;
};

export type ModelStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | "model_context_window_exceeded"
  | null;

export type ModelTurn = {
  content: AssistantBlock[];
  stopReason: ModelStopReason;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  actualIdentity?: ModelIdentity;
  providerCostMicroUsd?: number;
};

export type CallModelOptions = {
  signal?: AbortSignal;
};

export type CallModel = (
  request: ModelRequest,
  options?: CallModelOptions,
) => Promise<ModelTurn>;

export type ModelRuntime = {
  identity: ModelIdentity;
  countRequestTokens(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<TokenEstimate>;
  call: CallModel;
};

export class ModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigurationError";
  }
}

export class ModelProviderError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ModelProviderError";
    this.status = status;
  }
}

export class ModelRequestCancelledError extends Error {
  constructor(message = "Model request was cancelled.") {
    super(message);
    this.name = "ModelRequestCancelledError";
  }
}
