import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useState } from "react";
import type { TodoItem } from "../plan/schema";
import type { ToolOutcome } from "../runtime/events";
import { sanitizeTerminalText } from "../runtime/events";
import type { ToolActivity, TuiState } from "./state";
import type { ApprovalDecision } from "../runtime/approval";

export type AgentAppProps = {
  state: TuiState;
  width?: number;
  onApprovalDecision?: (proposalDigest: string, decision: ApprovalDecision) => void;
};

export function AgentApp({ state, width, onApprovalDecision }: AgentAppProps) {
  const terminalWidth = useTerminalWidth(width);
  const now = useElapsedClock(state.tools.some((tool) => !tool.outcome));
  const plan = <PlanPane plan={state.plan} />;
  const [selectedTool, setSelectedTool] = useState(0);
  const [showToolDetail, setShowToolDetail] = useState(false);
  useEffect(() => setSelectedTool(Math.max(0, state.tools.length - 1)), [state.tools.length]);
  useInput((input, key) => {
    if (state.approval || state.tools.length === 0) return;
    if (input === "j" || key.downArrow) setSelectedTool((value) => Math.min(state.tools.length - 1, value + 1));
    if (input === "k" || key.upArrow) setSelectedTool((value) => Math.max(0, value - 1));
    if (input === "d" || key.return) setShowToolDetail((value) => !value);
  }, { isActive: !state.approval });
  const tools = <ToolPane tools={state.tools} now={now} selected={selectedTool} showDetail={showToolDetail} />;
  const budget = <BudgetPane state={state} />;

  if (state.approval) {
    return (
      <Box flexDirection="column" width={terminalWidth}>
        <ApprovalPane approval={state.approval} onDecision={onApprovalDecision} />
        {budget}
      </Box>
    );
  }

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

function ApprovalPane({
  approval,
  onDecision,
}: {
  approval: NonNullable<TuiState["approval"]>;
  onDecision?: AgentAppProps["onApprovalDecision"];
}) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  useInput((input, key) => {
    if (approval.mode !== "interactive" || !onDecision) return;
    if (revising) {
      if (key.escape) {
        setRevising(false);
        setFeedback("");
      } else if (key.return) {
        const value = feedback.trim();
        if (value) onDecision(approval.proposalDigest, { kind: "revise", feedback: value });
      } else if (key.backspace || key.delete) {
        setFeedback((value) => value.slice(0, -1));
      } else if (!key.ctrl && !key.meta && input && feedback.length < 8_192) {
        setFeedback((value) => `${value}${input}`.slice(0, 8_192));
      }
      return;
    }
    if (input.toLowerCase() === "a") onDecision(approval.proposalDigest, { kind: "approve" });
    if (input.toLowerCase() === "c") onDecision(approval.proposalDigest, { kind: "cancel" });
    if (input.toLowerCase() === "r") setRevising(true);
  }, { isActive: approval.mode === "interactive" });

  const proposal = approval.proposal;
  return (
    <Pane title={`Plan approval · revision ${approval.revision}`}>
      {approval.reapprovalReason ? <Text color="yellow">Reapproval: {safe(approval.reapprovalReason)}</Text> : null}
      <Text bold>Approach</Text>
      <Text>{safe(proposal.approach)}</Text>
      <Text bold>Product direction</Text>
      <Text>{safe(proposal.productDirection)}</Text>
      <Text bold>Visual direction</Text>
      <Text>{safe(proposal.visualDirection)}</Text>
      <Text bold>Technology</Text>
      {proposal.technologyChoices.length === 0
        ? <Text dimColor>None</Text>
        : proposal.technologyChoices.map((choice) => <Text key={choice.name}>• {safe(choice.name)} — {safe(choice.rationale)}</Text>)}
      <Text bold>Included scope</Text>
      {proposal.includedScope.map((item) => <Text key={item}>• {safe(item)}</Text>)}
      <Text bold>Excluded scope</Text>
      {proposal.excludedScope.length === 0 ? <Text dimColor>None</Text> : proposal.excludedScope.map((item) => <Text key={item}>• {safe(item)}</Text>)}
      <Text bold>Acceptance</Text>
      {proposal.acceptanceCriteria.map((item) => <Text key={item.id}>• {safe(item.criterion)} — verify: {safe(item.verification)}</Text>)}
      <Text bold>Assumptions / unresolved</Text>
      {[...proposal.assumptions, ...proposal.unresolvedQuestions].length === 0
        ? <Text dimColor>None</Text>
        : [...proposal.assumptions, ...proposal.unresolvedQuestions].map((item) => <Text key={item}>• {safe(item)}</Text>)}
      <Text bold>Execution plan</Text>
      {proposal.executionPlan.map((item, index) => <Text key={item.id}>{index + 1}. {safe(item.description)}</Text>)}
      {approval.mode === "interactive"
        ? revising
          ? <Text color="cyan">Revision feedback: {safe(feedback)}▌ (Enter submit · Esc back)</Text>
          : <Text color="cyan">[A]pprove · [R]evise · [C]ancel</Text>
        : <Text dimColor>Auto-approval requested</Text>}
    </Pane>
  );
}

function safe(value: string): string {
  return sanitizeTerminalText(value);
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
  selected,
  showDetail,
}: {
  tools: ToolActivity[];
  now: number;
  selected: number;
  showDetail: boolean;
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
                {tools[selected]?.operationId === tool.operationId ? ">" : " "} {toolIcon(tool.outcome)} {tool.toolName} ·{" "}
                {sanitizeTerminalText(tool.summary)} ·{" "}
                {tool.outcome ?? "active"} ·{" "}
                {formatDuration(elapsed)}
              </Text>
            );
          })}
      {showDetail && tools[selected]
        ? <Text dimColor>{toolDetail(tools[selected]!)}</Text>
        : null}
      {tools.length > 0 ? <Text dimColor>j/k select · d details</Text> : null}
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
      <Text>Evidence {Object.values(state.evidence.statuses).filter((status) => status === "satisfied").length} / {state.evidence.total}</Text>
      {state.evidence.latestProblem ? <Text color="yellow">Latest evidence: {sanitizeTerminalText(state.evidence.latestProblem)}</Text> : null}
      {state.evidence.deliveredCommit ? <Text>Delivered {state.evidence.deliveredCommit.slice(0, 12)} · completion {state.evidence.completed ? "verified" : "pending"}</Text> : null}
      <Text>
        Model calls {state.usage.modelCalls} / {state.usage.maxModelCalls}
      </Text>
      <Text>
        Context {state.usage.contextTokens.toLocaleString()} / {state.usage.maxContextTokens.toLocaleString()}
        {state.usage.contextSource === "conservative_local" ? " (estimated)" : ""}
      </Text>
      <Text>
        Projected {formatMoney(state.usage.projectedCostMicroUsd)} / {formatMoney(state.usage.maxProjectedCostMicroUsd)}
      </Text>
      {state.usage.observedCostAvailable
        ? <Text>Observed {formatMoney(state.usage.observedCostMicroUsd)}</Text>
        : null}
      <Text>
        Compactions {state.usage.compactions} · next at {state.usage.compactAtTokens.toLocaleString()}
      </Text>
      {state.notification
        ? <Text color="yellow">{state.notification.code}: {sanitizeTerminalText(state.notification.message)}</Text>
        : null}
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

function formatMoney(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
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

function toolDetail(tool: ToolActivity): string {
  const detail = tool.detail;
  return sanitizeTerminalText([
    `operation ${tool.operationId}`,
    tool.auditSequence ? `audit ${tool.auditSequence}` : "audit pending",
    `duration ${formatDuration(tool.durationMs ?? 0)}`,
    `outcome ${tool.outcome ?? "active"}`,
    detail?.errorCode ? `error ${detail.errorCode}` : "",
    detail?.exitCode !== null && detail?.exitCode !== undefined ? `exit ${detail.exitCode}` : "",
    detail?.timedOut ? "timed out" : "",
    detail?.outputDigest ? `output ${detail.outputDigest}` : "",
  ].filter(Boolean).join(" · "));
}

function statusLabel(status: TuiState["status"]): string {
  return status === "initializing" ? "Initializing…" : status;
}
