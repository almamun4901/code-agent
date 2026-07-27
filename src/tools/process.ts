import { ToolExecutionError } from "./errors";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RAW_OUTPUT_BYTES = 1_048_576;

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

export async function runProcess(
  command: string[],
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const process = Bun.spawn(command, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
      killSignal: "SIGKILL",
      maxBuffer: MAX_RAW_OUTPUT_BYTES,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);

    return { stdout, stderr, exitCode, timedOut };
  } catch (error) {
    if (timedOut) {
      return {
        stdout: "",
        stderr: `Command timed out after ${timeoutMs}ms.`,
        exitCode: 124,
        timedOut: true,
      };
    }

    throw new ToolExecutionError(
      error instanceof Error ? error.message : "Failed to start process.",
      "PROCESS_START_FAILED",
    );
  } finally {
    clearTimeout(timer);
  }
}

export function requireSuccessfulProcess(
  label: string,
  result: ProcessResult,
): void {
  if (result.exitCode === 0 && !result.timedOut) return;
  const detail = result.stderr.trim() || result.stdout.trim() || "No output.";
  throw new ToolExecutionError(
    `${label} failed with exit code ${result.exitCode}: ${detail}`,
    result.timedOut ? "PROCESS_TIMEOUT" : "PROCESS_FAILED",
    result.exitCode,
  );
}
