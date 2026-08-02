import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import {
  ModelConfigurationError,
  ModelProviderError,
  ModelRequestCancelledError,
  type AssistantBlock,
  type CallModel,
  type ConversationMessage,
  type ModelRequest,
  type ModelRuntime,
  type ModelToolDefinition,
  type UserBlock,
} from "./contracts";
export {
  ModelConfigurationError,
  ModelProviderError,
  ModelRequestCancelledError,
} from "./contracts";
export type {
  AssistantBlock,
  CallModel,
  CallModelOptions,
  ConversationMessage,
  ModelRequest,
  ModelStopReason,
  ModelToolDefinition,
  ModelTurn,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  UserBlock,
} from "./contracts";

type MessagesClient = {
  messages: {
    create(
      params: MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Message>;
    countTokens?(
      params: Omit<MessageCreateParamsNonStreaming, "max_tokens">,
      options?: { signal?: AbortSignal },
    ): Promise<{ input_tokens: number }>;
  };
};

type AnthropicModelOptions = {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  client?: MessagesClient;
};

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_TIMEOUT_MS = 60_000;

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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ModelConfigurationError(
      "Anthropic timeoutMs must be a positive integer.",
    );
  }

  const client: MessagesClient =
    options.client ??
    new Anthropic({
      apiKey,
      maxRetries: 0,
      timeout: timeoutMs,
    });
  const model =
    options.model?.trim() ||
    process.env.ANTHROPIC_MODEL?.trim() ||
    DEFAULT_MODEL;

  return async (request, callOptions = {}) => {
    try {
      const response = await client.messages.create(
        {
          model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: request.messages.map(toAnthropicMessage),
          ...(request.tools.length > 0
            ? {
                tools: request.tools.map(toAnthropicTool),
                tool_choice: {
                  type: "auto" as const,
                  disable_parallel_tool_use: false,
                },
              }
            : {}),
        },
        callOptions.signal ? { signal: callOptions.signal } : undefined,
      );

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
        callOptions.signal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw new ModelRequestCancelledError();
      }
      if (
        error instanceof ModelConfigurationError ||
        error instanceof ModelProviderError ||
        error instanceof ModelRequestCancelledError
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

export function createAnthropicRuntime(
  options: AnthropicModelOptions = {},
): ModelRuntime {
  const model = options.model?.trim() || process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  const call = createAnthropicModel({ ...options, model });
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const client: MessagesClient = options.client ?? new Anthropic({
    apiKey,
    maxRetries: 0,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return {
    identity: { provider: "anthropic", model },
    async countRequestTokens(request, signal) {
      if (!client.messages.countTokens) {
        throw new ModelProviderError("Anthropic token counting is unavailable.");
      }
      const response = await client.messages.countTokens({
        model,
        system: request.system,
        messages: request.messages.map(toAnthropicMessage),
        ...(request.tools.length > 0 ? { tools: request.tools.map(toAnthropicTool) } : {}),
      }, signal ? { signal } : undefined);
      return { tokens: response.input_tokens, source: "provider" };
    },
    async call(request, callOptions) {
      const turn = await call(request, callOptions);
      return {
        ...turn,
        actualIdentity: { provider: "anthropic", model },
      };
    },
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
