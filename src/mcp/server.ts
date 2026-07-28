import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type {
  DispatcherContext,
  GitInput,
  ToolResult,
} from "../tools/contracts";
import { dispatchTool } from "../tools/dispatcher";
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

const openWorldAnnotations: ToolAnnotations = {
  ...mutatingAnnotations,
  openWorldHint: true,
};

function toMcpResult(result: ToolResult): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError: !result.success,
  };
}

export function createMcpToolServer(
  context: DispatcherContext,
): McpServer {
  const server = new McpServer({
    name: "terminal-native-coding-agent-tools",
    version: "0.1.0",
  });

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: "Read UTF-8 repository text with optional inclusive line bounds.",
      inputSchema: readFileInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) => toMcpResult(await dispatchTool({ name: "read_file", input }, context)),
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
    async (input) => toMcpResult(await dispatchTool({ name: "edit_file", input }, context)),
  );

  server.registerTool(
    "ripgrep",
    {
      title: "Search repository",
      description: "Search repository text with ripgrep and bounded output.",
      inputSchema: ripgrepInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) => toMcpResult(await dispatchTool({ name: "ripgrep", input }, context)),
  );

  server.registerTool(
    "tree_sitter_symbols",
    {
      title: "List source symbols",
      description: "Extract source symbols with the supported Tree-sitter grammars.",
      inputSchema: treeSitterSymbolsInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      toMcpResult(
        await dispatchTool({ name: "tree_sitter_symbols", input }, context),
      ),
  );

  server.registerTool(
    "run_shell",
    {
      title: "Run shell command",
      description: "Run a bounded shell command inside a repository-relative directory.",
      inputSchema: runShellInputSchema,
      annotations: openWorldAnnotations,
    },
    async (input) =>
      toMcpResult(await dispatchTool({ name: "run_shell", input }, context)),
  );

  server.registerTool(
    "git",
    {
      title: "Run Git operation",
      description: "Run a typed Git status, diff, commit, or push operation.",
      inputSchema: gitInputSchema,
      annotations: openWorldAnnotations,
    },
    async (input) =>
      toMcpResult(
        await dispatchTool(
          { name: "git", input: input as GitInput },
          context,
        ),
      ),
  );

  return server;
}
