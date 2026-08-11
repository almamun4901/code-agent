import path from "node:path";
import { z } from "zod";
import { FileAuditJournal, type AuditRecord } from "./audit";
import { FileProductionCheckpointStore } from "./checkpoint";
import type { ProductionAgentState } from "./schema";
import { FileResultDeliveryStore, loadCompletedResultDelivery } from "../sandbox/result-delivery";
import { revalidateViewportEvidenceFiles } from "./evidence-files";

const operationIdSchema = z.string().uuid();

export type InspectionResult = {
  version: 1;
  run: {
    identity: string;
    lifecycle: ProductionAgentState["lifecycle"];
    completionStatus: ProductionAgentState["legacyCompletionStatus"];
    proposalRevision: number;
  };
  verification: Array<{
    id: string;
    label: string;
    type: "command" | "viewport";
    status: "missing" | "satisfied" | "failed" | "stale";
    operationId: string | null;
    errorCode: string | null;
    exitCode: number | null;
    timedOut: boolean | null;
    screenshots: Array<{ path: string; sha256: string; bytes: number; width: number; height: number; route: string }>;
  }>;
  tools: Array<{
    sequence: number;
    operationId: string;
    toolName: string;
    summary: string;
    durationMs: number;
    success: boolean;
    errorCode: string | null;
    exitCode: number | null;
    timedOut: boolean;
    outputDigest: string;
    outputBytes: number;
    outputTokens: number;
    truncated: boolean;
  }>;
  audit: { integrity: "valid"; sequence: number; digest: string; committedRecords: number };
  git: {
    candidateTree: string | null;
    deliveredBranch: string | null;
    deliveredCommit: string | null;
    deliveredTree: string | null;
    baseCommit: string | null;
    baseTree: string | null;
    changedPaths: string[];
    diffSummary: { filesChanged: number; insertions: number; deletions: number; binaryFiles: number } | null;
  };
  completion: ProductionAgentState["completion"];
  blockedReason: string | null;
};

export class InspectionError extends Error {
  constructor(readonly code: string, message: string, options: ErrorOptions = {}) {
    super(`${code}: ${message}`, options);
    this.name = "InspectionError";
  }
}

export async function inspectRepository(repositoryPath: string, operationId?: string): Promise<InspectionResult> {
  const canonical = path.resolve(repositoryPath);
  if (operationId) operationIdSchema.parse(operationId);
  let state: ProductionAgentState | null;
  let records: AuditRecord[];
  try {
    state = await new FileProductionCheckpointStore(canonical).load();
    if (!state) throw new InspectionError("INSPECTION_STATE_MISSING", "No agent checkpoint exists in this repository.");
    records = await new FileAuditJournal(canonical).recover(state.auditCursor);
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    throw new InspectionError("INSPECTION_INTEGRITY_FAILED", error instanceof Error ? error.message : "Checkpoint or audit evidence is invalid.", { cause: error });
  }
  const terminalTools = records.filter((record) => record.type === "tool_terminal");
  if (terminalTools.length !== state.counters.toolCalls) {
    throw new InspectionError("AUDIT_TOOL_COUNT_MISMATCH", "Committed tool count does not match terminal audit records.");
  }
  validateCompletionBindings(state, records);
  try { await revalidateViewportEvidenceFiles(state); } catch (error) {
    throw new InspectionError("EVIDENCE_ARTIFACT_INTEGRITY_FAILED", error instanceof Error ? error.message : "Screenshot evidence is invalid.", { cause: error });
  }
  let delivery = null;
  try {
    delivery = await loadCompletedResultDelivery(new FileResultDeliveryStore(canonical));
  } catch (error) {
    throw new InspectionError("DELIVERY_INTEGRITY_FAILED", error instanceof Error ? error.message : "Delivered Git receipt is invalid.", { cause: error });
  }
  if (state.completion && (!delivery || delivery.resultSha !== state.completion.resultCommit || delivery.resultTreeSha !== state.completion.resultTree)) {
    throw new InspectionError("COMPLETION_DELIVERY_MISMATCH", "Completion receipt does not match the independently validated delivery receipt.");
  }
  const tools = terminalTools.map(toolProjection);
  const selectedTools = operationId ? tools.filter((tool) => tool.operationId === operationId) : tools;
  if (operationId && selectedTools.length === 0) throw new InspectionError("OPERATION_NOT_FOUND", `No committed tool operation matches ${operationId}.`);
  const requirements = state.approval.currentProposal?.verificationRequirements ?? [];
  const verification = requirements.map((requirement) => {
    const evidence = state!.verificationEvidence.find((item) => item.requirementId === requirement.id);
    return {
      id: requirement.id,
      label: requirement.label,
      type: requirement.type,
      status: evidence?.status ?? "missing" as const,
      operationId: evidence?.operationId ?? null,
      errorCode: evidence?.errorCode ?? null,
      exitCode: evidence?.exitCode ?? null,
      timedOut: evidence?.timedOut ?? null,
      screenshots: evidence?.screenshots ?? [],
    };
  });
  const candidateTrees = new Set(state.verificationEvidence.filter((item) => item.status === "satisfied" && item.candidateTree).map((item) => item.candidateTree!));
  return {
    version: 1,
    run: { identity: state.runIdentity, lifecycle: state.lifecycle, completionStatus: state.legacyCompletionStatus, proposalRevision: state.approval.revision },
    verification,
    tools: selectedTools,
    audit: { integrity: "valid", sequence: state.auditCursor.sequence, digest: state.auditCursor.digest, committedRecords: records.length },
    git: {
      candidateTree: candidateTrees.size === 1 ? [...candidateTrees][0]! : null,
      deliveredBranch: delivery?.branch ?? null,
      deliveredCommit: delivery?.resultSha ?? null,
      deliveredTree: delivery?.resultTreeSha ?? null,
      baseCommit: delivery?.baseSha ?? null,
      baseTree: delivery?.baseTreeSha ?? null,
      changedPaths: delivery?.changedFiles ?? [],
      diffSummary: delivery?.diffSummary ?? null,
    },
    completion: state.completion,
    blockedReason: completionBlockReason(state, verification, delivery !== null),
  };
}

function validateCompletionBindings(state: ProductionAgentState, records: AuditRecord[]): void {
  if (!state.completion) return;
  const bySequence = new Map(records.map((record) => [record.sequence, record]));
  if (state.completion.auditCursor.sequence !== state.auditCursor.sequence || state.completion.auditCursor.digest !== state.auditCursor.digest) {
    throw new InspectionError("COMPLETION_AUDIT_MISMATCH", "Completion receipt does not bind the checkpoint audit cursor.");
  }
  for (const evidence of state.completion.evidence) {
    const record = bySequence.get(evidence.sequence);
    if (!record || record.digest !== evidence.recordDigest || record.type !== "verification_updated") {
      throw new InspectionError("COMPLETION_EVIDENCE_MISMATCH", `Completion evidence for ${evidence.requirementId} does not match the audit journal.`);
    }
  }
}

function toolProjection(record: AuditRecord): InspectionResult["tools"][number] {
  const payload = record.payload;
  return {
    sequence: record.sequence,
    operationId: record.operationId!,
    toolName: stringValue(payload.toolName),
    summary: stringValue(payload.summary),
    durationMs: numberValue(payload.durationMs),
    success: payload.success === true,
    errorCode: nullableString(payload.errorCode),
    exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
    timedOut: payload.timedOut === true,
    outputDigest: stringValue(payload.outputDigest),
    outputBytes: numberValue(payload.outputBytes),
    outputTokens: numberValue(payload.outputTokens),
    truncated: payload.truncated === true,
  };
}

function completionBlockReason(state: ProductionAgentState, requirements: InspectionResult["verification"], hasDelivery: boolean): string | null {
  if (state.legacyCompletionStatus === "legacy_unverified") return "legacy_unverified";
  if (state.lifecycle === "completed" && state.completion) return null;
  const unsatisfied = requirements.filter((item) => item.status !== "satisfied").map((item) => item.id);
  if (unsatisfied.length > 0) return `COMPLETION_EVIDENCE_MISSING: ${unsatisfied.join(", ")}`;
  if (state.lifecycle === "finalizing" && !hasDelivery) return "FINALIZATION_DELIVERY_PENDING";
  return `LIFECYCLE_${state.lifecycle.toUpperCase()}`;
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function nullableString(value: unknown): string | null { return typeof value === "string" ? value : null; }
function numberValue(value: unknown): number { return typeof value === "number" ? value : 0; }

export function formatInspection(report: InspectionResult): string {
  const satisfied = report.verification.filter((item) => item.status === "satisfied").length;
  const lines = [
    `Run: ${report.run.identity}`,
    `Lifecycle: ${report.run.lifecycle}${report.run.completionStatus === "legacy_unverified" ? " (legacy_unverified)" : ""}`,
    `Approved proposal revision: ${report.run.proposalRevision}`,
    `Verification: ${satisfied}/${report.verification.length} satisfied`,
    ...report.verification.map((item) => `  ${item.id} [${item.type}] ${item.status}${item.errorCode ? ` · ${item.errorCode}` : ""}${item.exitCode !== null ? ` · exit ${item.exitCode}` : ""}`),
    `Audit integrity: ${report.audit.integrity} · ${report.audit.committedRecords} records · ${report.audit.digest}`,
    ...report.tools.map((tool) => `Tool ${tool.sequence}: ${tool.toolName} · ${tool.operationId} · ${tool.success ? "succeeded" : "failed"} · ${tool.durationMs}ms${tool.errorCode ? ` · ${tool.errorCode}` : ""}${tool.exitCode !== null ? ` · exit ${tool.exitCode}` : ""} · output ${tool.outputDigest}`),
    `Candidate tree: ${report.git.candidateTree ?? "unavailable"}`,
    `Delivered: ${report.git.deliveredBranch ?? "pending"}${report.git.deliveredCommit ? ` · ${report.git.deliveredCommit} · tree ${report.git.deliveredTree}` : ""}`,
    report.git.diffSummary ? `Diff: ${report.git.diffSummary.filesChanged} files, +${report.git.diffSummary.insertions}/-${report.git.diffSummary.deletions}, ${report.git.diffSummary.binaryFiles} binary` : "Diff: unavailable",
    ...report.verification.flatMap((item) => item.screenshots.map((shot) => `Screenshot: ${shot.path} · ${shot.sha256} · ${shot.width}x${shot.height} · ${shot.route}`)),
    report.completion ? `Completion receipt: ${report.completion.completedAt} · ${report.completion.resultCommit}` : `Completion blocked: ${report.blockedReason ?? "unknown"}`,
  ];
  return `${lines.join("\n")}\n`;
}
