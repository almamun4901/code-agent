import type {
  DispatcherContext,
  RawToolResult,
  ToolCall,
  ToolResult,
} from "./contracts";
import { editFileTool } from "./edit-file";
import { ToolExecutionError } from "./errors";
import { gitTool } from "./git";
import {
  assertInsideDevelopmentRoot,
  validateRepoPath,
} from "./path-utils";
import { readFileTool } from "./read-file";
import { ripgrepTool } from "./ripgrep";
import { runShellTool } from "./run-shell";
import { finalizeToolResult } from "./token-budget";
import { treeSitterSymbolsTool } from "./tree-sitter-symbols";
import { validateToolCall } from "./validate-call";

const allowAll = async (): Promise<void> => {};

async function execute(call: ToolCall): Promise<RawToolResult> {
  switch (call.name) {
    case "read_file":
      return readFileTool(call.input);
    case "edit_file":
      return editFileTool(call.input);
    case "ripgrep":
      return ripgrepTool(call.input);
    case "tree_sitter_symbols":
      return treeSitterSymbolsTool(call.input);
    case "run_shell":
      return runShellTool(call.input);
    case "git":
      return gitTool(call.input);
    default:
      throw new ToolExecutionError(
        `Unknown tool: ${String((call as { name?: unknown }).name)}`,
        "UNKNOWN_TOOL",
      );
  }
}

export async function dispatchTool(
  call: ToolCall,
  context: DispatcherContext = {},
): Promise<ToolResult> {
  const codec = context.tokenCodec;
  const tokenLimit = context.tokenLimit;

  try {
    const validatedCall = validateToolCall(call);
    const repoPath = await validateRepoPath(validatedCall.input.repoPath);
    assertInsideDevelopmentRoot(repoPath, context.developmentRoot);
    await (context.beforeToolUse ?? allowAll)(validatedCall, context);
    const raw = await execute(validatedCall);
    return finalizeToolResult(true, raw, { codec, tokenLimit });
  } catch (error) {
    const normalized =
      error instanceof ToolExecutionError
        ? error
        : new ToolExecutionError(
            error instanceof Error ? error.message : "Unknown tool failure.",
          );
    return finalizeToolResult(
      false,
      {
        output: normalized.message,
        metadata: {
          code: normalized.code,
          exitCode: normalized.exitCode,
        },
      },
      { codec, tokenLimit },
    );
  }
}
