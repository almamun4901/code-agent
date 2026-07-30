import { describe, expect, test } from "bun:test";
import path from "node:path";
import { runCli } from "../src/cli";
import type {
  AgentRunController,
  AgentRunResult,
  ControlledAgentRunOptions,
} from "../src/runtime/agent-runner";

describe("agent command", () => {
  test("prints the first non-TTY frame before runtime initialization", async () => {
    const order: string[] = [];
    const stdout = new MemoryOutput(() => order.push("output"));
    const stderr = new MemoryOutput();
    let finish!: (result: AgentRunResult) => void;
    const result = new Promise<AgentRunResult>((resolve) => {
      finish = resolve;
    });
    let received: ControlledAgentRunOptions | undefined;

    const running = runCli(["run", ".", "Inspect safely"], {
      stdout,
      stderr,
      installSigint: () => () => {},
      startRun(options) {
        order.push("start");
        received = options;
        return { result, stop: () => result };
      },
    });

    expect(order.slice(0, 2)).toEqual(["output", "start"]);
    expect(stdout.value).toBe("Initializing…\n");
    expect(received?.repoPath).toBe(path.resolve("."));
    finish(completed());
    expect(await running).toBe(0);
    expect(stderr.value).toBe("");
  });

  test("emits static lifecycle lines with no terminal controls", async () => {
    const stdout = new MemoryOutput();
    const exitCode = await runCli(["run", ".", "Inspect"], {
      stdout,
      stderr: new MemoryOutput(),
      installSigint: () => () => {},
      startRun(options) {
        options.eventSink?.({
          type: "run_started",
          sequence: 1,
          timestamp: new Date(0).toISOString(),
          runIdentity: "a".repeat(64),
        });
        options.eventSink?.({
          type: "run_finished",
          sequence: 2,
          timestamp: new Date(1).toISOString(),
          reason: "completed",
          cleanup: "succeeded",
        });
        const result = Promise.resolve(completed());
        return { result, stop: () => result };
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout.value).toContain("Initializing…\nRun started\n");
    expect(stdout.value).toContain(
      "Run finished: completed (cleanup succeeded)",
    );
    expect(stdout.value).not.toMatch(/\u001B\[[0-?]*[ -/]*[@-~]/);
  });

  test("rejects invalid arguments before creating a runtime", async () => {
    const stderr = new MemoryOutput();
    let starts = 0;
    const exitCode = await runCli(["run", ".", "   "], {
      stdout: new MemoryOutput(),
      stderr,
      startRun() {
        starts += 1;
        throw new Error("must not start");
      },
    });

    expect(exitCode).toBe(2);
    expect(starts).toBe(0);
    expect(stderr.value).toContain("Task must not be blank.");
    expect(stderr.value).toContain("Usage: agent run");
  });

  test("routes Ctrl-C through the controller exactly once", async () => {
    let signalHandler: (() => void) | undefined;
    let removed = 0;
    let stopCalls = 0;
    let finish!: (result: AgentRunResult) => void;
    const result = new Promise<AgentRunResult>((resolve) => {
      finish = resolve;
    });
    const controller: AgentRunController = {
      result,
      stop() {
        stopCalls += 1;
        finish({
          status: "cancelled",
          reason: "cancelled",
          cleanup: "succeeded",
          exitCode: 130,
        });
        return result;
      },
    };
    const running = runCli(["run", ".", "Cancel"], {
      stdout: new MemoryOutput(),
      stderr: new MemoryOutput(),
      startRun: () => controller,
      installSigint(handler) {
        signalHandler = handler;
        return () => {
          removed += 1;
        };
      },
    });

    signalHandler?.();
    expect(await running).toBe(130);
    expect(stopCalls).toBe(1);
    expect(removed).toBe(1);
  });

  test("keeps diagnostics on stderr and returns runtime failure", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const failed: AgentRunResult = {
      status: "failed",
      reason: "failed",
      cleanup: "succeeded",
      exitCode: 1,
      error: { code: "TEST_FAILURE", message: "Model unavailable" },
    };
    const exitCode = await runCli(["run", ".", "Fail"], {
      stdout,
      stderr,
      installSigint: () => () => {},
      startRun: () => ({
        result: Promise.resolve(failed),
        stop: async () => failed,
      }),
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("TEST_FAILURE: Model unavailable\n");
    expect(stdout.value).not.toContain("Model unavailable");
  });
});

class MemoryOutput {
  readonly isTTY = false;
  value = "";

  constructor(private readonly onWrite?: () => void) {}

  write(chunk: string): boolean {
    this.value += chunk;
    this.onWrite?.();
    return true;
  }
}

function completed(): AgentRunResult {
  return {
    status: "completed",
    reason: "completed",
    cleanup: "succeeded",
    exitCode: 0,
  };
}
