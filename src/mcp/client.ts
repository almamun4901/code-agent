import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  isMutatingToolCall,
  type ModelToolRequest,
  type PreToolUseObservation,
  type ToolResult,
} from "../tools/contracts";
import { toolResultWireSchema } from "./schemas";

const MCP_TOOL_TIMEOUT_MS = 60_000;
export const MUTATION_OPERATION_META_KEY =
  "terminal-native-coding-agent/operation-id";
export const PRE_TOOL_USE_OBSERVATIONS_META_KEY =
  "terminal-native-coding-agent/pre-tool-use-observations";

export type McpToolCallOptions = {
  operationId?: string;
  signal?: AbortSignal;
  observePreToolUse?: (observation: PreToolUseObservation) => void;
};

export class McpResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpResultValidationError";
  }
}

export class McpToolClient {
  readonly #client: Client;
  #closePromise: Promise<void> | undefined;

  private constructor(client: Client) {
    this.#client = client;
  }

  static async connect(transport: Transport): Promise<McpToolClient> {
    const client = new Client({
      name: "terminal-native-coding-agent",
      version: "0.1.0",
    });
    await client.connect(transport);
    return new McpToolClient(client);
  }

  async listTools(): Promise<ListToolsResult> {
    this.assertOpen();
    return this.#client.listTools();
  }

  async call(
    call: ModelToolRequest,
    options: McpToolCallOptions = {},
  ): Promise<ToolResult> {
    this.assertOpen();
    const operationId = isMutatingToolCall(call)
      ? (options.operationId ?? crypto.randomUUID())
      : undefined;
    const rawResult = await this.#client.callTool(
      {
        name: call.name,
        arguments: call.input,
        ...(operationId
          ? { _meta: { [MUTATION_OPERATION_META_KEY]: operationId } }
          : {}),
      },
      CallToolResultSchema,
      {
        timeout: MCP_TOOL_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const result = CallToolResultSchema.parse(rawResult);

    if (result.content.length !== 1 || result.content[0]?.type !== "text") {
      throw new McpResultValidationError(
        "MCP tool result must contain exactly one text content block.",
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(result.content[0].text);
    } catch {
      throw new McpResultValidationError(
        "MCP tool result text is not valid JSON.",
      );
    }

    const parsed = toolResultWireSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new McpResultValidationError(
        `MCP tool result does not match ToolResult: ${parsed.error.message}`,
      );
    }

    if (Boolean(result.isError) !== !parsed.data.success) {
      throw new McpResultValidationError(
        "MCP isError does not correlate with ToolResult.success.",
      );
    }

    const observations = result._meta?.[PRE_TOOL_USE_OBSERVATIONS_META_KEY];
    if (observations !== undefined) {
      if (!Array.isArray(observations)) {
        throw new McpResultValidationError("MCP PreToolUse observations must be an array.");
      }
      for (const observation of observations) {
        if (!isPreToolUseObservation(observation)) {
          throw new McpResultValidationError("MCP PreToolUse observation is invalid.");
        }
        try {
          options.observePreToolUse?.(observation);
        } catch {
          // Telemetry projection failures never change the tool result.
        }
      }
    }

    return parsed.data;
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#client.close();
    await this.#closePromise;
  }

  private assertOpen(): void {
    if (this.#closePromise) {
      throw new McpResultValidationError("MCP tool client is closed.");
    }
  }
}

function isPreToolUseObservation(value: unknown): value is PreToolUseObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const observation = value as Record<string, unknown>;
  return Object.keys(observation).length === 3 &&
    Number.isInteger(observation.index) && Number(observation.index) >= 0 &&
    typeof observation.durationMs === "number" && Number.isFinite(observation.durationMs) && observation.durationMs >= 0 &&
    (observation.outcome === "allow" || observation.outcome === "deny" || observation.outcome === "failed" || observation.outcome === "cancelled");
}
