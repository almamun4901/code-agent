import type { TodoItem } from "../plan/schema";
import type {
  AgentEvent,
  AgentUsage,
  ToolOutcome,
} from "../runtime/events";
import type { ApprovalMode, PlanProposal } from "../runtime/approval";

export const MAX_TOOL_EVENTS = 200;
export const MAX_TOOL_EVENT_BYTES = 256 * 1024;

export type ToolActivity = {
  operationId: string;
  toolName: string;
  summary: string;
  startedAt: string;
  durationMs?: number;
  outcome?: ToolOutcome;
};

export type TuiState = {
  status:
    | "initializing"
    | "running"
    | "finalizing"
    | "awaiting_approval"
    | "stopping"
    | "completed"
    | "cancelled"
    | "failed";
  plan: TodoItem[];
  tools: ToolActivity[];
  usage: AgentUsage;
  cleanup?: "succeeded" | "failed";
  error?: { code: string; message: string };
  notification?: { code: string; message: string };
  approval?: {
    proposal: PlanProposal;
    proposalDigest: string;
    revision: number;
    mode: ApprovalMode;
    reapprovalReason?: string;
  };
};

export const initialTuiState: TuiState = {
  status: "initializing",
  plan: [],
  tools: [],
  usage: {
    modelTurns: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    contextTokens: 0,
    contextSource: null,
    maxModelCalls: 50,
    maxContextTokens: 200_000,
    projectedCostMicroUsd: 0,
    observedCostMicroUsd: 0,
    observedCostAvailable: false,
    maxProjectedCostMicroUsd: 5_000_000,
    compactions: 0,
    compactAtTokens: 150_000,
  },
};

export function reduceAgentEvent(
  state: TuiState,
  event: AgentEvent,
): TuiState {
  switch (event.type) {
    case "run_started":
      return { ...state, status: "running" };
    case "state_loaded":
      return {
        ...state,
        status: event.lifecycle === "running"
          ? "running"
          : event.lifecycle,
        plan: structuredClone(event.plan),
        usage: event.usage,
      };
    case "plan_committed":
      return { ...state, plan: structuredClone(event.plan) };
    case "approval_requested":
      return {
        ...state,
        status: "awaiting_approval",
        approval: structuredClone({
          proposal: event.proposal,
          proposalDigest: event.proposalDigest,
          revision: event.revision,
          mode: event.mode,
          ...(event.reapprovalReason ? { reapprovalReason: event.reapprovalReason } : {}),
        }),
      };
    case "approval_resolved":
      return {
        ...state,
        status: event.decision === "cancel" ? "stopping" : "running",
        approval: undefined,
      };
    case "tool_started":
      return {
        ...state,
        tools: boundTools([
          ...state.tools.filter(
            (tool) => tool.operationId !== event.operationId,
          ),
          {
            operationId: event.operationId,
            toolName: event.toolName,
            summary: event.summary,
            startedAt: event.timestamp,
          },
        ]),
      };
    case "tool_finished":
      return {
        ...state,
        tools: boundTools(
          state.tools.map((tool) =>
            tool.operationId === event.operationId
              ? {
                  ...tool,
                  durationMs: event.durationMs,
                  outcome: event.outcome,
                }
              : tool
          ),
        ),
      };
    case "tool_audited":
      return state;
    case "usage_updated":
      return { ...state, usage: event.usage };
    case "notification":
      return {
        ...state,
        notification: {
          code: event.notification.code,
          message: event.notification.message,
        },
        error: event.notification.kind === "warning"
          ? { code: event.notification.code, message: event.notification.message }
          : state.error,
      };
    case "shutdown_started":
      return { ...state, status: "stopping" };
    case "run_finished":
      return {
        ...state,
        status: event.reason,
        cleanup: event.cleanup,
        ...(event.error ? { error: event.error } : {}),
      };
  }
}

export function toolEventBytes(tools: ToolActivity[]): number {
  return new TextEncoder().encode(JSON.stringify(tools)).byteLength;
}

function boundTools(tools: ToolActivity[]): ToolActivity[] {
  const retained = [...tools];
  while (
    retained.length > MAX_TOOL_EVENTS ||
    toolEventBytes(retained) > MAX_TOOL_EVENT_BYTES
  ) {
    let latestFailure = -1;
    for (let index = retained.length - 1; index >= 0; index -= 1) {
      const outcome = retained[index]?.outcome;
      if (outcome === "failed" || outcome === "denied") {
        latestFailure = index;
        break;
      }
    }
    const evictable = retained.findIndex(
      (tool, index) => tool.outcome !== undefined && index !== latestFailure,
    );
    if (evictable < 0) break;
    retained.splice(evictable, 1);
  }
  return retained;
}
