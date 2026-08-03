import { describe, expect, test } from "bun:test";
import {
  ApprovalDecisionSchema,
  ApprovalStateSchema,
  PlanProposalSchema,
  createInitialApprovalState,
  proposalDigest,
  protectedProposalDigest,
} from "../src/runtime/approval";
import { decodeProductionCheckpoint, ProductionCheckpointError } from "../src/runtime/checkpoint";
import type { ProductionAgentState } from "../src/runtime/schema";

describe("plan approval schema", () => {
  test("validates a bounded proposal and produces stable digests", () => {
    const first = proposal();
    const reordered = {
      executionPlan: first.executionPlan,
      unresolvedQuestions: first.unresolvedQuestions,
      assumptions: first.assumptions,
      acceptanceCriteria: first.acceptanceCriteria,
      excludedScope: first.excludedScope,
      includedScope: first.includedScope,
      technologyChoices: first.technologyChoices,
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
});

function proposal() {
  return {
    approach: "Add a durable approval boundary.",
    visualDirection: "not_applicable" as const,
    technologyChoices: [{ name: "Zod", rationale: "Validate persisted state." }],
    includedScope: ["Read-only discovery", "Approval recovery"],
    excludedScope: ["Remote approvers"],
    acceptanceCriteria: [{ id: "approval", criterion: "No mutation before approval.", verification: "Assert the session receives no mutating call." }],
    assumptions: ["Approval is local and single-user."],
    unresolvedQuestions: [],
    executionPlan: [{ id: "state", description: "Persist approval state." }],
  };
}

function preapprovalState(): Omit<ProductionAgentState, "approval"> {
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
