import { describe, expect, test } from "bun:test";
import path from "node:path";
import { runCli } from "../src/cli";
import type {
  AgentRunController,
  AgentRunResult,
  ControlledAgentRunOptions,
} from "../src/runtime/agent-runner";
import type { InspectionResult } from "../src/runtime/inspect";

describe("agent command", () => {
  test("prints stable JSON inspection and routes operation lookup without starting a run", async () => {
    const stdout = new MemoryOutput();
    const operationId = "123e4567-e89b-42d3-a456-426614174000";
    let received: { repo: string; operation?: string } | undefined;
    const exitCode = await runCli(["inspect", ".", "--json", "--operation", operationId], {
      stdout,
      stderr: new MemoryOutput(),
      inspect: async (repo, operation) => {
        received = { repo, ...(operation ? { operation } : {}) };
        return inspection();
      },
      startRun() { throw new Error("must not start"); },
    });
    expect(exitCode).toBe(0);
    expect(received).toEqual({ repo: path.resolve("."), operation: operationId });
    expect(JSON.parse(stdout.value)).toMatchObject({ version: 1, audit: { integrity: "valid" } });
  });

  test("returns usage 2 for invalid inspect arguments and integrity 1 for inspection failure", async () => {
    const invalidError = new MemoryOutput();
    expect(await runCli(["inspect", ".", "--operation", "not-a-uuid"], { stdout: new MemoryOutput(), stderr: invalidError })).toBe(2);
    expect(invalidError.value).toContain("Usage: agent");
    const integrityError = new MemoryOutput();
    expect(await runCli(["inspect", "."], { stdout: new MemoryOutput(), stderr: integrityError, inspect: async () => { throw new Error("AUDIT_HASH_MISMATCH"); } })).toBe(1);
    expect(integrityError.value).toContain("AUDIT_HASH_MISMATCH");
  });

  test("prints the first non-TTY frame before runtime initialization", async () => {
    const order: string[] = [];
    const stdout = new MemoryOutput(() => order.push("output"));
    const stderr = new MemoryOutput();
    let finish!: (result: AgentRunResult) => void;
    const result = new Promise<AgentRunResult>((resolve) => {
      finish = resolve;
    });
    let received: ControlledAgentRunOptions | undefined;

    const running = runCli(["run", ".", "Inspect safely", "--auto-approve"], {
      stdout,
      stderr,
      installSigint: () => () => {},
      startRun(options) {
        order.push("start");
        received = options;
        return { result, stop: () => result, submitApproval: () => false };
      },
    });

    expect(order.slice(0, 2)).toEqual(["output", "start"]);
    expect(stdout.value).toBe("Initializing…\n");
    expect(received?.repoPath).toBe(path.resolve("."));
    expect(received?.approvalMode).toBe("auto");
    finish(completed());
    expect(await running).toBe(0);
    expect(stderr.value).toBe("");
  });

  test("emits static lifecycle lines with no terminal controls", async () => {
    const stdout = new MemoryOutput();
    const exitCode = await runCli(["run", ".", "Inspect", "--auto-approve"], {
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
        return { result, stop: () => result, submitApproval: () => false };
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

  test("requires explicit auto approval for non-interactive output", async () => {
    const stderr = new MemoryOutput();
    let starts = 0;
    const exitCode = await runCli(["run", ".", "Inspect"], {
      stdout: new MemoryOutput(),
      stderr,
      startRun() {
        starts += 1;
        throw new Error("must not start");
      },
    });
    expect(exitCode).toBe(2);
    expect(starts).toBe(0);
    expect(stderr.value).toContain("require explicit --auto-approve");
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
      submitApproval: () => false,
    };
    const running = runCli(["run", ".", "Cancel", "--auto-approve"], {
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
    const exitCode = await runCli(["run", ".", "Fail", "--auto-approve"], {
      stdout,
      stderr,
      installSigint: () => () => {},
      startRun: () => ({
        result: Promise.resolve(failed),
        stop: async () => failed,
        submitApproval: () => false,
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

function inspection(): InspectionResult {
  return {
    version: 1,
    run: { identity: "a".repeat(64), lifecycle: "finalizing", completionStatus: null, proposalRevision: 1 },
    verification: [],
    tools: [],
    audit: { integrity: "valid", sequence: 0, digest: "0".repeat(64), committedRecords: 0 },
    git: { candidateTree: null, deliveredBranch: null, deliveredCommit: null, deliveredTree: null, baseCommit: null, baseTree: null, changedPaths: [], diffSummary: null },
    completion: null,
    blockedReason: "FINALIZATION_DELIVERY_PENDING",
  };
}
