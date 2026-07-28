import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
]);

export const TodoItemSchema = z
  .object({
    id: z.string().min(1).refine((value) => value.trim().length > 0, {
      message: "ID must contain a non-whitespace character",
    }),
    description: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, {
        message: "Description must contain a non-whitespace character",
      }),
    status: TaskStatusSchema,
  })
  .strict();

export const TodoWriteInputSchema = z
  .object({
    plan: z.array(TodoItemSchema).min(1),
  })
  .strict();

const TextBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

const ToolUseBlockSchema = z
  .object({
    type: z.literal("tool_use"),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  })
  .strict();

const ToolResultBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    toolUseId: z.string().min(1),
    content: z.string(),
    isError: z.boolean().optional(),
  })
  .strict();

export const ConversationMessageSchema = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("user"),
      content: z.union([
        z.string(),
        z.array(z.union([TextBlockSchema, ToolResultBlockSchema])),
      ]),
    })
    .strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.array(z.union([TextBlockSchema, ToolUseBlockSchema])),
    })
    .strict(),
]);

export const AgentStateV1Schema = z
  .object({
    version: z.literal(1),
    runIdentity: z.string().min(1),
    lifecycle: z.enum(["running", "completed", "failed"]),
    plan: z.array(TodoItemSchema).min(1),
    transcript: z.array(ConversationMessageSchema).min(1),
    lastReadSucceeded: z.boolean().nullable(),
    counters: z
      .object({
        modelTurns: z.number().int().nonnegative(),
        committedTurns: z.number().int().nonnegative(),
        protocolRetries: z.number().int().nonnegative(),
        readCalls: z.number().int().nonnegative(),
        planRewrites: z.number().int().nonnegative(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict(),
    consecutiveInvalidAttempts: z.number().int().min(0).max(1),
    terminalError: z.string().min(1).nullable(),
  })
  .strict();

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TodoItem = z.infer<typeof TodoItemSchema>;
export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;
export type AgentStateV1 = z.infer<typeof AgentStateV1Schema>;
