import type { AgentEvent } from "../runtime/events";
import { sanitizeTerminalText } from "../runtime/events";

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
    case "approval_requested":
      return [
        `Plan approval requested: revision ${event.revision} (${event.mode})`,
        ...(event.reapprovalReason ? [`Reapproval: ${singleLine(event.reapprovalReason)}`] : []),
        `Approach: ${singleLine(event.proposal.approach)}`,
        `Product direction: ${singleLine(event.proposal.productDirection)}`,
        `Visual direction: ${singleLine(event.proposal.visualDirection)}`,
        ...event.proposal.technologyChoices.map((choice) => `Technology: ${singleLine(choice.name)} — ${singleLine(choice.rationale)}`),
        ...event.proposal.includedScope.map((item) => `Included: ${singleLine(item)}`),
        ...event.proposal.excludedScope.map((item) => `Excluded: ${singleLine(item)}`),
        ...event.proposal.acceptanceCriteria.map((item) => `Acceptance: ${singleLine(item.criterion)} — verify: ${singleLine(item.verification)}`),
        ...event.proposal.assumptions.map((item) => `Assumption: ${singleLine(item)}`),
        ...event.proposal.unresolvedQuestions.map((item) => `Unresolved: ${singleLine(item)}`),
        ...event.proposal.executionPlan.map((item, index) => `Execution ${index + 1}: ${singleLine(item.description)}`),
      ];
    case "approval_resolved":
      return [`Plan approval resolved: ${event.decision} (revision ${event.revision})`];
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
        `Usage: ${event.usage.modelCalls}/${event.usage.maxModelCalls} model calls, ${event.usage.contextTokens}/${event.usage.maxContextTokens} context tokens${event.usage.contextSource === "conservative_local" ? " (estimated)" : ""}, $${(event.usage.projectedCostMicroUsd / 1_000_000).toFixed(2)}/$${(event.usage.maxProjectedCostMicroUsd / 1_000_000).toFixed(2)} projected, ${event.usage.compactions} compactions`,
      ];
    case "notification":
      return [`Notice ${event.notification.code}: ${singleLine(event.notification.message)}`];
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
  return sanitizeTerminalText(value).replaceAll(/\s+/g, " ").trim();
}
