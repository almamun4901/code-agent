import { z } from "zod";
import {
  ConversationMessageSchema,
  TodoItemSchema,
} from "../plan/schema";

const toolResultSchema = z
  .object({
    success: z.boolean(),
    output: z.string(),
    truncated: z.boolean(),
    originalTokenCount: z.number().int().nonnegative(),
    codec: z.string(),
    metadata: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      )
      .optional(),
  })
  .strict();

const modelToolRequestSchema = z
  .object({
    name: z.enum([
      "read_file",
      "edit_file",
      "ripgrep",
      "tree_sitter_symbols",
      "run_shell",
      "git",
    ]),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();

const pendingTurnSchema = z
  .object({
    assistantContent: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }).strict(),
        z
          .object({
            type: z.literal("tool_use"),
            id: z.string().min(1),
            name: z.string().min(1),
            input: z.unknown(),
          })
          .strict(),
      ]),
    ),
    plan: z.array(TodoItemSchema).min(1).max(20),
    planToolId: z.string().min(1),
    action: z
      .object({
        toolUseId: z.string().min(1),
        operationId: z.string().uuid(),
        request: modelToolRequestSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

export const ProductionAgentStateSchema = z
  .object({
    version: z.literal(2),
    runIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    canonicalRepoPath: z.string().startsWith("/"),
    task: z.string().min(1),
    lifecycle: z.enum(["running", "completed", "failed"]),
    plan: z.array(TodoItemSchema).max(20),
    transcript: z.array(ConversationMessageSchema).min(1),
    lastToolSucceeded: z.boolean().nullable(),
    pendingTurn: pendingTurnSchema.nullable(),
    counters: z
      .object({
        modelTurns: z.number().int().nonnegative(),
        committedTurns: z.number().int().nonnegative(),
        protocolRetries: z.number().int().nonnegative(),
        toolCalls: z.number().int().nonnegative(),
        planRewrites: z.number().int().nonnegative(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict(),
    consecutiveInvalidAttempts: z.number().int().min(0).max(1),
    terminalError: z.string().min(1).nullable(),
    lastToolResult: toolResultSchema.nullable(),
  })
  .strict();

export type ProductionAgentState = z.infer<
  typeof ProductionAgentStateSchema
>;
export type PendingProductionTurn = NonNullable<
  ProductionAgentState["pendingTurn"]
>;
