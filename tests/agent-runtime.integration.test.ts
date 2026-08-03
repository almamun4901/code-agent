import { expect, test } from "bun:test";
import { runHeadlessAgent } from "../src/runtime/agent-runner";
import { MemoryProductionCheckpointStore } from "../src/runtime/checkpoint";
import { createTemporaryRepository } from "./support/temp-repo";

const liveEnabled =
  process.env.RUN_LIVE_AGENT_RUNTIME_TEST === "1" &&
  Boolean(process.env.ANTHROPIC_API_KEY?.trim()) &&
  Boolean(process.env.E2B_API_KEY?.trim()) &&
  Boolean(process.env.E2B_TEMPLATE_ID?.trim());
const liveTest = liveEnabled ? test : test.skip;

liveTest(
  "Anthropic completes a checkpointed task through live E2B MCP tools",
  async () => {
    const repository = await createTemporaryRepository();
    try {
      const result = await runHeadlessAgent({
        repoPath: repository.worktreePath,
        task:
          "During discovery, inspect README.md once using read_file, then call propose_plan with one execution task. After automatic approval, inspect README.md once and complete the approved task on the following response. Do not modify files.",
        maxModelTurns: 20,
        modelProvider: "anthropic",
        approvalMode: "auto",
        checkpointStore: new MemoryProductionCheckpointStore(),
      });

      expect(result.status).toBe("completed");
      expect(result.modelTurns).toBeGreaterThanOrEqual(2);
      expect(result.toolCalls).toBeGreaterThanOrEqual(1);
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
      expect(
        result.plan.every((item) => item.status === "completed"),
      ).toBe(true);
    } finally {
      await repository.cleanup();
    }
  },
  360_000,
);
