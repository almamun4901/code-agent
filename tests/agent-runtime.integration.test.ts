import { expect, test } from "bun:test";
import { runHeadlessAgent } from "../src/runtime/agent-runner";
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
          "Inspect README.md using read_file. On the first response, create a single in_progress plan task and call read_file. Only mark it completed on the following response after the tool result. Do not modify files.",
        maxModelTurns: 12,
        modelProvider: "anthropic",
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
