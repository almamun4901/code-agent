import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelTurn } from "../src/model/contracts";
import { FileProductionCheckpointStore } from "../src/runtime/checkpoint";
import { createLegacyTerminalApprovalState } from "../src/runtime/approval";
import { formatInspection, inspectRepository } from "../src/runtime/inspect";
import { runProductionLoop } from "../src/runtime/production-loop";
import { completeProductionFinalization } from "../src/runtime/production-loop";
import { FileAuditJournal } from "../src/runtime/audit";
import { createTemporaryRepository, type TemporaryRepository } from "./support/temp-repo";

const repositories: TemporaryRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map((repo) => repo.cleanup())));

describe("completion inspection", () => {
  test("projects a valid incomplete run and supports exact operation lookup", async () => {
    const { repo, operationId } = await finalizingFixture();
    const report = await inspectRepository(repo.worktreePath);
    expect(report).toMatchObject({ version: 1, run: { lifecycle: "finalizing" }, audit: { integrity: "valid" }, verification: [{ id: "check", status: "satisfied", exitCode: 0 }], blockedReason: "FINALIZATION_DELIVERY_PENDING" });
    expect(report.tools).toHaveLength(1);
    expect((await inspectRepository(repo.worktreePath, operationId)).tools).toHaveLength(1);
    expect(formatInspection(report)).toContain("Audit integrity: valid");
    expect(formatInspection(report)).toContain("Completion blocked: FINALIZATION_DELIVERY_PENDING");
  });

  test("fails closed for a tampered journal and honestly labels legacy completion", async () => {
    const first = await finalizingFixture();
    const auditPath = path.join(first.repo.worktreePath, ".agent/audit.jsonl");
    const audit = await readFile(auditPath, "utf8");
    await writeFile(auditPath, audit.replace(/"digest":"[a-f0-9]{64}"/, `"digest":"${"f".repeat(64)}"`));
    await expect(inspectRepository(first.repo.worktreePath)).rejects.toThrow("INSPECTION_INTEGRITY_FAILED");

    const second = await finalizingFixture();
    const store = new FileProductionCheckpointStore(second.repo.worktreePath);
    const state = (await store.load())!;
    await store.save({ ...state, lifecycle: "completed", approval: createLegacyTerminalApprovalState(), legacyCompletionStatus: "legacy_unverified", completion: null });
    const legacy = await inspectRepository(second.repo.worktreePath);
    expect(legacy.run.completionStatus).toBe("legacy_unverified");
    expect(legacy.blockedReason).toBe("legacy_unverified");
  });

  test("blocks finalization when a bound screenshot is tampered after verification", async () => {
    const { repo } = await finalizingFixture();
    const store = new FileProductionCheckpointStore(repo.worktreePath);
    const state = (await store.load())!;
    const screenshotPath = path.join(repo.worktreePath, ".agent/evidence/proof.png");
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    const png = structuralPng(375, 812);
    await Bun.write(screenshotPath, png);
    await store.save({ ...state, verificationEvidence: state.verificationEvidence.map((item) => ({ ...item, screenshots: [{ path: ".agent/evidence/proof.png", sha256: createHash("sha256").update(png).digest("hex"), bytes: png.byteLength, width: 375, height: 812, route: "/" }] })) });
    await Bun.write(screenshotPath, Uint8Array.from([1, 2, 3]));
    await expect(completeProductionFinalization({
      checkpointStore: store,
      auditJournal: new FileAuditJournal(repo.worktreePath),
      delivery: { version: 2, runIdentity: state.runIdentity, canonicalRepoPath: repo.worktreePath, baseSha: state.verificationEvidence[0]!.candidateCommit!, resultSha: state.verificationEvidence[0]!.candidateCommit!, baseTreeSha: state.verificationEvidence[0]!.candidateTree!, resultTreeSha: state.verificationEvidence[0]!.candidateTree!, branch: `result/${state.runIdentity.slice(0, 12)}`, bundleSha256: "a".repeat(64), bundleBytes: 1, changedFiles: [], diffSummary: { filesChanged: 0, insertions: 0, deletions: 0, binaryFiles: 0 }, deliveredAt: new Date().toISOString() },
    })).rejects.toThrow("VIEWPORT_SCREENSHOT_INTEGRITY_FAILED");
    expect((await store.load())?.lifecycle).toBe("finalizing");
  });
});

async function finalizingFixture(): Promise<{ repo: TemporaryRepository; operationId: string }> {
  const repo = await createTemporaryRepository();
  repositories.push(repo);
  const sha = await git(repo.worktreePath, "rev-parse", "HEAD");
  const tree = await git(repo.worktreePath, "rev-parse", "HEAD^{tree}");
  const operationId = crypto.randomUUID();
  const turns: ModelTurn[] = [
    { content: [{ type: "tool_use", id: "proposal", name: "propose_plan", input: proposal() }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
    { content: [{ type: "tool_use", id: operationId, name: "run_shell", input: { cwd: ".", command: "bun test", timeoutMs: 30_000, verificationRequirementId: "check" } }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
    { content: [{ type: "tool_use", id: "done", name: "rewrite_plan", input: { plan: [{ id: "work", description: "Implement evidence.", status: "completed" }] } }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
  ];
  await runProductionLoop({
    canonicalRepoPath: repo.worktreePath,
    task: "Implement evidence",
    runIdentity: "9".repeat(64),
    approvalMode: "auto",
    checkpointStore: new FileProductionCheckpointStore(repo.worktreePath),
    callModel: async () => turns.shift()!,
    session: { async call() { return { success: true, output: "ok", truncated: false, originalTokenCount: 1, codec: "test", metadata: { exitCode: 0, timedOut: false, gitCommitBefore: sha, gitTreeBefore: tree, gitCleanBefore: true, gitCommitAfter: sha, gitTreeAfter: tree, gitCleanAfter: true } }; } },
  });
  const state = (await new FileProductionCheckpointStore(repo.worktreePath).load())!;
  return { repo, operationId: state.verificationEvidence[0]!.operationId };
}

function proposal() {
  return {
    approach: "Implement trusted completion evidence.", productDirection: "Reliable completion.", visualDirection: "not_applicable" as const,
    technologyChoices: [], includedScope: ["Evidence"], excludedScope: [], assumptions: [], unresolvedQuestions: [],
    acceptanceCriteria: [{ id: "accepted", criterion: "Evidence is valid.", verification: "Run tests.", verificationRequirementIds: ["check"] }],
    verificationRequirements: [{ type: "command" as const, id: "check", label: "Tests", workingDirectory: ".", command: "bun test", timeoutMs: 30_000 }],
    executionPlan: [{ id: "work", description: "Implement evidence." }],
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

function structuralPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(57);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); bytes.set(new TextEncoder().encode("IHDR"), 12); view.setUint32(16, width); view.setUint32(20, height);
  view.setUint32(33, 0); bytes.set(new TextEncoder().encode("IDAT"), 37);
  view.setUint32(45, 0); bytes.set(new TextEncoder().encode("IEND"), 49);
  return bytes;
}
