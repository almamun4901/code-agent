import { describe, expect, test } from "bun:test";
import { SpanStatusCode, trace } from "@opentelemetry/api";
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
  noOpTelemetry,
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
    const exporter = new RetainingInMemorySpanExporter();
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
        async call(_request, options) {
          options?.observePreToolUse?.({ index: 0, durationMs: 2, outcome: "allow" });
          options?.observePreToolUse?.({ index: 1, durationMs: 1, outcome: "allow" });
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
    await telemetry.finishRun("ok", { "task.text": prepared.task });
    const spans = exporter.getFinishedSpans();
    const root = spans.filter((span) => span.name === "invoke_agent");
    expect(root).toHaveLength(1);
    expect(spans.filter((span) => span.name === "chat")).toHaveLength(checkpoint.counters.modelCalls);
    const toolSpans = spans.filter((span) => span.name === "execute_tool");
    expect(toolSpans).toHaveLength(
      auditRecords.filter((record) => record.type === "tool_terminal").length,
    );
    const hookSpans = spans.filter((span) => span.name === "execute_hook");
    expect(hookSpans).toHaveLength(5);
    expect(spans.every((span) => span.spanContext().traceId === root[0]!.spanContext().traceId)).toBe(true);
    expect(spans.filter((span) => span !== root[0] && span.name !== "execute_hook").every(
      (span) => span.parentSpanContext?.spanId === root[0]!.spanContext().spanId,
    )).toBe(true);
    const remoteHooks = hookSpans.filter((span) => span.attributes["agent.hook.name"] === "PreToolUse");
    expect(remoteHooks).toHaveLength(2);
    expect(remoteHooks.every((span) => span.parentSpanContext?.spanId === toolSpans[0]!.spanContext().spanId)).toBe(true);
    expect(root[0]!.attributes["agent.run.outcome"]).toBe("ok");
    expect(root[0]!.status.code).toBe(SpanStatusCode.OK);
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

  test("marks returned tool failures as errors and rejects content-shaped attributes", async () => {
    const exporter = new RetainingInMemorySpanExporter();
    const telemetry = new OpenTelemetryRunTelemetry({ exporter, processor: "simple" });
    telemetry.startRun({ "agent.run.id": prepared.runIdentity });

    await telemetry.withSpan("execute_tool", {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "read_file",
    }, async (span) => {
      span.setAttributes({
        "error.type": prepared.task,
        "gen_ai.response.model": prepared.task,
      });
      span.setOutcome("error");
    });
    await telemetry.finishRun("error");

    const tool = exporter.getFinishedSpans().find((span) => span.name === "execute_tool")!;
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(tool.attributes)).not.toContain(prepared.task);
  });

  test("counts failed model transports and denied hooks as error spans", async () => {
    const exporter = new RetainingInMemorySpanExporter();
    const telemetry = new OpenTelemetryRunTelemetry({ exporter, processor: "simple" });
    telemetry.startRun({ "agent.run.id": prepared.runIdentity });
    const store = new MemoryProductionCheckpointStore(baseState());
    const failedRuntime: ModelRuntime = {
      identity: { provider: "injected", model: "claude-haiku-4-5" },
      async countRequestTokens() {
        return { tokens: 10, source: "provider" };
      },
      async call() {
        throw new Error("SECRET_PROVIDER_FAILURE");
      },
    };

    await expect(runProductionLoop({
      ...prepared,
      modelRuntime: failedRuntime,
      checkpointStore: store,
      telemetry,
      session: { async call() { throw new Error("unexpected tool call"); } },
    })).rejects.toThrow("SECRET_PROVIDER_FAILURE");
    const hooks = new LifecycleHooks().register("Stop", () => ({
      outcome: "deny",
      code: "SECRET_CODE",
      reason: "SECRET_REASON",
    }));
    await expect(hooks.runGating("Stop", {
      runIdentity: prepared.runIdentity,
      proposedPlan: [],
      budget: {
        modelCalls: 1,
        maxModelCalls: 50,
        contextTokens: 0,
        maxContextTokens: 200_000,
        projectedCostMicroUsd: 0,
        maxProjectedCostMicroUsd: 5_000_000,
        compactions: 0,
      },
    }, telemetry)).rejects.toThrow("SECRET_REASON");
    await telemetry.finishRun("error");

    const spans = exporter.getFinishedSpans();
    const failedCheckpoint = (await store.load())!;
    expect(spans.filter((span) => span.name === "chat")).toHaveLength(
      failedCheckpoint.counters.modelCalls + (failedCheckpoint.pendingModelCall ? 1 : 0),
    );
    expect(spans.find((span) => span.name === "chat")!.status.code).toBe(SpanStatusCode.ERROR);
    const hook = spans.find((span) => span.name === "execute_hook")!;
    expect(hook.status.code).toBe(SpanStatusCode.ERROR);
    expect(hook.attributes["agent.hook.outcome"]).toBe("error");
    const exported = JSON.stringify(spans.map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
      status: span.status,
    })));
    expect(exported).not.toContain("SECRET_PROVIDER_FAILURE");
    expect(exported).not.toContain("SECRET_REASON");
    expect(exported).not.toContain("SECRET_CODE");
  });

  test("does not replace the process-global tracer provider across sequential runs", async () => {
    const globalBefore = trace.getTracerProvider();
    for (let index = 0; index < 2; index += 1) {
      const telemetry = new OpenTelemetryRunTelemetry({
        exporter: new RetainingInMemorySpanExporter(),
        processor: "simple",
      });
      telemetry.startRun({ "agent.run.id": `${index}`.repeat(64) });
      await telemetry.withSpan("chat", { "gen_ai.operation.name": "chat" }, async () => {});
      await telemetry.finishRun("ok");
    }
    expect(trace.getTracerProvider()).toBe(globalBefore);
  });

  test("requires HTTPS except for literal loopback Langfuse endpoints", async () => {
    const telemetry = createRunTelemetryFromEnvironment({
      AGENT_TELEMETRY_ENABLED: "1",
      LANGFUSE_BASE_URL: "http://langfuse.example.test",
      LANGFUSE_PUBLIC_KEY: "public",
      LANGFUSE_SECRET_KEY: "secret",
    });
    expect(telemetry).toBe(noOpTelemetry);
    let called = false;
    await telemetry.withSpan("chat", { "gen_ai.operation.name": "chat" }, async () => {
      called = true;
    });
    await telemetry.finishRun("ok");
    expect(called).toBe(true);
  });

  test("bounds batch shutdown even when export completion is delayed", async () => {
    const delayedExporter: SpanExporter = {
      export(_spans, callback) {
        setTimeout(() => callback({ code: 0 }), 100);
      },
      async shutdown() {},
    };
    const telemetry = new OpenTelemetryRunTelemetry({
      exporter: delayedExporter,
      flushTimeoutMs: 10,
    });
    telemetry.startRun({ "agent.run.id": prepared.runIdentity });
    await telemetry.withSpan("chat", { "gen_ai.operation.name": "chat" }, async () => {});
    const startedAt = performance.now();
    await telemetry.finishRun("ok");
    expect(performance.now() - startedAt).toBeLessThan(80);
  });
});

class RetainingInMemorySpanExporter extends InMemorySpanExporter {
  override async shutdown(): Promise<void> {}
}

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
