import { createHash } from "node:crypto";
import { z } from "zod";
import { ConversationMessageSchema } from "../plan/schema";

const discoveryToolRequestSchema = z.object({
  name: z.enum(["read_file", "ripgrep", "tree_sitter_symbols", "git"]),
  input: z.record(z.string(), z.unknown()),
}).strict();
const assistantBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("tool_use"), id: z.string().min(1), name: z.string().min(1), input: z.unknown() }).strict(),
]);

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const scopedItemSchema = z.object({
  name: boundedText(256),
  rationale: boundedText(2_048),
}).strict();
const acceptanceCriterionSchema = z.object({
  id: boundedText(128),
  criterion: boundedText(2_048),
  verification: boundedText(2_048),
}).strict();
const executionTaskSchema = z.object({
  id: boundedText(128),
  description: boundedText(2_048),
}).strict();

export const PlanProposalSchema = z.object({
  approach: boundedText(8_192),
  visualDirection: z.union([z.literal("not_applicable"), boundedText(4_096)]),
  technologyChoices: z.array(scopedItemSchema).max(20),
  includedScope: z.array(boundedText(2_048)).min(1).max(30),
  excludedScope: z.array(boundedText(2_048)).max(30),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).max(30),
  assumptions: z.array(boundedText(2_048)).max(30),
  unresolvedQuestions: z.array(boundedText(2_048)).max(20),
  executionPlan: z.array(executionTaskSchema).min(1).max(20),
}).strict().superRefine((proposal, context) => {
  uniqueIds(proposal.acceptanceCriteria, "acceptance criterion", context);
  uniqueIds(proposal.executionPlan, "execution task", context);
  if (utf8Bytes(proposal) > 128 * 1024) {
    context.addIssue({ code: "custom", message: "Plan proposal exceeds 128 KiB." });
  }
});

export const ApprovalDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve") }).strict(),
  z.object({ kind: z.literal("revise"), feedback: boundedText(8_192) }).strict(),
  z.object({ kind: z.literal("cancel") }).strict(),
]);

export const ApprovalStateSchema = z.object({
  phase: z.enum(["discovering", "awaiting_approval", "approved", "executing", "cancelled"]),
  mode: z.enum(["interactive", "auto"]).nullable(),
  currentProposal: PlanProposalSchema.nullable(),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  approvedProposalDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  revision: z.number().int().nonnegative(),
  feedbackHistory: z.array(boundedText(8_192)).max(20),
  discoveryTranscript: z.array(ConversationMessageSchema).max(100),
  discoveryCommittedTurns: z.number().int().nonnegative(),
  discoveryProtocolRetries: z.number().int().nonnegative(),
  discoveryToolCalls: z.number().int().nonnegative(),
  pendingDiscoveryTurn: z.object({
    assistantContent: z.array(assistantBlockSchema),
    proposalToolId: z.string().min(1).nullable(),
    proposal: PlanProposalSchema.nullable(),
    action: z.object({
      toolUseId: z.string().min(1),
      operationId: z.string().uuid(),
      request: discoveryToolRequestSchema,
    }).strict().nullable(),
  }).strict().nullable(),
  pendingReapproval: z.object({
    priorDigest: z.string().regex(/^[a-f0-9]{64}$/),
    reason: boundedText(2_048),
  }).strict().nullable(),
  legacyTerminal: z.boolean(),
}).strict().superRefine((approval, context) => {
  if ((approval.currentProposal === null) !== (approval.proposalDigest === null)) {
    context.addIssue({ code: "custom", message: "Proposal and proposal digest must be present together." });
  }
  if (approval.currentProposal && approval.proposalDigest !== proposalDigest(approval.currentProposal)) {
    context.addIssue({ code: "custom", message: "Proposal digest does not match the proposal." });
  }
  if (approval.phase === "awaiting_approval" && !approval.currentProposal) {
    context.addIssue({ code: "custom", message: "Awaiting approval requires a proposal." });
  }
  if ((approval.phase === "approved" || approval.phase === "executing") && !approval.legacyTerminal) {
    if (!approval.currentProposal || approval.approvedProposalDigest !== approval.proposalDigest) {
      context.addIssue({ code: "custom", message: "Approved execution requires the current approved proposal digest." });
    }
  }
  if (approval.phase === "discovering" && approval.approvedProposalDigest !== null && !approval.pendingReapproval) {
    context.addIssue({ code: "custom", message: "Initial discovery cannot retain an approved digest." });
  }
  if (utf8Bytes(approval) > 512 * 1024) {
    context.addIssue({ code: "custom", message: "Approval state exceeds 512 KiB." });
  }
});

export type PlanProposal = z.infer<typeof PlanProposalSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;
export type ApprovalMode = "interactive" | "auto";

export type ApprovalRequest = {
  proposal: PlanProposal;
  proposalDigest: string;
  revision: number;
  reapprovalReason?: string;
};

export type RequestPlanApproval = (
  request: ApprovalRequest,
  signal?: AbortSignal,
) => Promise<ApprovalDecision>;

export function createInitialApprovalState(mode: ApprovalMode | null = null): ApprovalState {
  return {
    phase: "discovering",
    mode,
    currentProposal: null,
    proposalDigest: null,
    approvedProposalDigest: null,
    revision: 0,
    feedbackHistory: [],
    discoveryTranscript: [],
    discoveryCommittedTurns: 0,
    discoveryProtocolRetries: 0,
    discoveryToolCalls: 0,
    pendingDiscoveryTurn: null,
    pendingReapproval: null,
    legacyTerminal: false,
  };
}

export function createLegacyTerminalApprovalState(): ApprovalState {
  return { ...createInitialApprovalState(), phase: "executing", legacyTerminal: true };
}

/** Compatibility only for low-level loop fixtures; production runners must set an approval mode. */
export function createLegacyExecutionApprovalState(): ApprovalState {
  return { ...createInitialApprovalState(), phase: "executing", legacyTerminal: true };
}

export function proposalDigest(proposal: PlanProposal): string {
  return digest(stableJson(PlanProposalSchema.parse(proposal)));
}

export function protectedProposalDigest(proposal: PlanProposal): string {
  return digest(stableJson({
    visualDirection: proposal.visualDirection,
    technologyChoices: proposal.technologyChoices,
    includedScope: proposal.includedScope,
    excludedScope: proposal.excludedScope,
    acceptanceCriteria: proposal.acceptanceCriteria,
    assumptions: proposal.assumptions,
    unresolvedQuestions: proposal.unresolvedQuestions,
  }));
}

export function proposalExecutionPlan(proposal: PlanProposal) {
  return proposal.executionPlan.map((task, index) => ({
    ...task,
    status: index === 0 ? "in_progress" as const : "pending" as const,
  }));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function uniqueIds(
  values: Array<{ id: string }>,
  label: string,
  context: z.core.$RefinementCtx,
): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) {
    context.addIssue({ code: "custom", message: `Plan proposal ${label} IDs must be unique.` });
  }
}
