import { expect, test } from "bun:test";
import { MemoryCheckpointStore, runAgentLoop } from "../src/loop";
import { createOpenRouterModel } from "../src/model/openrouter";

const liveEnabled =
  process.env.RUN_LIVE_OPENROUTER_TEST === "1" &&
  Boolean(process.env.OPENROUTER_API_KEY?.trim());
const liveTest = liveEnabled ? test : test.skip;

liveTest(
  "OpenRouter completes the real-model tool-call acceptance scenario",
  async () => {
    const result = await runAgentLoop({
      callModel: createOpenRouterModel(),
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
