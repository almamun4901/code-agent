import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, truncate } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ProductionCheckpointStore } from "./checkpoint";
import { AuditCursorSchema, ProductionAgentStateSchema, type AuditCursor, type ProductionAgentState } from "./schema";

export const AUDIT_FILE = "audit.jsonl";
export const MAX_AUDIT_RECORDS = 1_024;
export const MAX_AUDIT_RECORD_BYTES = 32 * 1024;
export const MAX_AUDIT_BYTES = 8 * 1024 * 1024;
export const EMPTY_AUDIT_DIGEST = "0".repeat(64);

const safeValueSchema = z.union([
  z.string().max(4_096),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(1_024), z.number().finite(), z.boolean(), z.null()])).max(50),
]);

export const AuditRecordSchema = z.object({
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive().max(MAX_AUDIT_RECORDS),
  timestamp: z.string().datetime(),
  runIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  previousDigest: z.string().regex(/^[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().uuid().nullable(),
  approvedProposalDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  stateDigestBefore: z.string().regex(/^[a-f0-9]{64}$/),
  stateDigestAfter: z.string().regex(/^[a-f0-9]{64}$/),
  type: z.enum([
    "tool_terminal",
    "verification_updated",
    "finalization_started",
    "delivery_completed",
    "completion_verified",
  ]),
  payload: z.record(z.string().max(128), safeValueSchema),
}).strict();

export type AuditRecord = z.infer<typeof AuditRecordSchema>;
export type AuditRecordDraft = Pick<AuditRecord, "type" | "operationId" | "payload">;

export class AuditJournalError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(`${code}: ${message}`, options);
    this.name = "AuditJournalError";
    this.code = code;
  }
}

export interface AuditJournal {
  recover(cursor: AuditCursor): Promise<AuditRecord[]>;
  append(records: AuditRecord[]): Promise<void>;
}

export class FileAuditJournal implements AuditJournal {
  readonly agentDirectory: string;
  readonly auditPath: string;

  constructor(repoPath: string) {
    this.agentDirectory = join(resolve(repoPath), ".agent");
    this.auditPath = join(this.agentDirectory, AUDIT_FILE);
  }

  async recover(cursorInput: AuditCursor): Promise<AuditRecord[]> {
    const cursor = AuditCursorSchema.parse(cursorInput);
    await this.prepareDirectory(cursor.sequence > 0);
    const contents = await this.readBounded();
    if (contents === null) {
      if (cursor.sequence === 0 && cursor.digest === EMPTY_AUDIT_DIGEST) return [];
      throw new AuditJournalError("AUDIT_MISSING", "Committed audit records are missing.");
    }
    const { records, byteOffsets } = parseAndValidateJournal(contents);
    if (records.length < cursor.sequence) {
      throw new AuditJournalError("AUDIT_TRUNCATED", "The journal ends before the committed checkpoint cursor.");
    }
    const committed = records.slice(0, cursor.sequence);
    const committedDigest = committed.at(-1)?.digest ?? EMPTY_AUDIT_DIGEST;
    if (committedDigest !== cursor.digest) {
      throw new AuditJournalError("AUDIT_CURSOR_MISMATCH", "The checkpoint cursor does not match the committed journal chain.");
    }
    if (records.length > cursor.sequence) {
      const committedBytes = cursor.sequence === 0 ? 0 : byteOffsets[cursor.sequence - 1]!;
      await truncate(this.auditPath, committedBytes);
      const handle = await open(this.auditPath, constants.O_RDONLY);
      try { await handle.sync(); } finally { await handle.close(); }
    }
    return committed;
  }

  async append(records: AuditRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.prepareDirectory(false);
    await this.rejectUnsafeFile();
    const serialized = records.map((record) => serializeRecord(AuditRecordSchema.parse(record))).join("");
    for (const line of serialized.split("\n").filter(Boolean)) {
      if (Buffer.byteLength(`${line}\n`) > MAX_AUDIT_RECORD_BYTES) {
        throw new AuditJournalError("AUDIT_BUDGET_EXCEEDED", `An audit record exceeds ${MAX_AUDIT_RECORD_BYTES} bytes.`);
      }
    }
    const existingSize = await this.fileSize();
    if (existingSize + Buffer.byteLength(serialized) > MAX_AUDIT_BYTES) {
      throw new AuditJournalError("AUDIT_BUDGET_EXCEEDED", `The audit journal exceeds ${MAX_AUDIT_BYTES} bytes.`);
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.auditPath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
      await handle.writeFile(serialized);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(this.auditPath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof AuditJournalError) throw error;
      throw new AuditJournalError("AUDIT_WRITE_FAILED", "Could not durably append the audit journal.", { cause: error });
    }
  }

  private async prepareDirectory(required: boolean): Promise<void> {
    try {
      const stats = await lstat(this.agentDirectory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new AuditJournalError("AUDIT_UNSAFE_PATH", `Refusing unsafe agent directory "${this.agentDirectory}".`);
      }
    } catch (error) {
      if (error instanceof AuditJournalError) throw error;
      if (!isMissing(error)) throw new AuditJournalError("AUDIT_READ_FAILED", "Could not inspect the agent directory.", { cause: error });
      if (required) throw new AuditJournalError("AUDIT_MISSING", "The agent directory containing committed audit records is missing.");
      await mkdir(this.agentDirectory, { mode: 0o700 });
    }
  }

  private async rejectUnsafeFile(): Promise<void> {
    try {
      const stats = await lstat(this.auditPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new AuditJournalError("AUDIT_UNSAFE_PATH", `Refusing unsafe audit file "${this.auditPath}".`);
      }
      if (stats.size > MAX_AUDIT_BYTES) throw new AuditJournalError("AUDIT_BUDGET_EXCEEDED", "Audit journal exceeds its byte budget.");
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }

  private async readBounded(): Promise<string | null> {
    await this.rejectUnsafeFile();
    try {
      const bytes = await readFile(this.auditPath);
      if (bytes.byteLength > MAX_AUDIT_BYTES) throw new AuditJournalError("AUDIT_BUDGET_EXCEEDED", "Audit journal exceeds its byte budget.");
      return bytes.toString("utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async fileSize(): Promise<number> {
    try { return (await lstat(this.auditPath)).size; } catch (error) { if (isMissing(error)) return 0; throw error; }
  }
}

export class MemoryAuditJournal implements AuditJournal {
  records: AuditRecord[] = [];

  async recover(cursor: AuditCursor): Promise<AuditRecord[]> {
    parseAndValidateJournal(this.records.map(serializeRecord).join(""));
    if (this.records.length < cursor.sequence || (this.records[cursor.sequence - 1]?.digest ?? EMPTY_AUDIT_DIGEST) !== cursor.digest) {
      throw new AuditJournalError("AUDIT_CURSOR_MISMATCH", "Memory journal does not match the checkpoint cursor.");
    }
    this.records = this.records.slice(0, cursor.sequence);
    return structuredClone(this.records);
  }

  async append(records: AuditRecord[]): Promise<void> {
    this.records.push(...structuredClone(records));
  }
}

export class AuditCheckpointCoordinator {
  constructor(readonly journal: AuditJournal, readonly checkpoints: ProductionCheckpointStore) {}

  async commit(
    before: ProductionAgentState,
    afterInput: ProductionAgentState,
    drafts: AuditRecordDraft[],
    update?: (state: ProductionAgentState, records: readonly AuditRecord[]) => void,
  ): Promise<{ state: ProductionAgentState; records: AuditRecord[] }> {
    if (drafts.length === 0) throw new AuditJournalError("AUDIT_EMPTY_COMMIT", "An audit commit requires at least one record.");
    if (before.auditCursor.sequence + drafts.length > MAX_AUDIT_RECORDS) {
      throw new AuditJournalError("AUDIT_BUDGET_EXCEEDED", `Audit record count exceeds ${MAX_AUDIT_RECORDS}.`);
    }
    const after = structuredClone(afterInput);
    let previousDigest = before.auditCursor.digest;
    const records = drafts.map((draft, index) => {
      const unsigned = {
        schemaVersion: 1 as const,
        sequence: before.auditCursor.sequence + index + 1,
        timestamp: new Date().toISOString(),
        runIdentity: before.runIdentity,
        previousDigest,
        operationId: draft.operationId,
        approvedProposalDigest: before.approval.approvedProposalDigest,
        stateDigestBefore: productionStateDigest(before),
        stateDigestAfter: productionStateDigest(after),
        type: draft.type,
        payload: draft.payload,
      };
      const record = AuditRecordSchema.parse({ ...unsigned, digest: sha256(stableJson(unsigned)) });
      previousDigest = record.digest;
      return record;
    });
    after.auditCursor = { sequence: records.at(-1)!.sequence, digest: records.at(-1)!.digest };
    update?.(after, records);
    const validated = ProductionAgentStateSchema.parse(after);
    // audit append -> fsync -> checkpoint save -> fsync checkpoint + directory
    // The checkpoint cursor is the commit point; recovery truncates an orphan audit tail.
    await this.journal.append(records);
    await this.checkpoints.save(validated);
    return { state: validated, records };
  }
}

export function productionStateDigest(state: ProductionAgentState): string {
  const { auditCursor: _cursor, verificationEvidence: _evidence, completion: _completion, ...semantic } = state;
  return sha256(stableJson(semantic));
}

export function auditRecordDigest(record: Omit<AuditRecord, "digest">): string {
  return sha256(stableJson(record));
}

export function redactedDigest(value: string): string {
  return `sha256:${sha256(value)}`;
}

function parseAndValidateJournal(contents: string): { records: AuditRecord[]; byteOffsets: number[] } {
  if (contents.length === 0) return { records: [], byteOffsets: [] };
  if (!contents.endsWith("\n")) throw new AuditJournalError("AUDIT_TRUNCATED", "Audit journal ends with a partial record.");
  const lines = contents.slice(0, -1).split("\n");
  if (lines.length > MAX_AUDIT_RECORDS) throw new AuditJournalError("AUDIT_BUDGET_EXCEEDED", "Audit journal exceeds its record budget.");
  const records: AuditRecord[] = [];
  const byteOffsets: number[] = [];
  let previousDigest = EMPTY_AUDIT_DIGEST;
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(`${line}\n`) > MAX_AUDIT_RECORD_BYTES) throw new AuditJournalError("AUDIT_BUDGET_EXCEEDED", "Audit record exceeds its byte budget.");
    let record: AuditRecord;
    try { record = AuditRecordSchema.parse(JSON.parse(line)); } catch (error) { throw new AuditJournalError("AUDIT_CORRUPT", `Audit record ${index + 1} is invalid.`, { cause: error }); }
    const { digest, ...unsigned } = record;
    if (record.sequence !== index + 1 || record.previousDigest !== previousDigest || digest !== sha256(stableJson(unsigned))) {
      throw new AuditJournalError("AUDIT_INTEGRITY_FAILED", `Audit record ${index + 1} breaks sequence or hash-chain integrity.`);
    }
    previousDigest = digest;
    records.push(record);
    offset += Buffer.byteLength(`${line}\n`);
    byteOffsets.push(offset);
  }
  return { records, byteOffsets };
}

function serializeRecord(record: AuditRecord): string { return `${JSON.stringify(record)}\n`; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function isMissing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
