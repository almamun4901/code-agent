import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PHASE_ONE_TASKS,
  runAgentLoop,
  type PlanTask,
} from "../../src/loop";
import type {
  CallModel,
  ModelTurn,
} from "../../src/model/anthropic";
import { fakeReadFile } from "../../src/tools/fake-read-file";

const repoPath = requireEnvironment("RECOVERY_REPO");
const barrierPath = requireEnvironment("RECOVERY_BARRIER");
const blockAfter = Number(process.env.RECOVERY_BLOCK_AFTER ?? "-1");

const callModel: CallModel = async (request) => {
  const committedTurns = request.messages.filter(
    (message) => message.role === "assistant",
  ).length;

  if (committedTurns === blockAfter) {
    writeFileSync(barrierPath, `${committedTurns}\n`, { mode: 0o600 });
    await new Promise<never>(() => {});
  }

  return makeTurn(committedTurns);
};

await runAgentLoop({
  callModel,
  repoPath,
  logger: () => {},
  readFile: (path) => {
    appendFileSync(join(repoPath, "reads.log"), `${path}\n`);
    return fakeReadFile(path);
  },
});

function makeTurn(completedCount: number): ModelTurn {
  const plan: PlanTask[] = PHASE_ONE_TASKS.map((task, index) => ({
    id: task.id,
    description: task.description,
    status:
      index < completedCount
        ? "completed"
        : index === completedCount
          ? "in_progress"
          : "pending",
  }));
  const content: ModelTurn["content"] = [
    {
      type: "tool_use",
      id: `plan-${completedCount}`,
      name: "rewrite_plan",
      input: { plan },
    },
  ];

  const task = PHASE_ONE_TASKS[completedCount];
  if (task) {
    content.push({
      type: "tool_use",
      id: `read-${completedCount}`,
      name: "read_file",
      input: { path: task.path },
    });
  }

  return {
    content,
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
