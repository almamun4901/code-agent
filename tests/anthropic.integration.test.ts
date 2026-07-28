import { expect, test } from "bun:test";
import { MemoryCheckpointStore, runAgentLoop } from "../src/loop";
import { createAnthropicModel } from "../src/model/anthropic";

const liveEnabled =
  process.env.RUN_LIVE_ANTHROPIC_TEST === "1" &&
  Boolean(process.env.ANTHROPIC_API_KEY?.trim());
const liveTest = liveEnabled ? test : test.skip;

liveTest(
  "Claude completes the real-model/fake-tool Phase 1 acceptance scenario",
  async () => {
    const result = await runAgentLoop({
      callModel: createAnthropicModel(),
      checkpointStore: new MemoryCheckpointStore(),
      logger: () => {},
    });

    expect(result.status).toBe("completed");
    expect(result.modelTurns).toBeGreaterThanOrEqual(3);
    expect(result.acceptedTurns).toBeGreaterThanOrEqual(3);
    expect(result.planRewrites).toBe(result.acceptedTurns);
    expect(result.readCalls).toBe(3);
    expect(result.plan.every((task) => task.status === "completed")).toBe(true);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
  },
  120_000,
);
