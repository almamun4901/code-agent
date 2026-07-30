import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import type { ModelTurn } from "../src/model/contracts";
import { prepareAgentRun } from "../src/runtime/agent-runner";
import { FileProductionCheckpointStore } from "../src/runtime/checkpoint";
import { runProductionLoop } from "../src/runtime/production-loop";
import type { ModelToolRequest, ToolResult } from "../src/tools/contracts";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "./support/temp-repo";

const repositories: TemporaryRepository[] = [];
const projectRoot = path.resolve(import.meta.dir, "..");
const packagedCommand = path.join(projectRoot, "bin", "agent.ts");
const cancellableCommand = path.join(
  projectRoot,
  "tests",
  "fixtures",
  "cancellable-cli.ts",
);

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repo) => repo.cleanup()));
});

describe("packaged terminal lifecycle", () => {
  test("restores terminal state and cancels through Ctrl-C", async () => {
    const result = await runPty(
      ["bun", cancellableCommand, "run", ".", "Cancel safely"],
      true,
    );

    expect(result.returnCode).toBe(130);
    expect(result.firstOutputMs).toBeLessThan(2_000);
    expect(result.terminalRestored).toBe(true);
    expect(result.output).toContain("Initializing");
    expect(result.output).toContain("cancelled");
  });

  test("keeps ten cold and ten resumed first paints below two seconds", async () => {
    const coldRepo = await createTemporaryRepository();
    const resumedRepo = await createTemporaryRepository();
    repositories.push(coldRepo, resumedRepo);
    const resumedTask = "Resume completed work";
    await installCompletedCheckpoint(resumedRepo, resumedTask);

    const coldMeasurements: number[] = [];
    const resumedMeasurements: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const cold = await runPty([
        packagedCommand,
        "run",
        coldRepo.worktreePath,
        `Cold launch ${index}`,
      ]);
      const resumed = await runPty([
        packagedCommand,
        "run",
        resumedRepo.worktreePath,
        resumedTask,
      ]);
      expect(cold.returnCode).toBe(1);
      expect(resumed.returnCode).toBe(0);
      expect(cold.terminalRestored).toBe(true);
      expect(resumed.terminalRestored).toBe(true);
      coldMeasurements.push(cold.firstOutputMs);
      resumedMeasurements.push(resumed.firstOutputMs);
    }

    expect(Math.max(...coldMeasurements)).toBeLessThan(2_000);
    expect(Math.max(...resumedMeasurements)).toBeLessThan(2_000);
    console.info(
      `TUI first paint: cold max ${
        Math.max(...coldMeasurements).toFixed(1)
      }ms; resumed max ${
        Math.max(...resumedMeasurements).toFixed(1)
      }ms.`,
    );
  }, 30_000);
});

type PtyResult = {
  returnCode: number;
  firstOutputMs: number;
  elapsedMs: number;
  terminalRestored: boolean;
  output: string;
};

async function runPty(
  command: string[],
  sendSigint = false,
): Promise<PtyResult> {
  const child = Bun.spawn(
    ["python3", path.join(import.meta.dir, "support", "run-pty.py"), ...command],
    {
      cwd: projectRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        E2B_TEMPLATE_ID: "",
        PTY_SEND_SIGINT: sendSigint ? "1" : "0",
      },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`PTY helper failed: ${stderr}`);
  }
  const decoded = JSON.parse(stdout) as Omit<PtyResult, "output"> & {
    output: string;
  };
  return {
    ...decoded,
    output: Buffer.from(decoded.output, "base64").toString("utf8"),
  };
}

async function installCompletedCheckpoint(
  repo: TemporaryRepository,
  task: string,
): Promise<void> {
  const prepared = await prepareAgentRun(repo.worktreePath, task);
  const store = new FileProductionCheckpointStore(repo.worktreePath);
  const turns: ModelTurn[] = [
    {
      content: [
        plan("Inspect", "in_progress"),
        {
          type: "tool_use",
          id: crypto.randomUUID(),
          name: "read_file",
          input: { path: "README.md" },
        },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      content: [plan("Inspect", "completed")],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ];
  let turnIndex = 0;
  await runProductionLoop({
    ...prepared,
    checkpointStore: store,
    callModel: async () => turns[turnIndex++]!,
    session: {
      async call(
        _request: ModelToolRequest,
      ): Promise<ToolResult> {
        return {
          success: true,
          output: "ok",
          truncated: false,
          originalTokenCount: 1,
          codec: "test",
        };
      },
    },
  });
}

function plan(
  description: string,
  status: "in_progress" | "completed",
) {
  return {
    type: "tool_use" as const,
    id: crypto.randomUUID(),
    name: "rewrite_plan",
    input: {
      plan: [{ id: "inspect", description, status }],
    },
  };
}
