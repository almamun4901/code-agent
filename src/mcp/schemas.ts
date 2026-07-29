import { z } from "zod";

const relativePath = z
  .string()
  .describe("Repository-relative POSIX path.");

export const readFileInputSchema = z
  .object({
    path: relativePath,
    startLine: z.number().int().optional(),
    endLine: z.number().int().optional(),
  })
  .strict();

export const editFileInputSchema = z
  .object({
    path: relativePath,
    mode: z.enum(["preview", "apply"]),
    oldText: z.string().nullable(),
    newText: z.string(),
    replaceAll: z.boolean().optional(),
    baseVersion: z.string().optional(),
  })
  .strict();

export const ripgrepInputSchema = z
  .object({
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional(),
    caseSensitive: z.boolean().optional(),
    fixedString: z.boolean().optional(),
  })
  .strict();

export const treeSitterSymbolsInputSchema = z
  .object({
    path: relativePath,
  })
  .strict();

export const runShellInputSchema = z
  .object({
    cwd: relativePath,
    command: z.string(),
    timeoutMs: z.number().int().optional(),
  })
  .strict();

export const gitOperationSchema = z.discriminatedUnion("subcommand", [
  z
    .object({
      subcommand: z.literal("status"),
    })
    .strict(),
  z
    .object({
      subcommand: z.literal("diff"),
      staged: z.boolean().optional(),
      path: z.string().optional(),
    })
    .strict(),
  z
    .object({
      subcommand: z.literal("commit"),
      message: z.string(),
      addAll: z.boolean(),
    })
    .strict(),
]);

const gitOperationJsonSchema = z.toJSONSchema(gitOperationSchema) as {
  oneOf: unknown[];
};

// MCP SDK v1.30 only publishes object-shaped Zod schemas during tools/list.
// Keep discriminated runtime validation while carrying its exact branches into
// the object schema emitted for discovery.
export const gitInputSchema = z
  .object({
    subcommand: z.enum(["status", "diff", "commit"]),
    staged: z.boolean().optional(),
    path: z.string().optional(),
    message: z.string().optional(),
    addAll: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const parsed = gitOperationSchema.safeParse(value);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
    }
  })
  .meta({ oneOf: gitOperationJsonSchema.oneOf });

const metadataValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const toolResultWireSchema = z
  .object({
    success: z.boolean(),
    output: z.string(),
    truncated: z.boolean(),
    originalTokenCount: z.number().int().nonnegative(),
    codec: z.string(),
    metadata: z.record(z.string(), metadataValueSchema).optional(),
  })
  .strict();
