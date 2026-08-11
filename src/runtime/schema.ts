import { z } from "zod";
import { ConversationMessageSchema, TodoItemSchema } from "../plan/schema";
import { ApprovalStateSchema } from "./approval";
import { PlanProposalSchema } from "./approval";

export const DEFAULT_BUDGET_LIMITS = {
  maxModelCalls: 50,
  compactAtTokens: 150_000,
  maxContextTokens: 200_000,
  maxProjectedCostMicroUsd: 5_000_000,
  compactAtCheckpointBytes: 1_572_864,
  maxCheckpointBytes: 2 * 1024 * 1024,
} as const;

export type BudgetLimits = {
  [K in keyof typeof DEFAULT_BUDGET_LIMITS]: number;
};

const toolResultSchema = z.object({
  success: z.boolean(),
  output: z.string(),
  truncated: z.boolean(),
  originalTokenCount: z.number().int().nonnegative(),
  codec: z.string(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
}).strict();

const modelToolRequestSchema = z.object({
  name: z.enum(["read_file", "edit_file", "ripgrep", "tree_sitter_symbols", "run_shell", "git"]),
  input: z.record(z.string(), z.unknown()),
}).strict();

const assistantBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("tool_use"), id: z.string().min(1), name: z.string().min(1), input: z.unknown() }).strict(),
]);

const pendingTurnSchema = z.object({
  assistantContent: z.array(assistantBlockSchema),
  plan: z.array(TodoItemSchema).min(1).max(20),
  planToolId: z.string().min(1).nullable(),
  action: z.object({
    toolUseId: z.string().min(1),
    operationId: z.string().uuid(),
    request: modelToolRequestSchema,
  }).strict().nullable(),
  reapproval: z.object({
    toolUseId: z.string().min(1),
    proposal: PlanProposalSchema,
    reason: z.string().trim().min(1).max(2_048),
  }).strict().nullable(),
}).strict();

const modelIdentitySchema = z.object({
  provider: z.enum(["anthropic", "openrouter", "injected"]),
  model: z.string().min(1),
}).strict();

const pricingSchema = z.object({
  catalogVersion: z.number().int().positive(),
  identity: modelIdentitySchema,
  inputRateMicroUsdPerMillion: z.number().int().nonnegative(),
  outputRateMicroUsdPerMillion: z.number().int().nonnegative(),
}).strict();

const limitsSchema = z.object({
  maxModelCalls: z.number().int().positive(),
  compactAtTokens: z.number().int().positive(),
  maxContextTokens: z.number().int().positive(),
  maxProjectedCostMicroUsd: z.number().int().positive(),
  compactAtCheckpointBytes: z.number().int().positive(),
  maxCheckpointBytes: z.number().int().positive(),
}).strict();

const summarySchema = z.object({
  version: z.literal(1),
  discoveries: z.array(z.string().max(2_048)).max(50),
  decisions: z.array(z.string().max(2_048)).max(50),
  changedFiles: z.array(z.string().max(2_048)).max(50),
  verification: z.array(z.string().max(2_048)).max(50),
  failures: z.array(z.string().max(2_048)).max(50),
  unresolved: z.array(z.string().max(2_048)).max(50),
}).strict();
export const CompactionSummarySchema = summarySchema.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 64 * 1024,
  "Compaction summary exceeds 64 KiB.",
);

const pendingResponseSchema = z.object({
  content: z.array(assistantBlockSchema),
  stopReason: z.string().nullable(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict(),
  actualIdentity: modelIdentitySchema,
  providerCostMicroUsd: z.number().int().nonnegative().optional(),
  summary: summarySchema.optional(),
}).strict();

const pendingModelCallSchema = z.object({
  id: z.string().uuid(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["agent", "compaction"]),
  inputEstimate: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative(),
  reservedCostMicroUsd: z.number().int().nonnegative(),
  sourceTranscriptDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sourceContextTokens: z.number().int().nonnegative().optional(),
  response: pendingResponseSchema.nullable(),
}).strict();

export const AuditCursorSchema = z.object({
  sequence: z.number().int().min(0).max(1_024),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const screenshotEvidenceSchema = z.object({
  path: z.string().min(1).max(1_024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(2 * 1024 * 1024),
  width: z.number().int().min(320).max(2_560),
  height: z.number().int().min(480).max(1_600),
  route: z.string().min(1).max(512),
}).strict();

export const VerificationEvidenceSchema = z.object({
  requirementId: z.string().min(1).max(128),
  operationId: z.string().uuid(),
  auditSequence: z.number().int().positive().max(1_024),
  auditRecordDigest: z.string().regex(/^[a-f0-9]{64}$/),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  candidateCommit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  candidateTree: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  status: z.enum(["satisfied", "failed", "stale"]),
  errorCode: z.string().min(1).max(64).nullable(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  screenshots: z.array(screenshotEvidenceSchema).max(12),
}).strict();

export const CompletionReceiptSchema = z.object({
  version: z.literal(1),
  runIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  approvedProposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  verificationContractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  candidateTree: z.string().regex(/^[a-f0-9]{40,64}$/),
  auditCursor: AuditCursorSchema,
  evidence: z.array(z.object({
    requirementId: z.string().min(1).max(128),
    sequence: z.number().int().positive().max(1_024),
    recordDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(30),
  resultDeliveryReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  resultTree: z.string().regex(/^[a-f0-9]{40,64}$/),
  completedAt: z.string().datetime(),
}).strict();

const ProductionAgentStateBaseSchema = z.object({
  version: z.literal(4),
  runIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  canonicalRepoPath: z.string().startsWith("/"),
  task: z.string().min(1),
  approval: ApprovalStateSchema,
  promptStatus: z.enum(["pending", "accepted", "denied"]),
  appendedPromptContext: z.string(),
  lifecycle: z.enum(["running", "finalizing", "completed", "cancelled", "failed"]),
  plan: z.array(TodoItemSchema).max(20),
  transcript: z.array(ConversationMessageSchema),
  lastToolSucceeded: z.boolean().nullable(),
  pendingTurn: pendingTurnSchema.nullable(),
  pendingModelCall: pendingModelCallSchema.nullable(),
  limits: limitsSchema,
  pricing: pricingSchema,
  context: z.object({
    lastEstimateTokens: z.number().int().nonnegative(),
    estimateSource: z.enum(["provider", "conservative_local"]).nullable(),
    requestFingerprint: z.string().nullable(),
  }).strict(),
  cost: z.object({
    projectedMicroUsd: z.number().int().nonnegative(),
    observedMicroUsd: z.number().int().nonnegative(),
    observedAvailable: z.boolean(),
    driftMicroUsd: z.number().int(),
  }).strict(),
  compaction: z.object({
    count: z.number().int().nonnegative(),
    lastPreTokens: z.number().int().nonnegative(),
    lastPostTokens: z.number().int().nonnegative(),
    baselineCommittedTurns: z.number().int().nonnegative(),
    baselineProtocolRetries: z.number().int().nonnegative(),
    baselineToolCalls: z.number().int().nonnegative(),
    baselinePlanRewrites: z.number().int().nonnegative(),
    baselineStopRejections: z.number().int().nonnegative(),
  }).strict(),
  notificationKeys: z.array(z.string().min(1).max(64)).max(16),
  lastNotification: z.object({ code: z.string().min(1).max(64), message: z.string().max(2_048) }).strict().nullable(),
  counters: z.object({
    modelTurns: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    agentCalls: z.number().int().nonnegative(),
    compactionCalls: z.number().int().nonnegative(),
    stopRejections: z.number().int().nonnegative(),
    committedTurns: z.number().int().nonnegative(),
    protocolRetries: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    planRewrites: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }).strict(),
  consecutiveInvalidAttempts: z.number().int().min(0).max(1),
  terminalCode: z.string().min(1).max(64).nullable(),
  terminalError: z.string().min(1).nullable(),
  lastToolResult: toolResultSchema.nullable(),
  auditCursor: AuditCursorSchema,
  verificationEvidence: z.array(VerificationEvidenceSchema).max(30),
  completion: CompletionReceiptSchema.nullable(),
  legacyCompletionStatus: z.enum(["verified", "legacy_unverified"]).nullable(),
}).strict();

export const LegacyV3ProductionAgentStateSchema = ProductionAgentStateBaseSchema.omit({
  auditCursor: true,
  verificationEvidence: true,
  completion: true,
  legacyCompletionStatus: true,
}).extend({ version: z.literal(3), lifecycle: z.enum(["running", "completed", "cancelled", "failed"]) }).strict();
export const PreApprovalProductionAgentStateSchema = LegacyV3ProductionAgentStateSchema.omit({ approval: true });

export const ProductionAgentStateSchema = ProductionAgentStateBaseSchema.superRefine((state, context) => {
  if (state.counters.modelTurns !== state.counters.modelCalls) {
    context.addIssue({ code: "custom", message: "modelTurns must equal modelCalls." });
  }
  if (state.counters.modelCalls !== state.counters.agentCalls + state.counters.compactionCalls) {
    context.addIssue({ code: "custom", message: "modelCalls must equal agentCalls plus compactionCalls." });
  }
  if (state.compaction.count > state.counters.compactionCalls) {
    context.addIssue({ code: "custom", message: "Installed compactions exceed compaction calls." });
  }
  if (state.promptStatus === "pending" && state.transcript.length > 0) {
    context.addIssue({ code: "custom", message: "Pending prompt checkpoint must have an empty transcript." });
  }
  if (state.promptStatus === "accepted" && state.transcript.length === 0) {
    context.addIssue({ code: "custom", message: "Accepted prompt checkpoint requires a transcript." });
  }
  if (state.approval.phase === "awaiting_approval" && (state.pendingTurn || state.pendingModelCall || state.approval.pendingDiscoveryTurn)) {
    context.addIssue({ code: "custom", message: "Awaiting approval cannot contain pending model or repository work." });
  }
  if ((state.approval.phase === "discovering" || state.approval.phase === "awaiting_approval") && state.pendingTurn?.action) {
    context.addIssue({ code: "custom", message: "Preapproval checkpoint cannot contain a repository action." });
  }
  if (state.approval.phase === "cancelled" && (state.lifecycle !== "cancelled" || state.pendingTurn || state.pendingModelCall)) {
    context.addIssue({ code: "custom", message: "Cancelled approval must be terminal without pending work." });
  }
  if (state.lifecycle === "cancelled" && state.approval.phase !== "cancelled") {
    context.addIssue({ code: "custom", message: "Cancelled lifecycle requires cancelled approval state." });
  }
  if (state.lifecycle !== "completed" && state.completion !== null) {
    context.addIssue({ code: "custom", message: "Only completed checkpoints may contain a completion receipt." });
  }
  if (state.lifecycle === "finalizing" && (state.pendingTurn !== null || state.pendingModelCall !== null)) {
    context.addIssue({ code: "custom", message: "Finalizing checkpoints cannot contain pending model work." });
  }
});

export type ProductionAgentState = z.infer<typeof ProductionAgentStateSchema>;
export type PendingProductionTurn = NonNullable<ProductionAgentState["pendingTurn"]>;
export type PendingModelCall = NonNullable<ProductionAgentState["pendingModelCall"]>;
export type CompactionSummary = z.infer<typeof CompactionSummarySchema>;
export type AuditCursor = z.infer<typeof AuditCursorSchema>;
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;
export type CompletionReceipt = z.infer<typeof CompletionReceiptSchema>;

export const LegacyProductionAgentStateSchema = z.object({
  version: z.literal(2),
  runIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  canonicalRepoPath: z.string().startsWith("/"),
  task: z.string().min(1),
  lifecycle: z.enum(["running", "completed", "failed"]),
  plan: z.array(TodoItemSchema).max(20),
  transcript: z.array(ConversationMessageSchema).min(1),
  lastToolSucceeded: z.boolean().nullable(),
  pendingTurn: pendingTurnSchema.nullable(),
  counters: z.object({
    modelTurns: z.number().int().nonnegative(), committedTurns: z.number().int().nonnegative(), protocolRetries: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(), planRewrites: z.number().int().nonnegative(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  }).strict(),
  consecutiveInvalidAttempts: z.number().int().min(0).max(1),
  terminalError: z.string().min(1).nullable(),
  lastToolResult: toolResultSchema.nullable(),
}).strict();

export type LegacyProductionAgentState = z.infer<typeof LegacyProductionAgentStateSchema>;
