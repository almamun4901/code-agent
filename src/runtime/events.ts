import type { TodoItem } from "../plan/schema";
import type {
  ModelToolRequest,
  ToolResult,
} from "../tools/contracts";

const MAX_SUMMARY_BYTES = 2 * 1024;

export type AgentUsage = {
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
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
      lifecycle: "running" | "completed" | "failed";
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
      try {
        sink?.(structuredClone(event));
      } catch {
        // Observation must never affect execution.
      }
      return event;
    },
  };
}

export function usageFromCounters(counters: {
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
}): AgentUsage {
  return {
    modelTurns: counters.modelTurns,
    inputTokens: counters.inputTokens,
    outputTokens: counters.outputTokens,
  };
}

export function safeToolSummary(request: ModelToolRequest): string {
  let summary: string;
  switch (request.name) {
    case "read_file":
      summary = request.input.path;
      break;
    case "edit_file":
      summary = `${request.input.mode} ${request.input.path}`;
      break;
    case "ripgrep":
      summary = [
        request.input.path ? `in ${request.input.path}` : "in repository",
        request.input.glob ? `(${request.input.glob})` : "",
      ]
        .filter(Boolean)
        .join(" ");
      break;
    case "tree_sitter_symbols":
      summary = request.input.path;
      break;
    case "run_shell":
      summary = `in ${request.input.cwd || "."}`;
      break;
    case "git":
      summary =
        request.input.subcommand === "diff" && request.input.path
          ? `${request.input.subcommand} ${request.input.path}`
          : request.input.subcommand;
      break;
  }
  return truncateUtf8(summary, MAX_SUMMARY_BYTES);
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
