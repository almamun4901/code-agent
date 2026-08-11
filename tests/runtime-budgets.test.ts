import { describe, expect, test } from "bun:test";
import type { ModelRequest, ModelRuntime, ModelTurn, TokenEstimate } from "../src/model/contracts";
import { catalogCostMicroUsd, pricingFor } from "../src/model/runtime";
import { LifecycleHooks } from "../src/runtime/lifecycle";
import { decodeProductionCheckpoint, MemoryProductionCheckpointStore, ProductionCheckpointBudgetError, productionCheckpointBytes } from "../src/runtime/checkpoint";
import { commitReconciledProductionMutation, prepareProductionLifecycle, runProductionLoop } from "../src/runtime/production-loop";
import { startAgentRun } from "../src/runtime/agent-runner";
import type { ProductionAgentState } from "../src/runtime/schema";
import { createLegacyExecutionApprovalState } from "./support/approval";

const prepared = {
  canonicalRepoPath: "/tmp/lifecycle-budget-repo",
  task: "Implement safely",
  runIdentity: "a".repeat(64),
};

describe("production lifecycle budgets", () => {
  test("bootstraps SessionStart then UserPromptSubmit before sandbox activity", async () => {
    const order: string[] = [];
    const hooks = new LifecycleHooks()
      .register("SessionStart", () => { order.push("start"); })
      .register("UserPromptSubmit", () => {
        order.push("prompt");
        return { outcome: "allow", appendContext: "Use the existing test style." };
      });
    const store = new MemoryProductionCheckpointStore();
    await prepareProductionLifecycle({ ...prepared, checkpointStore: store, modelRuntime: runtimeFor([]), hooks, approvalMode: "auto" });
    expect(order).toEqual(["start", "prompt"]);
    expect(await store.load()).toMatchObject({ promptStatus: "accepted", appendedPromptContext: "Use the existing test style." });
    expect(JSON.stringify((await store.load())?.transcript)).toContain("Lifecycle context");
  });

  test("prompt denial stays terminal, never opens E2B, and still fires SessionEnd", async () => {
    const order: string[] = [];
    const hooks = new LifecycleHooks()
      .register("SessionStart", () => { order.push("start"); })
      .register("UserPromptSubmit", () => ({ outcome: "deny", code: "PROMPT_DENIED", reason: "Task denied." }))
      .register("SessionEnd", (context) => { order.push(`end:${context.reason}`); });
    let opened = 0;
    const controller = startAgentRun({
      repoPath: process.cwd(),
      task: "Denied lifecycle test",
      templateId: "unused",
      approvalMode: "auto",
      checkpointStore: new MemoryProductionCheckpointStore(),
      modelRuntime: runtimeFor([]),
      hooks,
      openSession: async () => { opened += 1; throw new Error("must not open"); },
    });
    await expect(controller.result).resolves.toMatchObject({ status: "failed" });
    expect(opened).toBe(0);
    expect(order).toEqual(["start", "end:failed"]);
  });
  test("allows the configured paid-call boundary and blocks the next transport", async () => {
    const runtime = runtimeFor([
      agentTurn([["work", "Work", "in_progress"]]),
    ]);
    const store = preapprovedStore({ maxModelCalls: 1, compactAtTokens: 300_000 });
    await expect(runProductionLoop({
      ...prepared,
      modelRuntime: runtime,
      checkpointStore: store,
      session: session(),
      budgetLimits: { maxModelCalls: 1, compactAtTokens: 300_000 },
    })).rejects.toMatchObject({ code: "MODEL_CALL_LIMIT" });
    expect(runtime.calls()).toBe(1);
    expect((await store.load())?.counters).toMatchObject({ modelCalls: 1, agentCalls: 1, compactionCalls: 0 });
  });

  test("allows exactly the context ceiling and blocks the next token", async () => {
    const exact = runtimeFor([agentTurn([["work", "Work", "in_progress"]])], () => 200_000);
    await expect(runProductionLoop({
      ...prepared,
      modelRuntime: exact,
      checkpointStore: preapprovedStore({ maxModelCalls: 1, compactAtTokens: 250_000, maxContextTokens: 200_000 }),
      session: session(),
      budgetLimits: { maxModelCalls: 1, compactAtTokens: 250_000, maxContextTokens: 200_000 },
    })).rejects.toMatchObject({ code: "MODEL_CALL_LIMIT" });
    expect(exact.calls()).toBe(1);

    const over = runtimeFor([], () => 200_001);
    await expect(runProductionLoop({
      ...prepared,
      modelRuntime: over,
      checkpointStore: preapprovedStore({ compactAtTokens: 250_000, maxContextTokens: 200_000 }),
      session: session(),
      budgetLimits: { compactAtTokens: 250_000, maxContextTokens: 200_000 },
    })).rejects.toMatchObject({ code: "CONTEXT_BUDGET_EXCEEDED" });
    expect(over.calls()).toBe(0);
  });

  test("uses upward-rounded integer pricing and blocks one microdollar over budget", async () => {
    const pricing = pricingFor({ provider: "injected", model: "claude-haiku-4-5" });
    expect(catalogCostMicroUsd(1, 1, pricing)).toBe(6);
    const reservation = catalogCostMicroUsd(10, 4_096, pricing);
    const exact = runtimeFor([agentTurn([["work", "Work", "in_progress"]])], () => 10);
    await expect(runProductionLoop({
      ...prepared, modelRuntime: exact, checkpointStore: preapprovedStore({ maxModelCalls: 1, compactAtTokens: 100, maxProjectedCostMicroUsd: reservation }), session: session(),
      budgetLimits: { maxModelCalls: 1, compactAtTokens: 100, maxProjectedCostMicroUsd: reservation },
    })).rejects.toMatchObject({ code: "MODEL_CALL_LIMIT" });
    expect(exact.calls()).toBe(1);

    const over = runtimeFor([], () => 10);
    await expect(runProductionLoop({
      ...prepared, modelRuntime: over, checkpointStore: preapprovedStore({ compactAtTokens: 100, maxProjectedCostMicroUsd: reservation - 1 }), session: session(),
      budgetLimits: { compactAtTokens: 100, maxProjectedCostMicroUsd: reservation - 1 },
    })).rejects.toMatchObject({ code: "COST_BUDGET_EXCEEDED" });
    expect(over.calls()).toBe(0);
  });

  test("compacts at the threshold with the same counted provider and installs atomically", async () => {
    const counts = [100, 100, 10, 10, 10, 10, 10];
    const runtime = runtimeFor([
      summaryTurn(),
      agentTurn([["work", "Work", "in_progress"]], action("read", "read_file", { path: "README.md" })),
      agentTurn([["work", "Work", "completed"]]),
    ], () => counts.shift() ?? 10);
    const store = preapprovedStore({ compactAtTokens: 100, maxContextTokens: 200, maxModelCalls: 5 });
    const result = await runProductionLoop({
      ...prepared,
      modelRuntime: runtime,
      checkpointStore: store,
      session: session(),
      budgetLimits: { compactAtTokens: 100, maxContextTokens: 200, maxModelCalls: 5 },
    });
    expect(result.status).toBe("completed");
    const state = await store.load();
    expect(state?.compaction).toMatchObject({ count: 1, lastPreTokens: 100, lastPostTokens: 10 });
    expect(state?.counters).toMatchObject({ modelCalls: 3, agentCalls: 2, compactionCalls: 1 });
    expect(state?.pendingModelCall).toBeNull();
    expect(JSON.stringify(state?.transcript)).toContain("Compaction 1");
  });

  test("recovers a completed checkpoint whose compaction removed earlier turns", async () => {
    const counts = [10, 10, 100, 100, 10, 10];
    const store = preapprovedStore({ compactAtTokens: 100, maxContextTokens: 200, maxModelCalls: 5 });
    await runProductionLoop({
      ...prepared,
      modelRuntime: runtimeFor([
        agentTurn([["work", "Work", "in_progress"]], action("read", "read_file", { path: "README.md" })),
        summaryTurn(),
        agentTurn([["work", "Work", "completed"]]),
      ], () => counts.shift() ?? 10),
      checkpointStore: store,
      session: session(),
      budgetLimits: { compactAtTokens: 100, maxContextTokens: 200, maxModelCalls: 5 },
    });
    const resumed = runtimeFor([]);
    await expect(runProductionLoop({ ...prepared, modelRuntime: resumed, checkpointStore: store, session: session() })).resolves.toMatchObject({ status: "completed", toolCalls: 1 });
    expect(resumed.calls()).toBe(0);
  });

  test("persists invalid compaction output as a terminal failure", async () => {
    const store = preapprovedStore({ compactAtTokens: 100, maxContextTokens: 200 });
    const invalidSummary: ModelTurn = { content: [{ type: "text", text: "not json" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    await expect(runProductionLoop({
      ...prepared,
      modelRuntime: runtimeFor([invalidSummary], () => 100),
      checkpointStore: store,
      session: session(),
      budgetLimits: { compactAtTokens: 100, maxContextTokens: 200 },
    })).rejects.toThrow("invalid JSON");
    expect(await store.load()).toMatchObject({ lifecycle: "failed", terminalCode: "COMPACTION_INVALID" });
  });

  test("persists an ambiguous reservation and never replays it", async () => {
    const store = preapprovedStore();
    const failedRuntime = runtimeFor([], () => 10, new Error("connection lost"));
    await expect(runProductionLoop({ ...prepared, modelRuntime: failedRuntime, checkpointStore: store, session: session() })).rejects.toThrow("connection lost");
    expect((await store.load())?.pendingModelCall?.response).toBeNull();

    const resumedRuntime = runtimeFor([]);
    await expect(runProductionLoop({ ...prepared, modelRuntime: resumedRuntime, checkpointStore: store, session: session() })).rejects.toMatchObject({ code: "AMBIGUOUS_MODEL_CALL" });
    expect(resumedRuntime.calls()).toBe(0);
    expect((await store.load())?.counters.modelCalls).toBe(1);
  });

  test("installs a persisted response after a crash without replaying it", async () => {
    const backing = preapprovedStore({ compactAtTokens: 100, maxContextTokens: 200, maxModelCalls: 5 });
    let interrupted = false;
    const crashingStore = {
      load: () => backing.load(),
      async save(state: ProductionAgentState) {
        await backing.save(state);
        if (!interrupted && state.pendingModelCall?.response) {
          interrupted = true;
          throw new Error("process stopped after response persistence");
        }
      },
    };
    const first = runtimeFor([agentTurn([["work", "Work", "in_progress"]], action("read", "read_file", { path: "README.md" }))]);
    await expect(runProductionLoop({ ...prepared, modelRuntime: first, checkpointStore: crashingStore, session: session() })).rejects.toThrow("process stopped");
    expect(first.calls()).toBe(1);

    const resumed = runtimeFor([agentTurn([["work", "Work", "completed"]])]);
    await expect(runProductionLoop({ ...prepared, modelRuntime: resumed, checkpointStore: backing, session: session() })).resolves.toMatchObject({ status: "completed" });
    expect(resumed.calls()).toBe(1);
  });

  test("installs a persisted compaction response after a crash without treating it as an agent turn", async () => {
    const backing = preapprovedStore({ compactAtTokens: 100, maxContextTokens: 200, maxModelCalls: 5 });
    let interrupted = false;
    const crashingStore = {
      load: () => backing.load(),
      async save(state: ProductionAgentState) {
        await backing.save(state);
        if (!interrupted && state.pendingModelCall?.kind === "compaction" && state.pendingModelCall.response) {
          interrupted = true;
          throw new Error("process stopped after summary response");
        }
      },
    };
    const firstCounts = [100, 100];
    const first = runtimeFor([summaryTurn()], () => firstCounts.shift() ?? 100);
    await expect(runProductionLoop({
      ...prepared, modelRuntime: first, checkpointStore: crashingStore, session: session(),
      budgetLimits: { compactAtTokens: 100, maxContextTokens: 200, maxModelCalls: 5 },
    })).rejects.toThrow("process stopped after summary");
    expect(first.calls()).toBe(1);

    const resumed = runtimeFor([
      agentTurn([["work", "Work", "in_progress"]], action("read", "read_file", { path: "README.md" })),
      agentTurn([["work", "Work", "completed"]]),
    ], () => 10);
    await expect(runProductionLoop({ ...prepared, modelRuntime: resumed, checkpointStore: backing, session: session() })).resolves.toMatchObject({ status: "completed" });
    expect(resumed.calls()).toBe(2);
    expect((await backing.load())?.compaction.count).toBe(1);
  });

  test("Stop denial records feedback without double-counting the paid call", async () => {
    let stops = 0;
    const hooks = new LifecycleHooks().register("Stop", () => {
      stops += 1;
      return stops === 1
        ? { outcome: "deny", code: "VERIFY_MORE", reason: "Run one more verification." }
        : { outcome: "allow" };
    });
    const store = preapprovedStore();
    await runProductionLoop({
      ...prepared,
      hooks,
      modelRuntime: runtimeFor([
        agentTurn([["work", "Work", "in_progress"]], action("read", "read_file", { path: "README.md" })),
        agentTurn([["work", "Work", "completed"]]),
        agentTurn([["work", "Work", "completed"]]),
      ]),
      checkpointStore: store,
      session: session(),
    });
    expect((await store.load())?.counters).toMatchObject({ modelCalls: 3, agentCalls: 3, stopRejections: 1, committedTurns: 3, planRewrites: 2 });
    const resumed = runtimeFor([]);
    await expect(runProductionLoop({ ...prepared, modelRuntime: resumed, checkpointStore: store, session: session() })).resolves.toMatchObject({ status: "completed" });
    expect(resumed.calls()).toBe(0);
  });

  test("rejects a resumed runtime whose identity differs from persisted pricing", async () => {
    const store = preapprovedStore({ maxModelCalls: 1 });
    const first = runtimeFor([agentTurn([["work", "Work", "in_progress"]])]);
    await expect(runProductionLoop({ ...prepared, modelRuntime: first, checkpointStore: store, session: session(), budgetLimits: { maxModelCalls: 1 } })).rejects.toMatchObject({ code: "MODEL_CALL_LIMIT" });
    const state = await store.load();
    if (!state) throw new Error("Expected checkpoint.");
    state.lifecycle = "running";
    state.terminalCode = null;
    state.terminalError = null;
    await store.save(state);
    const changed = runtimeFor([]);
    changed.identity = { provider: "anthropic", model: "claude-haiku-4-5" };
    await expect(runProductionLoop({ ...prepared, modelRuntime: changed, checkpointStore: store, session: session() })).rejects.toThrow("does not match runtime");
    expect(changed.calls()).toBe(0);
  });

  test("PostToolUse observes one terminal outcome with redacted input", async () => {
    const observed: unknown[] = [];
    const hooks = new LifecycleHooks().register("PostToolUse", (context) => { observed.push(context); });
    await runProductionLoop({
      ...prepared,
      hooks,
      modelRuntime: runtimeFor([
        agentTurn([["work", "Work", "in_progress"]], action("read", "read_file", { path: "README.md" })),
        agentTurn([["work", "Work", "completed"]]),
      ]),
      checkpointStore: preapprovedStore(),
      session: session(),
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ toolName: "read_file", summary: "README.md", outcome: "succeeded" });
  });

  test("commits a shutdown-reconciled mutation and invokes PostToolUse once", async () => {
    const store = preapprovedStore();
    const hooks = new LifecycleHooks();
    const observed: unknown[] = [];
    hooks.register("PostToolUse", (context) => { observed.push(context); });
    await expect(runProductionLoop({
      ...prepared,
      hooks,
      modelRuntime: runtimeFor([
        agentTurn([["work", "Work", "in_progress"]], action("edit", "edit_file", { path: "README.md", mode: "apply", oldText: "a", newText: "b" })),
      ]),
      checkpointStore: store,
      session: { async call() { throw new DOMException("cancelled", "AbortError"); } },
    })).rejects.toThrow("cancelled");
    const operationId = (await store.load())?.pendingTurn?.action?.operationId;
    if (!operationId) throw new Error("Expected pending mutation.");
    const mutation = {
      operationId,
      toolName: "edit_file" as const,
      inputHash: "b".repeat(64),
      status: "completed" as const,
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
      result: { success: true, output: "applied", truncated: false, originalTokenCount: 1, codec: "test" },
    };
    await expect(commitReconciledProductionMutation({ checkpointStore: store, mutation, hooks })).resolves.toBe(true);
    await expect(commitReconciledProductionMutation({ checkpointStore: store, mutation, hooks })).resolves.toBe(false);
    expect(observed).toHaveLength(1);
    expect(await store.load()).toMatchObject({ pendingTurn: null, counters: { toolCalls: 1, committedTurns: 1 } });
  });

  test("falls back to a replay-safe terminal checkpoint at the byte ceiling", async () => {
    const store = preapprovedStore();
    const state = baseState();
    state.transcript.push({ role: "user", content: "界".repeat(10_000) });
    state.limits.maxCheckpointBytes = 4_096;
    await expect(store.save(state)).rejects.toBeInstanceOf(ProductionCheckpointBudgetError);
    const saved = await store.load();
    expect(saved).toMatchObject({ lifecycle: "failed", terminalCode: "CHECKPOINT_BUDGET_EXCEEDED", pendingModelCall: null, pendingTurn: null });
    expect(productionCheckpointBytes(saved!)).toBeLessThanOrEqual(4_096);
  });

  test("does not continue after persisting an oversized response fallback", async () => {
    const oversized = agentTurn([["work", "Work", "in_progress"]]);
    oversized.content.unshift({ type: "text", text: "界".repeat(10_000) });
    const runtime = runtimeFor([oversized]);
    const store = preapprovedStore({ maxCheckpointBytes: 4_096 });
    await expect(runProductionLoop({
      ...prepared,
      modelRuntime: runtime,
      checkpointStore: store,
      session: session(),
      budgetLimits: { maxCheckpointBytes: 4_096 },
    })).rejects.toBeInstanceOf(ProductionCheckpointBudgetError);
    expect(runtime.calls()).toBe(1);
    expect(await store.load()).toMatchObject({ lifecycle: "failed", terminalCode: "CHECKPOINT_BUDGET_EXCEEDED" });
  });

  test("migrates only empty v2 checkpoints and refuses invented historical pricing", () => {
    const legacy = {
      version: 2 as const,
      runIdentity: prepared.runIdentity,
      canonicalRepoPath: prepared.canonicalRepoPath,
      task: prepared.task,
      lifecycle: "running" as const,
      plan: [],
      transcript: [{ role: "user" as const, content: "legacy prompt" }],
      lastToolSucceeded: null,
      pendingTurn: null,
      counters: { modelTurns: 0, committedTurns: 0, protocolRetries: 0, toolCalls: 0, planRewrites: 0, inputTokens: 0, outputTokens: 0 },
      consecutiveInvalidAttempts: 0,
      terminalError: null,
      lastToolResult: null,
    };
    expect(decodeProductionCheckpoint(legacy)).toMatchObject({ version: 3, counters: { modelCalls: 0 }, cost: { projectedMicroUsd: 0 } });
    expect(() => decodeProductionCheckpoint({ ...legacy, counters: { ...legacy.counters, modelTurns: 1 } })).toThrow("pricing cannot be reconstructed");
  });
});

function runtimeFor(turns: ModelTurn[], count: (request: ModelRequest) => number = () => 10, callError?: Error): ModelRuntime & { calls(): number } {
  let index = 0;
  let callCount = 0;
  return {
    identity: { provider: "injected", model: "claude-haiku-4-5" },
    async countRequestTokens(request): Promise<TokenEstimate> {
      return { tokens: count(request), source: "provider" };
    },
    async call() {
      callCount += 1;
      if (callError) throw callError;
      const turn = turns[index++];
      if (!turn) throw new Error("Unexpected model call.");
      return { ...turn, actualIdentity: { provider: "injected", model: "claude-haiku-4-5" }, providerCostMicroUsd: 10 };
    },
    calls: () => callCount,
  };
}

function agentTurn(tasks: [string, string, "pending" | "in_progress" | "completed"][], extra?: ReturnType<typeof action>): ModelTurn {
  return { content: [plan(tasks), ...(extra ? [extra] : [])], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } };
}

function summaryTurn(): ModelTurn {
  return { content: [{ type: "text", text: JSON.stringify({ version: 1, discoveries: [], decisions: [], changedFiles: [], verification: [], failures: [], unresolved: [] }) }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
}

function plan(tasks: [string, string, "pending" | "in_progress" | "completed"][]) {
  return { type: "tool_use" as const, id: crypto.randomUUID(), name: "rewrite_plan", input: { plan: tasks.map(([id, description, status]) => ({ id, description, status })) } };
}

function action(id: string, name: string, input: unknown) {
  return { type: "tool_use" as const, id, name, input };
}

function session() {
  return { async call() { return { success: true, output: "ok", truncated: false, originalTokenCount: 1, codec: "test" }; } };
}

function baseState(): ProductionAgentState {
  return {
    version: 4, ...prepared, approval: createLegacyExecutionApprovalState(), promptStatus: "accepted", appendedPromptContext: "", lifecycle: "running", plan: [], transcript: [{ role: "user", content: "Complete the following repository task:\nImplement safely\n\nFirst create a concrete plan, then perform one safe action per turn." }], lastToolSucceeded: null, pendingTurn: null, pendingModelCall: null,
    limits: { maxModelCalls: 50, compactAtTokens: 150_000, maxContextTokens: 200_000, maxProjectedCostMicroUsd: 5_000_000, compactAtCheckpointBytes: 1_572_864, maxCheckpointBytes: 2 * 1024 * 1024 },
    pricing: { catalogVersion: 1, identity: { provider: "injected", model: "claude-haiku-4-5" }, inputRateMicroUsdPerMillion: 1_000_000, outputRateMicroUsdPerMillion: 5_000_000 },
    context: { lastEstimateTokens: 0, estimateSource: null, requestFingerprint: null }, cost: { projectedMicroUsd: 0, observedMicroUsd: 0, observedAvailable: false, driftMicroUsd: 0 }, compaction: { count: 0, lastPreTokens: 0, lastPostTokens: 0, baselineCommittedTurns: 0, baselineProtocolRetries: 0, baselineToolCalls: 0, baselinePlanRewrites: 0, baselineStopRejections: 0 }, notificationKeys: [], lastNotification: null,
    counters: { modelTurns: 0, modelCalls: 0, agentCalls: 0, compactionCalls: 0, stopRejections: 0, committedTurns: 0, protocolRetries: 0, toolCalls: 0, planRewrites: 0, inputTokens: 0, outputTokens: 0 }, consecutiveInvalidAttempts: 0, terminalCode: null, terminalError: null, lastToolResult: null,
    auditCursor: { sequence: 0, digest: "0".repeat(64) }, verificationEvidence: [], completion: null, legacyCompletionStatus: null,
  };
}

function preapprovedStore(limits: Partial<ProductionAgentState["limits"]> = {}): MemoryProductionCheckpointStore {
  const state = baseState();
  state.limits = { ...state.limits, ...limits };
  return new MemoryProductionCheckpointStore(state);
}
