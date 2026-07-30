import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ModelToolRequest, ToolResult } from "../tools/contracts";
import { toolResultWireSchema } from "./schemas";

const MCP_TOOL_TIMEOUT_MS = 60_000;

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

  async call(call: ModelToolRequest): Promise<ToolResult> {
    this.assertOpen();
    const rawResult = await this.#client.callTool(
      {
        name: call.name,
        arguments: call.input,
      },
      CallToolResultSchema,
      { timeout: MCP_TOOL_TIMEOUT_MS },
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
