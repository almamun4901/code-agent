import { z } from "zod";
import { ConversationMessageSchema, TodoItemSchema } from "../plan/schema";

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

export const ProductionAgentStateSchema = z.object({
  version: z.literal(3),
  runIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  canonicalRepoPath: z.string().startsWith("/"),
  task: z.string().min(1),
  promptStatus: z.enum(["pending", "accepted", "denied"]),
  appendedPromptContext: z.string(),
  lifecycle: z.enum(["running", "completed", "failed"]),
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
}).strict().superRefine((state, context) => {
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
});

export type ProductionAgentState = z.infer<typeof ProductionAgentStateSchema>;
export type PendingProductionTurn = NonNullable<ProductionAgentState["pendingTurn"]>;
export type PendingModelCall = NonNullable<ProductionAgentState["pendingModelCall"]>;
export type CompactionSummary = z.infer<typeof CompactionSummarySchema>;

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
