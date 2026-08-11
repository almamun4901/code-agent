import { describe, expect, test } from "bun:test";
import {
  ApprovalDecisionSchema,
  ApprovalStateSchema,
  PlanProposalSchema,
  createInitialApprovalState,
  proposalDigest,
  protectedProposalDigest,
} from "../src/runtime/approval";
import { decodeProductionCheckpoint, MemoryProductionCheckpointStore, ProductionCheckpointError, type ProductionCheckpointStore } from "../src/runtime/checkpoint";
import type { ProductionAgentState } from "../src/runtime/schema";
import type { ModelRequest, ModelTurn } from "../src/model/contracts";
import {
  PlanApprovalCancelledError,
  PlanApprovalRequiredError,
  runProductionLoop,
} from "../src/runtime/production-loop";

describe("plan approval schema", () => {
  test("validates a bounded proposal and produces stable digests", () => {
    const first = proposal();
    const reordered = {
      executionPlan: first.executionPlan,
      unresolvedQuestions: first.unresolvedQuestions,
      assumptions: first.assumptions,
      acceptanceCriteria: first.acceptanceCriteria,
      verificationRequirements: first.verificationRequirements,
      excludedScope: first.excludedScope,
      includedScope: first.includedScope,
      technologyChoices: first.technologyChoices,
      productDirection: first.productDirection,
      visualDirection: first.visualDirection,
      approach: first.approach,
    };
    expect(PlanProposalSchema.parse(first)).toEqual(first);
    expect(proposalDigest(first)).toBe(proposalDigest(reordered));
    expect(protectedProposalDigest(first)).toHaveLength(64);
  });

  test("rejects duplicate task IDs and oversized feedback", () => {
    const duplicate = proposal();
    duplicate.executionPlan.push({ ...duplicate.executionPlan[0]! });
    expect(PlanProposalSchema.safeParse(duplicate).success).toBe(false);
    expect(ApprovalDecisionSchema.safeParse({ kind: "revise", feedback: "x".repeat(8_193) }).success).toBe(false);
    expect(PlanProposalSchema.safeParse({ ...proposal(), productDirection: undefined }).success).toBe(false);
    expect(PlanProposalSchema.safeParse({ ...proposal(), approach: "unsafe\u202Etext" }).success).toBe(false);
  });

  test("validates verification references, closed bounds, visual evidence, and protected digests", () => {
    const valid = proposal();
    expect(PlanProposalSchema.safeParse({ ...valid, acceptanceCriteria: [{ ...valid.acceptanceCriteria[0]!, verificationRequirementIds: ["missing"] }] }).success).toBe(false);
    expect(PlanProposalSchema.safeParse({ ...valid, verificationRequirements: [...valid.verificationRequirements, { ...valid.verificationRequirements[0] }] }).success).toBe(false);
    expect(PlanProposalSchema.safeParse({ ...valid, visualDirection: "Responsive application" }).success).toBe(false);
    const viewport = { type: "viewport" as const, id: "viewport", label: "Responsive page", workingDirectory: ".", serverCommand: "bun run dev", port: 3000, cases: [{ route: "/", width: 375, height: 812, requiredVisibleSelectors: ["main"] }] };
    expect(PlanProposalSchema.safeParse({ ...valid, visualDirection: "Responsive application", verificationRequirements: [...valid.verificationRequirements, viewport] }).success).toBe(true);
    expect(protectedProposalDigest(valid)).not.toBe(protectedProposalDigest({ ...valid, verificationRequirements: [{ ...valid.verificationRequirements[0]!, command: "bun test --watch" }] }));
  });

  test("requires a matching digest while awaiting approval", () => {
    const current = proposal();
    expect(ApprovalStateSchema.safeParse({
      ...createInitialApprovalState("interactive"),
      phase: "awaiting_approval",
      currentProposal: current,
      proposalDigest: "0".repeat(64),
      revision: 1,
    }).success).toBe(false);
  });

  test("migrates an empty preapproval v3 checkpoint and refuses active history", () => {
    const legacy = preapprovalState();
    expect(decodeProductionCheckpoint(legacy).approval.phase).toBe("discovering");
    const active = {
      ...legacy,
      counters: { ...legacy.counters, modelTurns: 1, modelCalls: 1, agentCalls: 1 },
    };
    expect(() => decodeProductionCheckpoint(active)).toThrow(ProductionCheckpointError);
    expect(() => decodeProductionCheckpoint(active)).toThrow("APPROVAL_MIGRATION_REQUIRED");
  });

  test("labels terminal v3 checkpoints unverified and refuses active v3 execution", () => {
    expect(decodeProductionCheckpoint({ ...preapprovalState(), lifecycle: "completed" })).toMatchObject({ version: 4, lifecycle: "completed", legacyCompletionStatus: "legacy_unverified", completion: null });
    const approved = proposal();
    const digest = proposalDigest(approved);
    const executing = {
      ...preapprovalState(),
      approval: { ...createInitialApprovalState("auto"), phase: "executing" as const, currentProposal: approved, proposalDigest: digest, approvedProposalDigest: digest },
    };
    expect(() => decodeProductionCheckpoint(executing)).toThrow("COMPLETION_MIGRATION_REQUIRED");
  });
});

describe("read-only plan discovery", () => {
  test("exposes only read tools, checkpoints a proposal, and resumes without spending", async () => {
    const requests: ModelRequest[] = [];
    const turns = [
      discoveryTurn("read_file", { path: "README.md" }),
      discoveryTurn("propose_plan", proposal()),
    ];
    let calls = 0;
    const store = new (await import("../src/runtime/checkpoint")).MemoryProductionCheckpointStore();
    const sessionCalls: string[] = [];
    const options = {
      canonicalRepoPath: "/tmp/approval-discovery",
      task: "Add approval",
      runIdentity: "b".repeat(64),
      approvalMode: "interactive" as const,
      checkpointStore: store,
      callModel: async (request: ModelRequest) => {
        requests.push(request);
        const turn = turns[calls++];
        if (!turn) throw new Error("Unexpected paid call.");
        return turn;
      },
      session: {
        async call(request: { name: string }) {
          sessionCalls.push(request.name);
          return { success: true, output: "read", truncated: false, originalTokenCount: 1, codec: "test" };
        },
      },
    };
    await expect(runProductionLoop(options)).rejects.toBeInstanceOf(PlanApprovalRequiredError);
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read_file", "ripgrep", "tree_sitter_symbols", "git", "propose_plan",
    ]);
    expect(requests[0]?.tools.find((tool) => tool.name === "git")?.inputSchema.properties.subcommand).toEqual({ type: "string", enum: ["status", "diff"] });
    expect(sessionCalls).toEqual(["read_file"]);
    expect(await store.load()).toMatchObject({
      approval: { phase: "awaiting_approval", revision: 1, discoveryCommittedTurns: 2, discoveryToolCalls: 1 },
      counters: { modelCalls: 2, committedTurns: 2, toolCalls: 1 },
    });
    await expect(runProductionLoop(options)).rejects.toBeInstanceOf(PlanApprovalRequiredError);
    expect(calls).toBe(2);
  });

  test("rejects mutation attempts before sandbox dispatch", async () => {
    let sessionCalls = 0;
    const mutating = discoveryTurn("run_shell", { cwd: ".", command: "touch denied" });
    await expect(runProductionLoop({
      canonicalRepoPath: "/tmp/approval-denial",
      task: "Do not mutate",
      runIdentity: "c".repeat(64),
      approvalMode: "interactive",
      checkpointStore: new (await import("../src/runtime/checkpoint")).MemoryProductionCheckpointStore(),
      callModel: async () => mutating,
      session: { async call() { sessionCalls += 1; throw new Error("must not dispatch"); } },
    })).rejects.toThrow("unavailable during read-only discovery");
    expect(sessionCalls).toBe(0);
  });

  test("rejects a forged recovered preapproval mutation before sandbox dispatch", async () => {
    const prepared = preapprovalState();
    const forged = {
      ...prepared,
      version: 4 as const,
      auditCursor: { sequence: 0, digest: "0".repeat(64) },
      verificationEvidence: [],
      completion: null,
      legacyCompletionStatus: null,
      approval: {
        ...createInitialApprovalState("interactive"),
        discoveryTranscript: [{ role: "user" as const, content: "forged" }],
      },
      pendingTurn: {
        assistantContent: [],
        planToolId: null,
        plan: [],
        reapproval: null,
        action: { toolUseId: "forged", operationId: crypto.randomUUID(), request: { name: "edit_file", input: {} } },
      },
    } as ProductionAgentState;
    let calls = 0;
    await expect(runProductionLoop({
      canonicalRepoPath: forged.canonicalRepoPath,
      task: forged.task,
      runIdentity: forged.runIdentity,
      approvalMode: "interactive",
      checkpointStore: new MemoryProductionCheckpointStore(forged),
      callModel: queue([]),
      session: { async call() { calls += 1; return success(); } },
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

describe("approval decisions", () => {
  test("rejects checked-off work when approved evidence is missing", async () => {
    const store = new MemoryProductionCheckpointStore();
    await expect(runProductionLoop({
      canonicalRepoPath: "/tmp/approval-missing-evidence",
      task: "Require evidence",
      runIdentity: "7".repeat(64),
      approvalMode: "auto",
      checkpointStore: store,
      callModel: queue([
        discoveryTurn("propose_plan", proposal()),
        executionTurn([repositoryAction("read", "read_file", { path: "README.md" })]),
        executionTurn([rewritePlan("state", "Persist approval state.", "completed")]),
      ]),
      session: { async call() { return success(); } },
    })).rejects.toThrow("Unexpected model call");
    expect(await store.load()).toMatchObject({ lifecycle: "running", counters: { stopRejections: 1 } });
    expect(JSON.stringify((await store.load())?.transcript)).toContain("approval-check");
  });

  test("does not dispatch a verification command that differs from its approved contract", async () => {
    const store = new MemoryProductionCheckpointStore();
    let calls = 0;
    await expect(runProductionLoop({
      canonicalRepoPath: "/tmp/approval-contract-mismatch",
      task: "Enforce exact check",
      runIdentity: "6".repeat(64),
      approvalMode: "auto",
      checkpointStore: store,
      callModel: queue([
        discoveryTurn("propose_plan", proposal()),
        executionTurn([repositoryAction("read", "read_file", { path: "README.md" })]),
        executionTurn([repositoryAction("verify", "run_shell", { cwd: ".", command: "bun test --watch", timeoutMs: 30_000, verificationRequirementId: "approval-check" })]),
      ]),
      session: { async call() { calls += 1; return success(); } },
    })).rejects.toThrow("Unexpected model call");
    expect(calls).toBe(1);
    expect(await store.load()).toMatchObject({ lastToolResult: { success: false, metadata: { code: "VERIFICATION_CONTRACT_MISMATCH" } } });
  });

  test("marks valid evidence stale after a later mutation", async () => {
    const store = new MemoryProductionCheckpointStore();
    await expect(runProductionLoop({
      canonicalRepoPath: "/tmp/approval-stale-evidence",
      task: "Stale evidence",
      runIdentity: "5".repeat(64),
      approvalMode: "auto",
      checkpointStore: store,
      callModel: queue([
        discoveryTurn("propose_plan", proposal()),
        executionTurn([repositoryAction("read", "read_file", { path: "README.md" })]),
        executionTurn([verificationAction()]),
        executionTurn([repositoryAction("edit", "edit_file", { path: "README.md", mode: "apply", oldText: "old", newText: "new" })]),
        executionTurn([rewritePlan("state", "Persist approval state.", "completed")]),
      ]),
      session: { async call() { return success(); } },
    })).rejects.toThrow("Unexpected model call");
    expect(await store.load()).toMatchObject({ verificationEvidence: [{ requirementId: "approval-check", status: "stale", errorCode: "POST_CHECK_MUTATION" }] });
  });

  test("auto approval durably installs the plan before repository work", async () => {
    const store = new (await import("../src/runtime/checkpoint")).MemoryProductionCheckpointStore();
    const calls: string[] = [];
    const turns = queue([
      discoveryTurn("propose_plan", proposal()),
      executionTurn([repositoryAction("read", "read_file", { path: "README.md" })]),
      executionTurn([verificationAction()]),
      executionTurn([rewritePlan("state", "Persist approval state.", "completed")]),
    ]);
    await expect(runProductionLoop({
      canonicalRepoPath: "/tmp/approval-auto",
      task: "Add approval",
      runIdentity: "d".repeat(64),
      approvalMode: "auto" as const,
      checkpointStore: store,
      callModel: turns,
      session: { async call(request: { name: string }) { calls.push(request.name); return success(); } },
    })).resolves.toMatchObject({ status: "finalizing" });
    expect(calls).toEqual(["read_file", "run_shell"]);
    expect(await store.load()).toMatchObject({ approval: { phase: "executing", mode: "auto", revision: 1 } });
  });

  test("resumes immediately after approved plan installation without another discovery call", async () => {
    const backing = new MemoryProductionCheckpointStore();
    const crashing = crashAfterSave(backing, (state) => state.approval.phase === "executing" && state.counters.modelCalls === 1);
    let discoveryCalls = 0;
    await expect(runProductionLoop({
      canonicalRepoPath: "/tmp/approval-install-crash",
      task: "Recover approval install",
      runIdentity: "9".repeat(64),
      approvalMode: "auto",
      checkpointStore: crashing,
      callModel: async () => { discoveryCalls += 1; return discoveryTurn("propose_plan", proposal()); },
      session: { async call() { return success(); } },
    })).rejects.toThrow("simulated checkpoint crash");
    await expect(runProductionLoop({
      canonicalRepoPath: "/tmp/approval-install-crash",
      task: "Recover approval install",
      runIdentity: "9".repeat(64),
      approvalMode: "auto",
      checkpointStore: backing,
      callModel: queue([
        executionTurn([repositoryAction("read", "read_file", { path: "README.md" })]),
        executionTurn([verificationAction()]),
        executionTurn([rewritePlan("state", "Persist approval state.", "completed")]),
      ]),
      session: { async call() { return success(); } },
    })).resolves.toMatchObject({ status: "finalizing" });
    expect(discoveryCalls).toBe(1);
  });

  test("an abort racing an uncooperative approval handler preserves awaiting approval", async () => {
    const store = new MemoryProductionCheckpointStore();
    const abort = new AbortController();
    await expect(runProductionLoop({
      canonicalRepoPath: "/tmp/approval-abort",
      task: "Interrupt approval",
      runIdentity: "8".repeat(64),
      approvalMode: "interactive",
      checkpointStore: store,
      callModel: queue([discoveryTurn("propose_plan", proposal())]),
      requestApproval: async () => { abort.abort(); return { kind: "approve" }; },
      signal: abort.signal,
      session: { async call() { return success(); } },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.load()).toMatchObject({ lifecycle: "running", approval: { phase: "awaiting_approval" } });
  });

  test("revision feedback is canonical and a second proposal is approved", async () => {
    const first = proposal();
    const second = { ...proposal(), approach: "Use the existing runtime boundaries." };
    const requests: ModelRequest[] = [];
    const turns = [
      discoveryTurn("propose_plan", first),
      discoveryTurn("propose_plan", second),
      executionTurn([repositoryAction("read", "read_file", { path: "README.md" })]),
      executionTurn([verificationAction()]),
      executionTurn([rewritePlan("state", "Persist approval state.", "completed")]),
    ];
    let modelCalls = 0;
    let decisions = 0;
    const store = new (await import("../src/runtime/checkpoint")).MemoryProductionCheckpointStore();
    await runProductionLoop({
      canonicalRepoPath: "/tmp/approval-revise",
      task: "Add approval",
      runIdentity: "e".repeat(64),
      approvalMode: "interactive",
      requestApproval: async () => decisions++ === 0
        ? { kind: "revise", feedback: "Prefer existing boundaries." }
        : { kind: "approve" },
      checkpointStore: store,
      callModel: async (request) => { requests.push(request); return turns[modelCalls++]!; },
      session: { async call() { return success(); } },
    });
    expect(decisions).toBe(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain("Prefer existing boundaries.");
    expect(await store.load()).toMatchObject({ approval: { revision: 2, feedbackHistory: ["Prefer existing boundaries."] } });
  });

  test("explicit cancel is terminal and never dispatches or delivers work", async () => {
    const store = new (await import("../src/runtime/checkpoint")).MemoryProductionCheckpointStore();
    let sessionCalls = 0;
    await expect(runProductionLoop({
      canonicalRepoPath: "/tmp/approval-cancel",
      task: "Cancel approval",
      runIdentity: "f".repeat(64),
      approvalMode: "interactive",
      requestApproval: async () => ({ kind: "cancel" }),
      checkpointStore: store,
      callModel: queue([discoveryTurn("propose_plan", proposal())]),
      session: { async call() { sessionCalls += 1; return success(); } },
    })).rejects.toBeInstanceOf(PlanApprovalCancelledError);
    expect(sessionCalls).toBe(0);
    expect(await store.load()).toMatchObject({ lifecycle: "cancelled", terminalCode: "PLAN_CANCELLED", approval: { phase: "cancelled" } });
  });

  test("material intent changes return through approval before more work", async () => {
    const original = proposal();
    const replacement = {
      ...proposal(),
      includedScope: [...proposal().includedScope, "Material replacement"],
      executionPlan: [{ id: "replacement", description: "Implement replacement scope." }],
    };
    const turns = queue([
      discoveryTurn("propose_plan", original),
      executionTurn([
        rewritePlan("state", "Persist approval state.", "in_progress"),
        repositoryAction("reapprove", "request_reapproval", { proposalJson: JSON.stringify(replacement), reason: "The repository requires replacement scope." }),
      ]),
      executionTurn([repositoryAction("read", "read_file", { path: "README.md" })]),
      executionTurn([verificationAction("replacement")]),
      executionTurn([rewritePlan("replacement", "Implement replacement scope.", "completed")]),
    ]);
    const store = new (await import("../src/runtime/checkpoint")).MemoryProductionCheckpointStore();
    const options = {
      canonicalRepoPath: "/tmp/approval-material",
      task: "Reapprove material scope",
      runIdentity: "1".repeat(64),
      approvalMode: "auto" as const,
      checkpointStore: store,
      callModel: turns,
      session: { async call() { return success(); } },
    };
    await runProductionLoop(options);
    expect(await store.load()).toMatchObject({ approval: { phase: "executing", revision: 2 }, plan: [{ id: "replacement", status: "completed" }] });
    await expect(runProductionLoop({ ...options, callModel: queue([]) })).resolves.toMatchObject({ status: "finalizing" });
  });
});

function proposal() {
  return {
    approach: "Add a durable approval boundary.",
    productDirection: "Require deliberate approval before repository delivery.",
    visualDirection: "not_applicable" as const,
    technologyChoices: [{ name: "Zod", rationale: "Validate persisted state." }],
    includedScope: ["Read-only discovery", "Approval recovery"],
    excludedScope: ["Remote approvers"],
    acceptanceCriteria: [{ id: "approval", criterion: "No mutation before approval.", verification: "Assert the session receives no mutating call.", verificationRequirementIds: ["approval-check"] }],
    verificationRequirements: [{ type: "command" as const, id: "approval-check", label: "Run approval test", workingDirectory: ".", command: "bun test tests/plan-approval.test.ts", timeoutMs: 30_000 }],
    assumptions: ["Approval is local and single-user."],
    unresolvedQuestions: [],
    executionPlan: [{ id: "state", description: "Persist approval state." }],
  };
}

function discoveryTurn(name: string, input: unknown): ModelTurn {
  return {
    content: [{ type: "tool_use", id: crypto.randomUUID(), name, input }],
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function queue(turns: ModelTurn[]) {
  let index = 0;
  return async () => {
    const turn = turns[index++];
    if (!turn) throw new Error("Unexpected model call.");
    return turn;
  };
}

function verificationAction(_taskId = "state") {
  return repositoryAction("verify", "run_shell", { cwd: ".", command: "bun test tests/plan-approval.test.ts", timeoutMs: 30_000, verificationRequirementId: "approval-check" });
}

function executionTurn(content: ModelTurn["content"]): ModelTurn {
  return { content, stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } };
}

function repositoryAction(id: string, name: string, input: unknown) {
  return { type: "tool_use" as const, id, name, input };
}

function rewritePlan(id: string, description: string, status: "pending" | "in_progress" | "completed") {
  return repositoryAction(crypto.randomUUID(), "rewrite_plan", { plan: [{ id, description, status }] });
}

function success() {
  return { success: true, output: "ok", truncated: false, originalTokenCount: 1, codec: "test", metadata: { exitCode: 0, timedOut: false, gitCommitBefore: "a".repeat(40), gitTreeBefore: "b".repeat(40), gitCleanBefore: true, gitCommitAfter: "a".repeat(40), gitTreeAfter: "b".repeat(40), gitCleanAfter: true } };
}

function crashAfterSave(
  backing: MemoryProductionCheckpointStore,
  predicate: (state: ProductionAgentState) => boolean,
): ProductionCheckpointStore {
  let crashed = false;
  return {
    load: () => backing.load(),
    async save(state) {
      await backing.save(state);
      if (!crashed && predicate(state)) {
        crashed = true;
        throw new Error("simulated checkpoint crash");
      }
    },
  };
}

function preapprovalState() {
  return {
    version: 3,
    runIdentity: "a".repeat(64),
    canonicalRepoPath: "/tmp/approval",
    task: "Add approval",
    promptStatus: "accepted",
    appendedPromptContext: "",
    lifecycle: "running",
    plan: [],
    transcript: [{ role: "user", content: "legacy" }],
    lastToolSucceeded: null,
    pendingTurn: null,
    pendingModelCall: null,
    limits: { maxModelCalls: 50, compactAtTokens: 150_000, maxContextTokens: 200_000, maxProjectedCostMicroUsd: 5_000_000, compactAtCheckpointBytes: 1_572_864, maxCheckpointBytes: 2_097_152 },
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
  };
}
