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
  options: {
    timeoutMs?: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
    onAbort?: () => void | Promise<void>;
  } = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let abortCleanup: Promise<void> = Promise.resolve();
  const abortFromCaller = () => {
    controller.abort(options.signal?.reason);
    abortCleanup = Promise.resolve()
      .then(() => options.onAbort?.())
      .then(() => undefined)
      .catch(() => undefined);
  };
  if (options.signal?.aborted) {
    throw new ToolExecutionError(
      "Tool execution was cancelled.",
      "CANCELLED",
    );
  }
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
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
      env: options.env,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    await abortCleanup;

    if (options.signal?.aborted) {
      throw new ToolExecutionError(
        "Tool execution was cancelled.",
        "CANCELLED",
      );
    }
    return { stdout, stderr, exitCode, timedOut };
  } catch (error) {
    await abortCleanup;
    if (timedOut) {
      return {
        stdout: "",
        stderr: `Command timed out after ${timeoutMs}ms.`,
        exitCode: 124,
        timedOut: true,
      };
    }
    if (options.signal?.aborted) {
      throw new ToolExecutionError(
        "Tool execution was cancelled.",
        "CANCELLED",
      );
    }

    throw new ToolExecutionError(
      error instanceof Error ? error.message : "Failed to start process.",
      "PROCESS_START_FAILED",
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
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
