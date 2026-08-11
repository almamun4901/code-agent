import { describe, expect, test } from "bun:test";
import {
  InMemorySpanExporter,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type { ModelRequest, ModelRuntime, ModelTurn } from "../src/model/contracts";
import { MemoryAuditJournal } from "../src/runtime/audit";
import { MemoryProductionCheckpointStore } from "../src/runtime/checkpoint";
import { LifecycleHooks } from "../src/runtime/lifecycle";
import { runProductionLoop } from "../src/runtime/production-loop";
import type { ProductionAgentState } from "../src/runtime/schema";
import {
  createRunTelemetryFromEnvironment,
  OpenTelemetryRunTelemetry,
} from "../src/runtime/telemetry";
import { createLegacyExecutionApprovalState } from "./support/approval";

const prepared = {
  canonicalRepoPath: "/tmp/telemetry-test-repo",
  task: "SECRET_TASK_TEXT",
  runIdentity: "a".repeat(64),
};

describe("OpenTelemetry projection", () => {
  test("counts every model, tool, and hook invocation without exporting sensitive content", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = new OpenTelemetryRunTelemetry({
      exporter,
      processor: "simple",
      flushTimeoutMs: 500,
    });
    telemetry.startRun({
      "agent.run.id": prepared.runIdentity,
      "agent.run.approval_mode": "auto",
      "task.text": prepared.task,
    });

    const hooks = new LifecycleHooks()
      .register("Notification", () => {})
      .register("Notification", () => {})
      .register("Stop", () => ({ outcome: "allow" }));
    await hooks.runObservers("Notification", {
      kind: "warning",
      code: "SAFE_CODE",
      title: "SECRET_TITLE",
      message: "SECRET_MESSAGE",
    }, telemetry);
    await hooks.runGating("Stop", {
      runIdentity: prepared.runIdentity,
      proposedPlan: [],
      budget: {
        modelCalls: 0,
        maxModelCalls: 50,
        contextTokens: 0,
        maxContextTokens: 200_000,
        projectedCostMicroUsd: 0,
        maxProjectedCostMicroUsd: 5_000_000,
        compactions: 0,
      },
    }, telemetry);

    const store = new MemoryProductionCheckpointStore(baseState());
    const audit = new MemoryAuditJournal();
    const result = await runProductionLoop({
      ...prepared,
      modelRuntime: runtimeFor([
        turn("in_progress", {
          type: "tool_use",
          id: "read-secret",
          name: "read_file",
          input: { path: "SECRET_PATH.ts" },
        }),
        turn("completed"),
      ]),
      checkpointStore: store,
      auditJournal: audit,
      telemetry,
      session: {
        async call() {
          return {
            success: true,
            output: "SECRET_TOOL_RESULT",
            truncated: false,
            originalTokenCount: 1,
            codec: "test",
          };
        },
      },
    });
    const checkpoint = (await store.load())!;
    const auditRecords = await audit.recover(checkpoint.auditCursor);
    const spans = exporter.getFinishedSpans();
    expect(spans.filter((span) => span.name === "chat")).toHaveLength(checkpoint.counters.modelCalls);
    expect(spans.filter((span) => span.name === "execute_tool")).toHaveLength(
      auditRecords.filter((record) => record.type === "tool_terminal").length,
    );
    expect(spans.filter((span) => span.name === "execute_hook")).toHaveLength(3);
    expect(result.toolCalls).toBe(1);

    const exported = JSON.stringify(spans.map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
      status: span.status,
    })));
    for (const secret of [
      prepared.task,
      "SECRET_PATH.ts",
      "SECRET_TOOL_RESULT",
      "SECRET_TITLE",
      "SECRET_MESSAGE",
    ]) {
      expect(exported).not.toContain(secret);
    }
    expect(exported).not.toContain("task.text");
    await telemetry.finishRun("ok", { "task.text": prepared.task });
  });

  test("stays disabled for incomplete configuration and still executes work", async () => {
    const telemetry = createRunTelemetryFromEnvironment({
      AGENT_TELEMETRY_ENABLED: "1",
      LANGFUSE_BASE_URL: "https://langfuse.example.test",
      LANGFUSE_PUBLIC_KEY: "public-only",
    });
    let called = 0;
    const result = await telemetry.withSpan("chat", {
      "gen_ai.operation.name": "chat",
    }, async () => {
      called += 1;
      return "ok";
    });
    await telemetry.finishRun("ok");
    expect(result).toBe("ok");
    expect(called).toBe(1);
  });

  test("does not change run behavior when the exporter rejects every span", async () => {
    const failingExporter: SpanExporter = {
      export(_spans, callback) {
        callback({ code: 1, error: new Error("SECRET_EXPORT_FAILURE") });
      },
      async shutdown() {},
    };
    const telemetry = new OpenTelemetryRunTelemetry({
      exporter: failingExporter,
      processor: "simple",
      flushTimeoutMs: 50,
    });
    telemetry.startRun({ "agent.run.id": prepared.runIdentity });

    const result = await telemetry.withSpan("chat", {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "claude-haiku-4-5",
    }, async () => "completed");
    telemetry.recordCompletedSpan({
      name: "execute_hook",
      durationMs: 1,
      outcome: "ok",
      attributes: {
        "gen_ai.operation.name": "execute_hook",
        "agent.hook.name": "PreToolUse",
        "agent.hook.index": 0,
      },
    });
    await telemetry.finishRun("ok");

    expect(result).toBe("completed");
  });
});

function runtimeFor(turns: ModelTurn[]): ModelRuntime {
  let index = 0;
  return {
    identity: { provider: "injected", model: "claude-haiku-4-5" },
    async countRequestTokens(_request: ModelRequest) {
      return { tokens: 10, source: "provider" as const };
    },
    async call() {
      const value = turns[index++];
      if (!value) throw new Error("Unexpected model call.");
      return {
        ...value,
        actualIdentity: { provider: "injected", model: "claude-haiku-4-5" },
        providerCostMicroUsd: 10,
      };
    },
  };
}

function turn(
  status: "in_progress" | "completed",
  action?: ModelTurn["content"][number],
): ModelTurn {
  return {
    content: [{
      type: "tool_use",
      id: crypto.randomUUID(),
      name: "rewrite_plan",
      input: {
        plan: [{ id: "work", description: "Complete work", status }],
      },
    }, ...(action ? [action] : [])],
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function baseState(): ProductionAgentState {
  return {
    version: 4,
    ...prepared,
    approval: createLegacyExecutionApprovalState(),
    promptStatus: "accepted",
    appendedPromptContext: "",
    lifecycle: "running",
    plan: [],
    transcript: [{
      role: "user",
      content: `Complete the following repository task:\n${prepared.task}\n\nFirst create a concrete plan, then perform one safe action per turn.`,
    }],
    lastToolSucceeded: null,
    pendingTurn: null,
    pendingModelCall: null,
    limits: { maxModelCalls: 50, compactAtTokens: 150_000, maxContextTokens: 200_000, maxProjectedCostMicroUsd: 5_000_000, compactAtCheckpointBytes: 1_572_864, maxCheckpointBytes: 2 * 1024 * 1024 },
    pricing: { catalogVersion: 1, identity: { provider: "injected", model: "claude-haiku-4-5" }, inputRateMicroUsdPerMillion: 1_000_000, outputRateMicroUsdPerMillion: 5_000_000 },
    context: { lastEstimateTokens: 0, estimateSource: null, requestFingerprint: null },
    cost: { projectedMicroUsd: 0, observedMicroUsd: 0, observedAvailable: false, driftMicroUsd: 0 },
    compaction: { count: 0, lastPreTokens: 0, lastPostTokens: 0, baselineCommittedTurns: 0, baselineProtocolRetries: 0, baselineToolCalls: 0, baselinePlanRewrites: 0, baselineStopRejections: 0 },
    notificationKeys: [],
    lastNotification: null,
    counters: { modelTurns: 0, modelCalls: 0, agentCalls: 0, compactionCalls: 0, stopRejections: 0, committedTurns: 0, protocolRetries: 0, toolCalls: 0, planRewrites: 0, inputTokens: 0, outputTokens: 0 },
    consecutiveInvalidAttempts: 0,
    terminalCode: null,
    terminalError: null,
    lastToolResult: null,
    auditCursor: { sequence: 0, digest: "0".repeat(64) },
    verificationEvidence: [],
    completion: null,
    legacyCompletionStatus: null,
  };
}
