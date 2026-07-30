import type { RawToolResult, RipgrepInput } from "./contracts";
import { ToolExecutionError } from "./errors";
import { assertSafeExistingPath, validateRepoPath } from "./path-utils";
import { runProcess } from "./process";

export async function ripgrepTool(
  input: RipgrepInput,
  signal?: AbortSignal,
): Promise<RawToolResult> {
  const repoPath = await validateRepoPath(input.repoPath);
  if (!input.pattern) {
    throw new ToolExecutionError("Search pattern must not be empty.", "INVALID_PATTERN");
  }

  const args = ["rg", "--line-number", "--column", "--no-heading", "--color=never"];
  if (input.fixedString) args.push("--fixed-strings");
  if (input.caseSensitive === false) args.push("--ignore-case");
  if (input.glob) args.push("--glob", input.glob);
  args.push("--", input.pattern);
  if (input.path) {
    await assertSafeExistingPath(repoPath, input.path);
    args.push(input.path);
  } else {
    args.push(".");
  }

  const result = await runProcess(args, repoPath, { signal });
  if (result.exitCode === 1) {
    return {
      output: "",
      metadata: { matches: 0 },
    };
  }
  if (result.exitCode !== 0) {
    throw new ToolExecutionError(
      `ripgrep failed: ${result.stderr.trim() || "unknown error"}`,
      "RIPGREP_FAILED",
      result.exitCode,
    );
  }

  const output = result.stdout.trimEnd();
  return {
    output,
    metadata: {
      matches: output ? output.split("\n").length : 0,
    },
  };
}
