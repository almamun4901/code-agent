import type { RawToolResult, RunShellInput } from "./contracts";
import { ToolExecutionError } from "./errors";
import { resolveRepoChild, validateRepoPath } from "./path-utils";
import { runProcess } from "./process";

const MAX_SHELL_TIMEOUT_MS = 30_000;

export async function runShellTool(input: RunShellInput): Promise<RawToolResult> {
  const repoPath = await validateRepoPath(input.repoPath);
  const cwd = resolveRepoChild(repoPath, input.cwd, { allowDot: true });
  if (!input.command.trim()) {
    throw new ToolExecutionError("Shell command must not be empty.", "INVALID_COMMAND");
  }
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_SHELL_TIMEOUT_MS
  ) {
    throw new ToolExecutionError(
      `timeoutMs must be between 1 and ${MAX_SHELL_TIMEOUT_MS}.`,
      "INVALID_TIMEOUT",
    );
  }

  const wrapper = process.env.AGENT_SHELL_WRAPPER?.trim();
  const command = wrapper
    ? [
        "sudo",
        wrapper,
        repoPath,
        input.cwd,
        String(timeoutMs),
        input.command,
      ]
    : ["/bin/sh", "-c", input.command];
  const result = await runProcess(command, wrapper ? repoPath : cwd, {
    timeoutMs: wrapper ? timeoutMs + 1_500 : timeoutMs,
  });
  const sections = [
    result.stdout ? `STDOUT\n${result.stdout.trimEnd()}` : "",
    result.stderr ? `STDERR\n${result.stderr.trimEnd()}` : "",
  ].filter(Boolean);

  return {
    output: sections.join("\n\n"),
    metadata: {
      exitCode: result.exitCode,
      timedOut: result.timedOut || result.exitCode === 124,
      cwd: input.cwd,
    },
  };
}
