import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ModelToolRequest, ToolResult } from "./contracts";

const TOOL_NAMES = ["edit_file", "run_shell", "git"] as const;
const TEMP_PREFIX = ".mutation-journal.tmp-";

const toolMetadataValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.undefined(),
]);

const toolResultSchema = z
  .object({
    success: z.boolean(),
    output: z.string(),
    truncated: z.boolean(),
    originalTokenCount: z.number().int().nonnegative(),
    codec: z.string().min(1),
    metadata: z.record(z.string(), toolMetadataValueSchema).optional(),
  })
  .strict();

export const mutationRecordSchema = z
  .object({
    operationId: z.string().uuid(),
    toolName: z.enum(TOOL_NAMES),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["in_flight", "completed"]),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    result: toolResultSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.status === "in_flight" &&
      (record.completedAt !== null || record.result !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "An in-flight mutation cannot have a completion time or result.",
      });
    }
    if (
      record.status === "completed" &&
      (record.completedAt === null || record.result === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "A completed mutation requires a completion time and result.",
      });
    }
  });

export const mutationJournalStateSchema = z
  .object({
    version: z.literal(1),
    active: mutationRecordSchema.nullable(),
  })
  .strict();

export type MutationRecord = z.infer<typeof mutationRecordSchema>;
export type MutationJournalState = z.infer<typeof mutationJournalStateSchema>;

export type MutationJournal = {
  load(): Promise<MutationJournalState>;
  save(state: MutationJournalState): Promise<void>;
};

export class MutationJournalError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "MutationJournalError";
  }
}

export class MemoryMutationJournal implements MutationJournal {
  #state: MutationJournalState = { version: 1, active: null };

  async load(): Promise<MutationJournalState> {
    return structuredClone(this.#state);
  }

  async save(state: MutationJournalState): Promise<void> {
    this.#state = structuredClone(mutationJournalStateSchema.parse(state));
  }
}

export class FileMutationJournal implements MutationJournal {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<MutationJournalState> {
    let serialized: string;
    try {
      serialized = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingError(error)) return { version: 1, active: null };
      throw new MutationJournalError(
        `Could not read mutation journal "${this.path}".`,
        { cause: error },
      );
    }

    try {
      return mutationJournalStateSchema.parse(JSON.parse(serialized));
    } catch (error) {
      throw new MutationJournalError(
        `Mutation journal "${this.path}" is invalid.`,
        { cause: error },
      );
    }
  }

  async save(state: MutationJournalState): Promise<void> {
    const validated = mutationJournalStateSchema.parse(state);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${directory}/${TEMP_PREFIX}${process.pid}-${crypto.randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.path);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
      throw new MutationJournalError(
        `Could not atomically save mutation journal "${this.path}".`,
        { cause: error },
      );
    }
  }
}

export function mutationInputHash(call: ModelToolRequest): string {
  return createHash("sha256")
    .update(canonicalJson({ name: call.name, input: call.input }))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export async function beginMutation(
  journal: MutationJournal,
  operationId: string,
  call: ModelToolRequest,
  now = new Date(),
): Promise<MutationRecord | null> {
  if (
    call.name !== "edit_file" &&
    call.name !== "run_shell" &&
    call.name !== "git"
  ) {
    throw new MutationJournalError(
      `Tool "${call.name}" is not a journaled mutation.`,
    );
  }

  const inputHash = mutationInputHash(call);
  const current = await journal.load();
  if (current.active) {
    if (
      current.active.operationId === operationId &&
      current.active.toolName === call.name &&
      current.active.inputHash === inputHash
    ) {
      return current.active;
    }
    if (current.active.status === "in_flight") {
      throw new MutationJournalError(
        `Mutation ${current.active.operationId} is still in flight; refusing a second mutation.`,
      );
    }
  }

  const record: MutationRecord = {
    operationId,
    toolName: call.name,
    inputHash,
    status: "in_flight",
    startedAt: now.toISOString(),
    completedAt: null,
    result: null,
  };
  await journal.save({ version: 1, active: record });
  return null;
}

export async function completeMutation(
  journal: MutationJournal,
  operationId: string,
  result: ToolResult,
  now = new Date(),
): Promise<void> {
  const current = await journal.load();
  if (
    !current.active ||
    current.active.operationId !== operationId ||
    current.active.status !== "in_flight"
  ) {
    throw new MutationJournalError(
      `Mutation ${operationId} is not the active in-flight operation.`,
    );
  }
  await journal.save({
    version: 1,
    active: {
      ...current.active,
      status: "completed",
      completedAt: now.toISOString(),
      result,
    },
  });
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
