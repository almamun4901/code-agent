import { z } from "zod";
import {
  ModelConfigurationError,
  ModelProviderError,
  ModelRequestCancelledError,
  type AssistantBlock,
  type CallModel,
  type ConversationMessage,
  type ModelRequest,
  type ModelStopReason,
  type ModelToolDefinition,
} from "./contracts";

const OPENROUTER_CHAT_ENDPOINT =
  "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const toolCallSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().min(1),
        arguments: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const generationErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    metadata: z
      .object({
        error_type: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const completionSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            finish_reason: z.string().nullable(),
            error: generationErrorSchema.optional(),
            message: z
              .object({
                role: z.literal("assistant"),
                content: z.string().nullable().optional(),
                tool_calls: z.array(toolCallSchema).optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();

const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

type OpenRouterModelOptions = {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
};

export function createOpenRouterModel(
  options: OpenRouterModelOptions = {},
): CallModel {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey?.trim()) {
    throw new ModelConfigurationError(
      "OPENROUTER_API_KEY is required. Add it to the local .env file; never commit the key.",
    );
  }

  const model =
    options.model?.trim() ||
    process.env.OPENROUTER_MODEL?.trim() ||
    DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new ModelConfigurationError(
      "OpenRouter timeoutMs must be a positive integer.",
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (request, callOptions = {}) => {
    if (callOptions.signal?.aborted) {
      throw new ModelRequestCancelledError();
    }

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = callOptions.signal
      ? AbortSignal.any([callOptions.signal, timeout.signal])
      : timeout.signal;

    try {
      const response = await fetchImpl(OPENROUTER_CHAT_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toOpenRouterRequest(request, model)),
        signal,
      });
      const serialized = await readBoundedResponse(response);

      if (!response.ok) {
        const decoded = tryParseJson(serialized);
        throw new ModelProviderError(
          formatHttpError(response.status, decoded),
          response.status,
        );
      }

      const decoded = parseJson(serialized);
      const parsed = completionSchema.safeParse(decoded);
      if (!parsed.success) {
        throw new ModelProviderError(
          "OpenRouter returned an invalid completion response.",
        );
      }
      return normalizeCompletion(parsed.data);
    } catch (error) {
      if (callOptions.signal?.aborted) {
        throw new ModelRequestCancelledError();
      }
      if (timeout.signal.aborted) {
        throw new ModelProviderError(
          `OpenRouter request timed out after ${timeoutMs}ms.`,
        );
      }
      if (
        error instanceof ModelConfigurationError ||
        error instanceof ModelProviderError ||
        error instanceof ModelRequestCancelledError
      ) {
        throw error;
      }
      throw new ModelProviderError(
        "OpenRouter request failed unexpectedly.",
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

function toOpenRouterRequest(request: ModelRequest, model: string) {
  return {
    model,
    messages: [
      { role: "system", content: request.system },
      ...request.messages.flatMap(toOpenRouterMessages),
    ],
    tools: request.tools.map(toOpenRouterTool),
    tool_choice: "auto",
    max_tokens: request.maxTokens,
    provider: {
      require_parameters: true,
      data_collection: "deny",
    },
    stream: false,
  };
}

function toOpenRouterTool(tool: ModelToolDefinition) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: tool.strict ?? true,
    },
  };
}

function toOpenRouterMessages(message: ConversationMessage): unknown[] {
  if (typeof message.content === "string") {
    return [{ role: message.role, content: message.content }];
  }

  if (message.role === "assistant") {
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const toolCalls = message.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      }));
    return [
      {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    ];
  }

  const messages: unknown[] = [];
  let text: string[] = [];
  const flushText = () => {
    if (text.length === 0) return;
    messages.push({ role: "user", content: text.join("\n") });
    text = [];
  };
  for (const block of message.content) {
    if (block.type === "text") {
      text.push(block.text);
      continue;
    }
    flushText();
    messages.push({
      role: "tool",
      tool_call_id: block.toolUseId,
      content: block.content,
    });
  }
  flushText();
  return messages.length > 0 ? messages : [{ role: "user", content: "" }];
}

function normalizeCompletion(
  completion: z.infer<typeof completionSchema>,
) {
  const choice =
    completion.choices.find((candidate) => candidate.index === 0) ??
    completion.choices[0]!;
  if (choice.finish_reason === "error") {
    const code = choice.error?.code;
    const errorType = choice.error?.metadata?.error_type;
    throw new ModelProviderError(
      `OpenRouter generation failed${
        code === undefined ? "" : ` (${code})`
      }${errorType ? `: ${errorType}` : "."}`,
      code,
    );
  }
  const toolCalls = choice.message.tool_calls ?? [];
  const stopReason = normalizeStopReason(choice.finish_reason);
  if (
    (stopReason === "tool_use" && toolCalls.length === 0) ||
    (stopReason !== "tool_use" && toolCalls.length > 0)
  ) {
    throw new ModelProviderError(
      "OpenRouter returned inconsistent tool calls and finish reason.",
    );
  }

  const content: AssistantBlock[] = [];
  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  for (const toolCall of toolCalls) {
    let input: unknown;
    try {
      input = JSON.parse(toolCall.function.arguments);
    } catch {
      throw new ModelProviderError(
        `OpenRouter returned invalid JSON arguments for tool "${toolCall.function.name}".`,
      );
    }
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input,
    });
  }
  if (content.length === 0) {
    throw new ModelProviderError(
      "OpenRouter returned an empty assistant message.",
    );
  }

  return {
    content,
    stopReason,
    usage: {
      inputTokens: completion.usage.prompt_tokens,
      outputTokens: completion.usage.completion_tokens,
    },
  };
}

function normalizeStopReason(reason: string | null): ModelStopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case null:
      return null;
    default:
      throw new ModelProviderError(
        `OpenRouter returned unsupported finish reason "${reason}".`,
      );
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_RESPONSE_BYTES
  ) {
    throw new ModelProviderError(
      "OpenRouter response exceeded the maximum allowed size.",
      response.status || undefined,
    );
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let serialized = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ModelProviderError(
        "OpenRouter response exceeded the maximum allowed size.",
        response.status || undefined,
      );
    }
    serialized += decoder.decode(value, { stream: true });
  }
  return serialized + decoder.decode();
}

function parseJson(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    throw new ModelProviderError(
      "OpenRouter returned a non-JSON response.",
    );
  }
}

function tryParseJson(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    return undefined;
  }
}

function formatHttpError(status: number, decoded: unknown): string {
  const parsed = errorEnvelopeSchema.safeParse(decoded);
  const detail =
    status >= 400 && status < 500 && parsed.success
      ? normalizeSafeDetail(parsed.data.error.message)
      : undefined;
  return `OpenRouter request failed (${status})${detail ? `: ${detail}` : "."}`;
}

function normalizeSafeDetail(
  message: string | undefined,
): string | undefined {
  if (!message) return undefined;
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}
