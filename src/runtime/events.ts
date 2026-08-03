import { posix } from "node:path";
import type { TodoItem } from "../plan/schema";
import type {
  ModelToolRequest,
  ToolResult,
} from "../tools/contracts";

const MAX_SUMMARY_BYTES = 2 * 1024;

export type AgentUsage = {
  modelTurns: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  contextSource: "provider" | "conservative_local" | null;
  maxModelCalls: number;
  maxContextTokens: number;
  projectedCostMicroUsd: number;
  observedCostMicroUsd: number;
  observedCostAvailable: boolean;
  maxProjectedCostMicroUsd: number;
  compactions: number;
  compactAtTokens: number;
};

export type ToolOutcome =
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled";

type AgentEventBase = {
  sequence: number;
  timestamp: string;
};

export type AgentEvent =
  | (AgentEventBase & {
      type: "run_started";
      runIdentity: string;
    })
  | (AgentEventBase & {
      type: "state_loaded";
      lifecycle: "running" | "completed" | "cancelled" | "failed";
      plan: TodoItem[];
      usage: AgentUsage;
    })
  | (AgentEventBase & {
      type: "plan_committed";
      plan: TodoItem[];
    })
  | (AgentEventBase & {
      type: "tool_started";
      operationId: string;
      toolName: ModelToolRequest["name"];
      summary: string;
    })
  | (AgentEventBase & {
      type: "tool_finished";
      operationId: string;
      durationMs: number;
      outcome: ToolOutcome;
    })
  | (AgentEventBase & {
      type: "usage_updated";
      usage: AgentUsage;
    })
  | (AgentEventBase & {
      type: "notification";
      notification: {
        kind: "budget" | "compaction" | "lifecycle" | "warning";
        code: string;
        title: string;
        message: string;
      };
    })
  | (AgentEventBase & {
      type: "shutdown_started";
      reason: "completed" | "cancelled" | "failed";
    })
  | (AgentEventBase & {
      type: "run_finished";
      reason: "completed" | "cancelled" | "failed";
      cleanup: "succeeded" | "failed";
      error?: { code: string; message: string };
    });

export type AgentEventSink = (event: AgentEvent) => void;
export type AgentEventInput = AgentEvent extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, keyof AgentEventBase>
    : never
  : never;

export type AgentEventPublisher = {
  emit(event: AgentEventInput): AgentEvent;
};

export function createAgentEventPublisher(
  sink: AgentEventSink | undefined,
  now: () => Date = () => new Date(),
): AgentEventPublisher {
  let sequence = 0;
  return {
    emit(input) {
      const event = {
        ...input,
        sequence: ++sequence,
        timestamp: now().toISOString(),
      } as AgentEvent;
      if (sink) {
        const snapshot = structuredClone(event);
        queueMicrotask(() => {
          try {
            void Promise.resolve(sink(snapshot)).catch(() => {});
          } catch {
            // Observation must never affect execution.
          }
        });
      }
      return event;
    },
  };
}

export function usageFromCounters(counters: {
  modelTurns: number;
  modelCalls?: number;
  inputTokens: number;
  outputTokens: number;
}, state?: {
  context: { lastEstimateTokens: number; estimateSource: "provider" | "conservative_local" | null };
  limits: { maxModelCalls: number; maxContextTokens: number; maxProjectedCostMicroUsd: number; compactAtTokens: number };
  cost: { projectedMicroUsd: number; observedMicroUsd: number; observedAvailable: boolean };
  compaction: { count: number };
}): AgentUsage {
  return {
    modelTurns: counters.modelTurns,
    modelCalls: counters.modelCalls ?? counters.modelTurns,
    inputTokens: counters.inputTokens,
    outputTokens: counters.outputTokens,
    contextTokens: state?.context.lastEstimateTokens ?? 0,
    contextSource: state?.context.estimateSource ?? null,
    maxModelCalls: state?.limits.maxModelCalls ?? 50,
    maxContextTokens: state?.limits.maxContextTokens ?? 200_000,
    projectedCostMicroUsd: state?.cost.projectedMicroUsd ?? 0,
    observedCostMicroUsd: state?.cost.observedMicroUsd ?? 0,
    observedCostAvailable: state?.cost.observedAvailable ?? false,
    maxProjectedCostMicroUsd: state?.limits.maxProjectedCostMicroUsd ?? 5_000_000,
    compactions: state?.compaction.count ?? 0,
    compactAtTokens: state?.limits.compactAtTokens ?? 150_000,
  };
}

export function safeToolSummary(request: ModelToolRequest): string {
  let summary: string;
  switch (request.name) {
    case "read_file":
      summary = safeRepositoryPath(request.input.path) ?? "repository path";
      break;
    case "edit_file":
      summary = `${request.input.mode} ${
        safeRepositoryPath(request.input.path) ?? "repository path"
      }`;
      break;
    case "ripgrep":
      summary = [
        request.input.path && safeRepositoryPath(request.input.path)
          ? `in ${request.input.path}`
          : "in repository",
        request.input.glob && safeRepositoryPath(request.input.glob)
          ? `(${request.input.glob})`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      break;
    case "tree_sitter_symbols":
      summary = safeRepositoryPath(request.input.path) ?? "repository path";
      break;
    case "run_shell":
      summary = `in ${
        safeRepositoryPath(request.input.cwd || ".", true) ?? "repository"
      }`;
      break;
    case "git":
      summary =
        request.input.subcommand === "diff" &&
          request.input.path &&
          safeRepositoryPath(request.input.path)
          ? `${request.input.subcommand} ${request.input.path}`
          : request.input.subcommand;
      break;
  }
  return truncateUtf8(sanitizeTerminalText(summary), MAX_SUMMARY_BYTES);
}

function safeRepositoryPath(
  value: string,
  allowRoot = false,
): string | undefined {
  if (allowRoot && (value === "" || value === ".")) return ".";
  if (
    !value ||
    value.includes("\\") ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === ".." ||
    value.startsWith("../")
  ) {
    return undefined;
  }
  return value;
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g,
      "�",
    );
}

export function toolOutcome(result: ToolResult): ToolOutcome {
  if (result.success) return "succeeded";
  if (result.metadata?.code === "CANCELLED") return "cancelled";
  if (result.metadata?.denied === true) return "denied";
  return "failed";
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const suffix = "…";
  const suffixBytes = encoder.encode(suffix).byteLength;
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size + suffixBytes > maxBytes) break;
    output += character;
    bytes += size;
  }
  return `${output}${suffix}`;
}
