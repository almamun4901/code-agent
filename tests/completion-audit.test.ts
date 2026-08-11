import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_AUDIT_DIGEST,
  FileAuditJournal,
  auditRecordDigest,
  redactedDigest,
  type AuditRecord,
} from "../src/runtime/audit";
import { FileProductionCheckpointStore } from "../src/runtime/checkpoint";
import { runProductionLoop } from "../src/runtime/production-loop";
import type { ModelTurn } from "../src/model/contracts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await Bun.spawn(["rm", "-rf", root]).exited;
});

describe("completion audit journal", () => {
  test("writes mode-0600 hash-chained records and validates a committed cursor", async () => {
    const repo = await temporaryRepo();
    const journal = new FileAuditJournal(repo);
    const records = chain(2);
    await journal.append(records);
    expect((await lstat(journal.auditPath)).mode & 0o777).toBe(0o600);
    expect(await journal.recover({ sequence: 2, digest: records[1]!.digest })).toEqual(records);
  });

  test("truncates a valid orphan tail after the checkpoint commit point", async () => {
    const repo = await temporaryRepo();
    const journal = new FileAuditJournal(repo);
    const records = chain(3);
    await journal.append(records);
    const committed = await journal.recover({ sequence: 2, digest: records[1]!.digest });
    expect(committed).toHaveLength(2);
    expect((await readFile(journal.auditPath, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  test("fails closed for corruption, reordering, truncation, and cursor mismatch", async () => {
    const repo = await temporaryRepo();
    const journal = new FileAuditJournal(repo);
    const records = chain(2);
    await journal.append(records);
    await writeFile(journal.auditPath, `${JSON.stringify(records[1])}\n${JSON.stringify(records[0])}\n`, { mode: 0o600 });
    await expect(journal.recover({ sequence: 2, digest: records[1]!.digest })).rejects.toMatchObject({ code: "AUDIT_INTEGRITY_FAILED" });
    await writeFile(journal.auditPath, JSON.stringify(records[0]), { mode: 0o600 });
    await expect(journal.recover({ sequence: 1, digest: records[0]!.digest })).rejects.toMatchObject({ code: "AUDIT_TRUNCATED" });
    await writeFile(journal.auditPath, `${JSON.stringify(records[0])}\n`, { mode: 0o600 });
    await expect(journal.recover({ sequence: 1, digest: "f".repeat(64) })).rejects.toMatchObject({ code: "AUDIT_CURSOR_MISMATCH" });
  });

  test("rejects symlinked journal files and oversized records", async () => {
    const repo = await temporaryRepo();
    const journal = new FileAuditJournal(repo);
    await mkdir(journal.agentDirectory, { mode: 0o700 });
    const target = join(repo, "target");
    await writeFile(target, "");
    await symlink(target, journal.auditPath);
    await expect(journal.append(chain(1))).rejects.toMatchObject({ code: "AUDIT_UNSAFE_PATH" });

    const secondRepo = await temporaryRepo();
    const second = new FileAuditJournal(secondRepo);
    const oversized = chain(1)[0]!;
    oversized.payload = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`value${index}`, "x".repeat(4_096)]));
    await expect(second.append([oversized])).rejects.toMatchObject({ code: "AUDIT_BUDGET_EXCEEDED" });
  });

  test("hashes sensitive values without retaining their source text", () => {
    const secret = "API_TOKEN=injected-secret";
    const digest = redactedDigest(secret);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(digest).not.toContain(secret);
  });

  test("keeps sensitive discovery, mutation, command, output, and commit text out of the durable journal", async () => {
    const repo = await temporaryRepo();
    const sentinels = {
      pattern: "SEARCH_PATTERN_SENTINEL_8C",
      edit: "EDIT_BODY_SENTINEL_8C",
      command: "COMMAND_SENTINEL_8C",
      commit: "COMMIT_MESSAGE_SENTINEL_8C",
      output: "TOOL_OUTPUT_SENTINEL_8C",
      prompt: "PROMPT_SENTINEL_8C",
    };
    const proposal = {
      approach: "Exercise redacted audit projection.", productDirection: "Trusted evidence.", visualDirection: "not_applicable" as const,
      technologyChoices: [], includedScope: ["Audit redaction"], excludedScope: [], assumptions: [], unresolvedQuestions: [],
      acceptanceCriteria: [{ id: "redacted", criterion: "Audit is redacted.", verification: "Run approved command.", verificationRequirementIds: ["check"] }],
      verificationRequirements: [{ type: "command" as const, id: "check", label: "Redaction check", workingDirectory: ".", command: sentinels.command, timeoutMs: 30_000 }],
      executionPlan: [{ id: "work", description: "Exercise audit projection." }],
    };
    const action = (id: string, name: string, input: unknown): ModelTurn => ({ content: [
      { type: "tool_use", id: `${id}-plan`, name: "rewrite_plan", input: { plan: [{ id: "work", description: "Exercise audit projection.", status: "in_progress" }] } },
      { type: "tool_use", id, name, input },
    ], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } });
    const turns: ModelTurn[] = [
      { content: [{ type: "tool_use", id: "search", name: "ripgrep", input: { pattern: sentinels.pattern, path: "." } }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [{ type: "tool_use", id: "proposal", name: "propose_plan", input: proposal }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
      action("edit", "edit_file", { path: "proof.txt", mode: "apply", oldText: null, newText: sentinels.edit }),
      action("commit", "git", { subcommand: "commit", message: sentinels.commit, addAll: true }),
      action("verify", "run_shell", { cwd: ".", command: sentinels.command, timeoutMs: 30_000, verificationRequirementId: "check" }),
      { content: [{ type: "tool_use", id: "done", name: "rewrite_plan", input: { plan: [{ id: "work", description: "Exercise audit projection.", status: "completed" }] } }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    await runProductionLoop({
      canonicalRepoPath: repo,
      task: sentinels.prompt,
      runIdentity: "8".repeat(64),
      approvalMode: "auto",
      checkpointStore: new FileProductionCheckpointStore(repo),
      callModel: async () => turns.shift()!,
      session: { async call(request) {
        const metadata = request.name === "run_shell" ? { exitCode: 0, timedOut: false, gitCommitBefore: "a".repeat(40), gitCommitAfter: "a".repeat(40), gitTreeBefore: "b".repeat(40), gitTreeAfter: "b".repeat(40), gitCleanBefore: true, gitCleanAfter: true } : undefined;
        return { success: true, output: sentinels.output, truncated: false, originalTokenCount: 3, codec: "test", ...(metadata ? { metadata } : {}) };
      } },
    });
    const journalText = await readFile(join(repo, ".agent", "audit.jsonl"), "utf8");
    for (const sentinel of Object.values(sentinels)) expect(journalText).not.toContain(sentinel);
    expect(journalText).toContain("sensitiveArgumentsDigest");
    expect(journalText).toContain("outputDigest");
    expect(journalText).toContain('"exitCode":0');
  });

  test("inspects the maximum committed journal in under 500ms", async () => {
    const repo = await temporaryRepo();
    const journal = new FileAuditJournal(repo);
    const records = chain(1_024);
    await journal.append(records);
    const started = performance.now();
    expect(await journal.recover({ sequence: 1_024, digest: records.at(-1)!.digest })).toHaveLength(1_024);
    const duration = performance.now() - started;
    expect(duration).toBeLessThan(500);
    console.info(`Maximum audit inspection: ${duration.toFixed(1)}ms.`);
  });
});

async function temporaryRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "completion-audit-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

function chain(count: number): AuditRecord[] {
  const records: AuditRecord[] = [];
  let previousDigest = EMPTY_AUDIT_DIGEST;
  for (let index = 0; index < count; index += 1) {
    const unsigned = {
      schemaVersion: 1 as const,
      sequence: index + 1,
      timestamp: new Date(1_700_000_000_000 + index).toISOString(),
      runIdentity: "a".repeat(64),
      previousDigest,
      operationId: crypto.randomUUID(),
      approvedProposalDigest: "b".repeat(64),
      stateDigestBefore: "c".repeat(64),
      stateDigestAfter: "d".repeat(64),
      type: "tool_terminal" as const,
      payload: { toolName: "read_file", success: true },
    };
    const record = { ...unsigned, digest: auditRecordDigest(unsigned) };
    records.push(record);
    previousDigest = record.digest;
  }
  return records;
}
