import { expect, test } from "bun:test";
import { MemoryCheckpointStore, runAgentLoop } from "../src/loop";
import { createOpenRouterModel, createOpenRouterRuntime } from "../src/model/openrouter";

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

liveTest(
  "OpenRouter reports conservative preflight, routed identity, and provider cost",
  async () => {
    const runtime = createOpenRouterRuntime();
    const request = {
      system: "Answer with only OK.",
      messages: [{ role: "user" as const, content: "Confirm." }],
      tools: [],
      maxTokens: 32,
      mode: "summary" as const,
    };

    const estimate = await runtime.countRequestTokens(request);
    const turn = await runtime.call(request);

    expect(estimate.source).toBe("conservative_local");
    expect(estimate.tokens).toBeGreaterThan(0);
    expect(turn.actualIdentity?.provider).toBe("openrouter");
    expect(turn.actualIdentity?.model).toBe("anthropic/claude-haiku-4.5");
    expect(turn.usage.inputTokens).toBeGreaterThan(0);
    expect(turn.usage.outputTokens).toBeGreaterThan(0);
    expect(turn.providerCostMicroUsd).toBeGreaterThan(0);
  },
  120_000,
);
