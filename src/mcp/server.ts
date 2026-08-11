import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  DispatcherContext,
  ModelToolRequest,
  ToolResult,
  PreToolUseObservation,
} from "../tools/contracts";
import { isMutatingToolCall } from "../tools/contracts";
import {
  beginMutation,
  completeMutation,
  MemoryMutationJournal,
  type MutationJournal,
} from "../tools/mutation-journal";
import { dispatchTool } from "../tools/dispatcher";
import { finalizeToolResult } from "../tools/token-budget";
import {
  MUTATION_OPERATION_META_KEY,
  PRE_TOOL_USE_OBSERVATIONS_META_KEY,
} from "./client";
import {
  editFileInputSchema,
  gitInputSchema,
  readFileInputSchema,
  ripgrepInputSchema,
  runShellInputSchema,
  treeSitterSymbolsInputSchema,
} from "./schemas";

const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const mutatingAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

function toMcpResult(
  result: ToolResult,
  observations: PreToolUseObservation[] = [],
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError: !result.success,
    ...(observations.length > 0
      ? { _meta: { [PRE_TOOL_USE_OBSERVATIONS_META_KEY]: observations } }
      : {}),
  };
}

export function createMcpToolServer(
  context: DispatcherContext,
  options: { mutationJournal?: MutationJournal } = {},
): McpServer {
  const mutationJournal =
    options.mutationJournal ?? new MemoryMutationJournal();
  let executionTail: Promise<void> = Promise.resolve();
  const executionQueue = context.executionQueue ?? {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const previous = executionTail;
      let release!: () => void;
      executionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
  const dispatchContext: DispatcherContext = {
    ...context,
    executionQueue: undefined,
  };
  const server = new McpServer({
    name: "terminal-native-coding-agent-tools",
    version: "0.1.0",
  });

  async function handleTool(
    request: ModelToolRequest,
    meta: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    return executionQueue.run(async () => {
      const observations: PreToolUseObservation[] = [];
      const finish = (result: ToolResult) => toMcpResult(result, observations);
      const requestContext = {
        ...dispatchContext,
        abortSignal: signal,
        observePreToolUse(observation: PreToolUseObservation) {
          observations.push(observation);
          try {
            dispatchContext.observePreToolUse?.(observation);
          } catch {
            // Observation is best-effort and cannot alter tool execution.
          }
        },
      };
      if (!isMutatingToolCall(request)) {
        return finish(await dispatchTool(request, requestContext));
      }

      const operationId = meta?.[MUTATION_OPERATION_META_KEY];
      if (
        typeof operationId !== "string" ||
        !z.string().uuid().safeParse(operationId).success
      ) {
        return finish(
          finalizeToolResult(
            false,
            {
              output: "Mutating MCP calls require a valid operation ID.",
              metadata: { code: "MISSING_OPERATION_ID" },
            },
            {
              codec: dispatchContext.tokenCodec,
              tokenLimit: dispatchContext.tokenLimit,
            },
          ),
        );
      }

      const existing = await beginMutation(
        mutationJournal,
        operationId,
        request,
      );
      if (existing) {
        if (existing.status === "completed" && existing.result) {
          return finish(existing.result);
        }
        return finish(
          finalizeToolResult(
            false,
            {
              output: `Mutation ${operationId} is still in flight and cannot be replayed.`,
              metadata: { code: "MUTATION_IN_FLIGHT" },
            },
            {
              codec: dispatchContext.tokenCodec,
              tokenLimit: dispatchContext.tokenLimit,
            },
          ),
        );
      }

      const result = await dispatchTool(request, requestContext);
      await completeMutation(mutationJournal, operationId, result);
      return finish(result);
    });
  }

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: "Read UTF-8 repository text with optional inclusive line bounds.",
      inputSchema: readFileInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input, extra) =>
      handleTool({ name: "read_file", input }, extra._meta, extra.signal),
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit file",
      description:
        "Preview or apply an exact, version-checked repository file replacement.",
      inputSchema: editFileInputSchema,
      annotations: mutatingAnnotations,
    },
    async (input, extra) =>
      handleTool({ name: "edit_file", input }, extra._meta, extra.signal),
  );

  server.registerTool(
    "ripgrep",
    {
      title: "Search repository",
      description: "Search repository text with ripgrep and bounded output.",
      inputSchema: ripgrepInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input, extra) =>
      handleTool({ name: "ripgrep", input }, extra._meta, extra.signal),
  );

  server.registerTool(
    "tree_sitter_symbols",
    {
      title: "List source symbols",
      description: "Extract source symbols with the supported Tree-sitter grammars.",
      inputSchema: treeSitterSymbolsInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input, extra) =>
      handleTool(
        { name: "tree_sitter_symbols", input },
        extra._meta,
        extra.signal,
      ),
  );

  server.registerTool(
    "run_shell",
    {
      title: "Run shell command",
      description: "Run a bounded shell command inside a repository-relative directory.",
      inputSchema: runShellInputSchema,
      annotations: {
        ...mutatingAnnotations,
        openWorldHint: true,
      },
    },
    async (input, extra) =>
      handleTool({ name: "run_shell", input }, extra._meta, extra.signal),
  );

  server.registerTool(
    "git",
    {
      title: "Run Git operation",
      description: "Run a typed Git status, diff, or commit operation.",
      inputSchema: gitInputSchema,
      annotations: mutatingAnnotations,
    },
    async (input, extra) =>
      handleTool(
        {
          name: "git",
          input: input as Extract<
            ModelToolRequest,
            { name: "git" }
          >["input"],
        },
        extra._meta,
        extra.signal,
      ),
  );

  return server;
}
