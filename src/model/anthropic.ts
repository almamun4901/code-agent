import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";

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
};

export type ModelTurn = {
  content: AssistantBlock[];
  stopReason: Message["stop_reason"];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
};

export type CallModel = (request: ModelRequest) => Promise<ModelTurn>;

type MessagesClient = {
  messages: {
    create(params: MessageCreateParamsNonStreaming): Promise<Message>;
  };
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

type AnthropicModelOptions = {
  apiKey?: string;
  model?: string;
  client?: MessagesClient;
};

const DEFAULT_MODEL = "claude-haiku-4-5";

/**
 * Build the Phase 1 model adapter.
 *
 * The returned function is deliberately provider-neutral: the loop supplies
 * normalized messages and receives normalized content blocks. Anthropic-only
 * types and error details stay inside this module so OpenRouter can replace
 * this adapter without changing the loop.
 */
export function createAnthropicModel(
  options: AnthropicModelOptions = {},
): CallModel {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;

  if (!options.client && !apiKey?.trim()) {
    throw new ModelConfigurationError(
      "ANTHROPIC_API_KEY is required. Add it to the local .env file; never commit the key.",
    );
  }

  const client: MessagesClient =
    options.client ??
    new Anthropic({
      apiKey,
      maxRetries: 2,
      timeout: 30_000,
    });
  const model =
    options.model?.trim() ||
    process.env.ANTHROPIC_MODEL?.trim() ||
    DEFAULT_MODEL;

  return async (request: ModelRequest): Promise<ModelTurn> => {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages.map(toAnthropicMessage),
        tools: request.tools.map(toAnthropicTool),
        tool_choice: {
          type: "auto",
          disable_parallel_tool_use: false,
        },
      });

      return {
        content: response.content.map((block): AssistantBlock => {
          if (block.type === "text") {
            return { type: "text", text: block.text };
          }

          if (block.type === "tool_use") {
            return {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            };
          }

          throw new ModelProviderError(
            `Claude returned unsupported content block type "${block.type}".`,
          );
        }),
        stopReason: response.stop_reason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      if (
        error instanceof ModelConfigurationError ||
        error instanceof ModelProviderError
      ) {
        throw error;
      }

      if (error instanceof Anthropic.APIError) {
        const detail = getSafeProviderDetail(error);
        throw new ModelProviderError(
          `Anthropic request failed (${error.status ?? "connection"})${
            detail ? `: ${detail}` : "."
          }`,
          error.status,
        );
      }

      throw new ModelProviderError("Anthropic request failed unexpectedly.");
    }
  };
}

/**
 * Preserve actionable API validation messages without forwarding the raw
 * response envelope, headers, or request data across the provider boundary.
 */
function getSafeProviderDetail(
  error: InstanceType<typeof Anthropic.APIError>,
): string | undefined {
  if (!error.status || error.status < 400 || error.status >= 500) {
    return undefined;
  }

  const envelope = error.error;
  if (!isRecord(envelope)) {
    return undefined;
  }

  const nestedError = envelope.error;
  const message =
    isRecord(nestedError) && typeof nestedError.message === "string"
      ? nestedError.message
      : typeof envelope.message === "string"
        ? envelope.message
        : undefined;

  if (!message) {
    return undefined;
  }

  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toAnthropicTool(tool: ModelToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    strict: tool.strict ?? true,
  };
}

function toAnthropicMessage(message: ConversationMessage): MessageParam {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }

  return {
    role: message.role,
    content: message.content.map(toAnthropicContentBlock),
  };
}

function toAnthropicContentBlock(
  block: AssistantBlock | UserBlock,
): ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
  }
}
