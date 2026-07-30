import type { RawToolResult, RunShellInput } from "./contracts";
import { ToolExecutionError } from "./errors";
import { resolveRepoChild, validateRepoPath } from "./path-utils";
import { runProcess } from "./process";

const MAX_SHELL_TIMEOUT_MS = 30_000;
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";
const E2B_TASKS_ROOT = "/workspace/tasks";
const E2B_SHELL_WRAPPER = "/usr/local/sbin/agent-run-shell";

function shellEnvironment(repoPath: string): Record<string, string> {
  return {
    PATH: SAFE_PATH,
    HOME: "/tmp/runner-home",
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TASK_ROOT: repoPath,
  };
}

export async function runShellTool(
  input: RunShellInput,
  signal?: AbortSignal,
): Promise<RawToolResult> {
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

  const { command, wrapper } = shellCommand(
    repoPath,
    input.cwd,
    timeoutMs,
    input.command,
  );
  const result = await runProcess(command, wrapper ? repoPath : cwd, {
    timeoutMs: wrapper ? timeoutMs + 1_500 : timeoutMs,
    env: shellEnvironment(repoPath),
    signal,
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

export function shellCommand(
  repoPath: string,
  cwd: string,
  timeoutMs: number,
  requestedCommand: string,
  configuredWrapper = process.env.AGENT_SHELL_WRAPPER?.trim(),
): {
  command: string[];
  wrapper: string | undefined;
} {
  const wrapper =
    configuredWrapper ||
    (repoPath.startsWith(`${E2B_TASKS_ROOT}/`)
      ? E2B_SHELL_WRAPPER
      : undefined);

  return {
    command: wrapper
      ? [
          "sudo",
          wrapper,
          repoPath,
          cwd,
          String(timeoutMs),
          requestedCommand,
        ]
      : ["/bin/sh", "-c", requestedCommand],
    wrapper,
  };
}
