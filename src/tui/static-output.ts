import type { AgentEvent } from "../runtime/events";

export function formatStaticEvent(event: AgentEvent): string[] {
  switch (event.type) {
    case "run_started":
      return ["Run started"];
    case "state_loaded":
      return [
        `State loaded: ${event.lifecycle}`,
        ...event.plan.map(
          (task) =>
            `Plan [${task.status}] ${singleLine(task.description)}`,
        ),
      ];
    case "plan_committed":
      return event.plan.map(
        (task) =>
          `Plan [${task.status}] ${singleLine(task.description)}`,
      );
    case "tool_started":
      return [
        `Tool started: ${event.toolName} ${singleLine(event.summary)}`.trim(),
      ];
    case "tool_finished":
      return [
        `Tool finished: ${event.outcome} ${Math.round(event.durationMs)}ms`,
      ];
    case "usage_updated":
      return [
        `Usage: ${event.usage.modelTurns} turns, ${event.usage.inputTokens} input tokens, ${event.usage.outputTokens} output tokens`,
      ];
    case "shutdown_started":
      return [`Shutdown started: ${event.reason}`];
    case "run_finished":
      return [
        `Run finished: ${event.reason} (cleanup ${event.cleanup})`,
        ...(event.error
          ? [`Error ${event.error.code}: ${singleLine(event.error.message)}`]
          : []),
      ];
  }
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
