import { Box, Text, useStdout } from "ink";
import { useEffect, useState } from "react";
import type { TodoItem } from "../plan/schema";
import type { ToolOutcome } from "../runtime/events";
import { sanitizeTerminalText } from "../runtime/events";
import type { ToolActivity, TuiState } from "./state";

export type AgentAppProps = {
  state: TuiState;
  width?: number;
};

export function AgentApp({ state, width }: AgentAppProps) {
  const terminalWidth = useTerminalWidth(width);
  const now = useElapsedClock(state.tools.some((tool) => !tool.outcome));
  const plan = <PlanPane plan={state.plan} />;
  const tools = <ToolPane tools={state.tools} now={now} />;
  const budget = <BudgetPane state={state} />;

  if (terminalWidth >= 120) {
    return (
      <Box flexDirection="row" width={terminalWidth}>
        <Box width="34%">{plan}</Box>
        <Box width="40%">{tools}</Box>
        <Box width="26%">{budget}</Box>
      </Box>
    );
  }

  if (terminalWidth >= 80) {
    return (
      <Box flexDirection="column" width={terminalWidth}>
        <Box flexDirection="row">
          <Box width="45%">{plan}</Box>
          <Box width="55%">{tools}</Box>
        </Box>
        {budget}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={terminalWidth}>
      {plan}
      {tools}
      {budget}
    </Box>
  );
}

function PlanPane({ plan }: { plan: TodoItem[] }) {
  return (
    <Pane title="Plan">
      {plan.length === 0
        ? <Text dimColor>Waiting for committed plan…</Text>
        : plan.map((task) => (
            <Text key={task.id} color={planColor(task.status)}>
              {planIcon(task.status)}{" "}
              {sanitizeTerminalText(task.description)}
            </Text>
          ))}
    </Pane>
  );
}

function ToolPane({
  tools,
  now,
}: {
  tools: ToolActivity[];
  now: number;
}) {
  const recent = tools.slice(-8);
  const latestFailure = [...tools].reverse().find(
    (tool) => tool.outcome === "failed" || tool.outcome === "denied",
  );
  const visible =
    latestFailure &&
      !recent.some(
        (tool) => tool.operationId === latestFailure.operationId,
      )
      ? [latestFailure, ...recent.slice(-7)]
      : recent;
  return (
    <Pane title="Tool activity">
      {visible.length === 0
        ? <Text dimColor>No tool activity yet</Text>
        : visible.map((tool) => {
            const elapsed = tool.durationMs ??
              Math.max(0, now - Date.parse(tool.startedAt));
            return (
              <Text
                key={tool.operationId}
                color={toolColor(tool.outcome)}
              >
                {toolIcon(tool.outcome)} {tool.toolName} ·{" "}
                {sanitizeTerminalText(tool.summary)} ·{" "}
                {tool.outcome ?? "active"} ·{" "}
                {formatDuration(elapsed)}
              </Text>
            );
          })}
    </Pane>
  );
}

function BudgetPane({ state }: { state: TuiState }) {
  return (
    <Pane title="Status & budget">
      <Text>
        Status: {statusLabel(state.status)}
        {state.cleanup ? ` · cleanup ${state.cleanup}` : ""}
      </Text>
      <Text>
        Turns {state.usage.modelTurns} · Input{" "}
        {state.usage.inputTokens.toLocaleString()} · Output{" "}
        {state.usage.outputTokens.toLocaleString()}
      </Text>
      <Text dimColor>Dollar cost available in Step 8</Text>
      <Text dimColor>Enforced ceilings available in Step 8</Text>
      {state.error
        ? (
            <Text color="red">
              {state.error.code}:{" "}
              {sanitizeTerminalText(state.error.message)}
            </Text>
          )
        : null}
    </Pane>
  );
}

function Pane({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      flexDirection="column"
      paddingX={1}
      width="100%"
    >
      <Text bold>{title}</Text>
      {children}
    </Box>
  );
}

function useTerminalWidth(override: number | undefined): number {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(
    stdout?.columns ?? 80,
  );
  useEffect(() => {
    if (override !== undefined) return;
    const resize = () => setWidth(stdout?.columns ?? 80);
    stdout?.on("resize", resize);
    resize();
    return () => {
      stdout?.off("resize", resize);
    };
  }, [override, stdout]);
  return Math.max(1, override ?? width);
}

function useElapsedClock(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function planIcon(status: TodoItem["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "●";
  return "○";
}

function planColor(
  status: TodoItem["status"],
): "green" | "cyan" | "gray" {
  if (status === "completed") return "green";
  if (status === "in_progress") return "cyan";
  return "gray";
}

function toolIcon(outcome: ToolOutcome | undefined): string {
  if (!outcome) return "●";
  if (outcome === "succeeded") return "✓";
  if (outcome === "cancelled") return "■";
  return "×";
}

function toolColor(
  outcome: ToolOutcome | undefined,
): "cyan" | "green" | "yellow" | "red" {
  if (!outcome) return "cyan";
  if (outcome === "succeeded") return "green";
  if (outcome === "cancelled") return "yellow";
  return "red";
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000
    ? `${Math.round(durationMs)}ms`
    : `${(durationMs / 1_000).toFixed(1)}s`;
}

function statusLabel(status: TuiState["status"]): string {
  return status === "initializing" ? "Initializing…" : status;
}
