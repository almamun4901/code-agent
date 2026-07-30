import type { TodoItem } from "../plan/schema";
import type {
  AgentEvent,
  AgentUsage,
  ToolOutcome,
} from "../runtime/events";

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
    | "stopping"
    | "completed"
    | "cancelled"
    | "failed";
  plan: TodoItem[];
  tools: ToolActivity[];
  usage: AgentUsage;
  cleanup?: "succeeded" | "failed";
  error?: { code: string; message: string };
};

export const initialTuiState: TuiState = {
  status: "initializing",
  plan: [],
  tools: [],
  usage: {
    modelTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
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
    case "usage_updated":
      return { ...state, usage: event.usage };
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
