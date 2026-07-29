import type {
  DispatcherContext,
  ModelToolRequest,
  RawToolResult,
  RootedToolCall,
  ToolResult,
} from "./contracts";
import { editFileTool } from "./edit-file";
import { ToolExecutionError } from "./errors";
import { gitTool } from "./git";
import { readFileTool } from "./read-file";
import { ripgrepTool } from "./ripgrep";
import { runShellTool } from "./run-shell";
import { finalizeToolResult } from "./token-budget";
import { treeSitterSymbolsTool } from "./tree-sitter-symbols";
import { validateToolCall } from "./validate-call";

const allowAll = async () => ({ outcome: "allow" } as const);

async function execute(call: RootedToolCall): Promise<RawToolResult> {
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

function bindWorktreeRoot(
  request: ModelToolRequest,
  worktreeRoot: string,
): RootedToolCall {
  return {
    ...request,
    input: { ...request.input, repoPath: worktreeRoot },
  } as RootedToolCall;
}

async function evaluatePolicy(
  request: ModelToolRequest,
  context: DispatcherContext,
): Promise<void> {
  let decision;
  try {
    decision = await (context.preToolUse ?? allowAll)(request, {
      worktreeRoot: context.worktreeRoot,
    });
  } catch (error) {
    throw new ToolExecutionError(
      `PreToolUse policy failed: ${
        error instanceof Error ? error.message : "unknown policy failure"
      }`,
      "POLICY_FAILURE",
    );
  }

  if (decision.outcome === "allow") return;
  if (
    decision.outcome !== "deny" ||
    typeof decision.code !== "string" ||
    !/^[A-Z][A-Z0-9_]*$/.test(decision.code) ||
    typeof decision.reason !== "string" ||
    !decision.reason.trim()
  ) {
    throw new ToolExecutionError(
      "PreToolUse policy returned an invalid decision.",
      "POLICY_FAILURE",
    );
  }
  throw new ToolExecutionError(decision.reason, decision.code);
}

async function dispatchValidated(
  call: unknown,
  context: DispatcherContext,
): Promise<ToolResult> {
  const codec = context.tokenCodec;
  const tokenLimit = context.tokenLimit;

  try {
    const validatedRequest = validateToolCall(call);
    await evaluatePolicy(validatedRequest, context);
    const raw = await execute(
      bindWorktreeRoot(validatedRequest, context.worktreeRoot),
    );
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

export async function dispatchTool(
  call: unknown,
  context: DispatcherContext,
): Promise<ToolResult> {
  if (!context.worktreeRoot) {
    return finalizeToolResult(
      false,
      {
        output: "Dispatcher requires an immutable worktree root.",
        metadata: { code: "MISSING_WORKTREE_ROOT" },
      },
      { codec: context.tokenCodec, tokenLimit: context.tokenLimit },
    );
  }
  const operation = () => dispatchValidated(call, context);
  return context.executionQueue
    ? context.executionQueue.run(operation)
    : operation();
}
