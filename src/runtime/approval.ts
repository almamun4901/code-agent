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

const boundedText = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value),
  "Control characters are not allowed.",
);
const scopedItemSchema = z.object({
  name: boundedText(256),
  rationale: boundedText(2_048),
}).strict();
const repositoryRelativePath = boundedText(512).refine(
  (value) => value === "." || (!value.startsWith("/") && !value.split("/").includes("..")),
  "Working directory must be a repository-relative path without parent traversal.",
);
const verificationRequirementBaseSchema = z.object({
  id: boundedText(128),
  label: boundedText(256),
  workingDirectory: repositoryRelativePath,
});
export const CommandVerificationRequirementSchema = verificationRequirementBaseSchema.extend({
  type: z.literal("command"),
  command: boundedText(4_096),
  timeoutMs: z.number().int().min(1).max(30_000),
}).strict();
const viewportCaseSchema = z.object({
  route: boundedText(512).refine(
    (value) => value.startsWith("/") && !value.startsWith("//") && !value.includes("://"),
    "Viewport route must be an origin-relative path.",
  ),
  width: z.number().int().min(320).max(2_560),
  height: z.number().int().min(480).max(1_600),
  requiredVisibleSelectors: z.array(boundedText(512)).max(10),
}).strict();
export const ViewportVerificationRequirementSchema = verificationRequirementBaseSchema.extend({
  type: z.literal("viewport"),
  serverCommand: boundedText(4_096),
  port: z.number().int().min(1_024).max(65_535),
  cases: z.array(viewportCaseSchema).min(1).max(12),
}).strict();
export const VerificationRequirementSchema = z.discriminatedUnion("type", [
  CommandVerificationRequirementSchema,
  ViewportVerificationRequirementSchema,
]);
const acceptanceCriterionSchema = z.object({
  id: boundedText(128),
  criterion: boundedText(2_048),
  verification: boundedText(2_048),
  verificationRequirementIds: z.array(boundedText(128)).min(1).max(20),
}).strict();
const executionTaskSchema = z.object({
  id: boundedText(128),
  description: boundedText(2_048),
}).strict();

export const PlanProposalSchema = z.object({
  approach: boundedText(8_192),
  productDirection: boundedText(4_096),
  visualDirection: z.union([z.literal("not_applicable"), boundedText(4_096)]),
  technologyChoices: z.array(scopedItemSchema).max(20),
  includedScope: z.array(boundedText(2_048)).min(1).max(30),
  excludedScope: z.array(boundedText(2_048)).max(30),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).max(30),
  verificationRequirements: z.array(VerificationRequirementSchema).min(1).max(30),
  assumptions: z.array(boundedText(2_048)).max(30),
  unresolvedQuestions: z.array(boundedText(2_048)).max(20),
  executionPlan: z.array(executionTaskSchema).min(1).max(20),
}).strict().superRefine((proposal, context) => {
  uniqueIds(proposal.acceptanceCriteria, "acceptance criterion", context);
  uniqueIds(proposal.verificationRequirements, "verification requirement", context);
  uniqueIds(proposal.executionPlan, "execution task", context);
  const requirementIds = new Set(proposal.verificationRequirements.map((requirement) => requirement.id));
  for (const [criterionIndex, criterion] of proposal.acceptanceCriteria.entries()) {
    for (const [referenceIndex, requirementId] of criterion.verificationRequirementIds.entries()) {
      if (!requirementIds.has(requirementId)) {
        context.addIssue({
          code: "custom",
          path: ["acceptanceCriteria", criterionIndex, "verificationRequirementIds", referenceIndex],
          message: `Acceptance criterion references unknown verification requirement "${requirementId}".`,
        });
      }
    }
  }
  if (proposal.visualDirection !== "not_applicable" && !proposal.verificationRequirements.some((item) => item.type === "viewport")) {
    context.addIssue({ code: "custom", path: ["verificationRequirements"], message: "Visual proposals require at least one viewport verification requirement." });
  }
  if (utf8Bytes(proposal) > 8 * 1024) {
    context.addIssue({ code: "custom", message: "Plan proposal exceeds 8 KiB." });
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
  executionBaseProposal: PlanProposalSchema.nullable().default(null),
  executionBaseDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  revision: z.number().int().nonnegative(),
  feedbackHistory: z.array(boundedText(8_192)).max(20),
  discoveryTranscript: z.array(ConversationMessageSchema).max(101),
  discoveryCommittedTurns: z.number().int().nonnegative(),
  discoveryProtocolRetries: z.number().int().nonnegative(),
  discoveryToolCalls: z.number().int().nonnegative(),
  discoveryCompactions: z.number().int().nonnegative().default(0),
  discoveryBaselineCommittedTurns: z.number().int().nonnegative().default(0),
  discoveryBaselineProtocolRetries: z.number().int().nonnegative().default(0),
  discoveryBaselineToolCalls: z.number().int().nonnegative().default(0),
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
  if ((approval.executionBaseProposal === null) !== (approval.executionBaseDigest === null)) {
    context.addIssue({ code: "custom", message: "Execution base proposal and digest must be present together." });
  }
  if (approval.executionBaseProposal && approval.executionBaseDigest !== proposalDigest(approval.executionBaseProposal)) {
    context.addIssue({ code: "custom", message: "Execution base digest does not match its proposal." });
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
  if (approval.phase === "awaiting_approval" && (approval.approvedProposalDigest !== null) !== (approval.pendingReapproval !== null)) {
    context.addIssue({ code: "custom", message: "Awaiting reapproval requires both prior approval and reapproval metadata." });
  }
  if (approval.phase === "executing" && approval.pendingReapproval !== null) {
    context.addIssue({ code: "custom", message: "Executing state cannot retain pending reapproval metadata." });
  }
  if (utf8Bytes(approval) > 512 * 1024) {
    context.addIssue({ code: "custom", message: "Approval state exceeds 512 KiB." });
  }
});

export type PlanProposal = z.infer<typeof PlanProposalSchema>;
export type VerificationRequirement = z.infer<typeof VerificationRequirementSchema>;
export type CommandVerificationRequirement = z.infer<typeof CommandVerificationRequirementSchema>;
export type ViewportVerificationRequirement = z.infer<typeof ViewportVerificationRequirementSchema>;
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
    executionBaseProposal: null,
    executionBaseDigest: null,
    revision: 0,
    feedbackHistory: [],
    discoveryTranscript: [],
    discoveryCommittedTurns: 0,
    discoveryProtocolRetries: 0,
    discoveryToolCalls: 0,
    discoveryCompactions: 0,
    discoveryBaselineCommittedTurns: 0,
    discoveryBaselineProtocolRetries: 0,
    discoveryBaselineToolCalls: 0,
    pendingDiscoveryTurn: null,
    pendingReapproval: null,
    legacyTerminal: false,
  };
}

export function createLegacyTerminalApprovalState(): ApprovalState {
  return { ...createInitialApprovalState(), phase: "executing", legacyTerminal: true };
}

export function proposalDigest(proposal: PlanProposal): string {
  return digest(stableJson(PlanProposalSchema.parse(proposal)));
}

export function protectedProposalDigest(proposal: PlanProposal): string {
  return digest(stableJson({
    approach: proposal.approach,
    productDirection: proposal.productDirection,
    visualDirection: proposal.visualDirection,
    technologyChoices: proposal.technologyChoices,
    includedScope: proposal.includedScope,
    excludedScope: proposal.excludedScope,
    acceptanceCriteria: proposal.acceptanceCriteria,
    verificationRequirements: proposal.verificationRequirements,
    assumptions: proposal.assumptions,
    unresolvedQuestions: proposal.unresolvedQuestions,
  }));
}

export function verificationContractDigest(proposal: PlanProposal): string {
  return digest(stableJson(proposal.verificationRequirements));
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
