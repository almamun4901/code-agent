import { expect, test } from "bun:test";
import { MemoryCheckpointStore, runAgentLoop } from "../src/loop";
import { createAnthropicModel, createAnthropicRuntime } from "../src/model/anthropic";

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

liveTest(
  "Anthropic reports provider-native preflight and call accounting",
  async () => {
    const runtime = createAnthropicRuntime();
    const request = {
      system: "Answer with only OK.",
      messages: [{ role: "user" as const, content: "Confirm." }],
      tools: [],
      maxTokens: 32,
      mode: "summary" as const,
    };

    const estimate = await runtime.countRequestTokens(request);
    const turn = await runtime.call(request);

    expect(estimate.source).toBe("provider");
    expect(estimate.tokens).toBeGreaterThan(0);
    expect(turn.actualIdentity).toEqual(runtime.identity);
    expect(turn.usage.inputTokens).toBeGreaterThan(0);
    expect(turn.usage.outputTokens).toBeGreaterThan(0);
  },
  120_000,
);
