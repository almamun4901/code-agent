import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import type {
  AgentEvent,
  AgentEventInput,
} from "../src/runtime/events";
import { AgentApp } from "../src/tui/app";
import {
  initialTuiState,
  MAX_TOOL_EVENT_BYTES,
  MAX_TOOL_EVENTS,
  reduceAgentEvent,
  toolEventBytes,
} from "../src/tui/state";
import { formatStaticEvent } from "../src/tui/static-output";

describe("terminal reducer", () => {
  test("retains the committed plan while showing shutdown failures", () => {
    let state = reduceAgentEvent(
      initialTuiState,
      event({
        type: "state_loaded",
        lifecycle: "running",
        plan: [
          { id: "one", description: "Inspect", status: "in_progress" },
          { id: "two", description: "Verify", status: "pending" },
        ],
        usage: { modelTurns: 1, inputTokens: 12, outputTokens: 4 },
      }),
    );
    state = reduceAgentEvent(
      state,
      event({ type: "shutdown_started", reason: "failed" }),
    );
    state = reduceAgentEvent(
      state,
      event({
        type: "run_finished",
        reason: "failed",
        cleanup: "failed",
        error: { code: "TEST_ERROR", message: "Cleanup failed" },
      }),
    );

    expect(state.plan).toHaveLength(2);
    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("TEST_ERROR");
  });

  test("bounds tool history by count and bytes while preserving active and latest failure", () => {
    let state = initialTuiState;
    const largeSummary = "界".repeat(600);
    for (let index = 0; index < 260; index += 1) {
      const operationId = `operation-${index}`;
      state = reduceAgentEvent(
        state,
        event({
          type: "tool_started",
          operationId,
          toolName: "read_file",
          summary: largeSummary,
        }, index * 2 + 1),
      );
      if (index < 259) {
        state = reduceAgentEvent(
          state,
          event({
            type: "tool_finished",
            operationId,
            durationMs: index,
            outcome: index === 17 ? "failed" : "succeeded",
          }, index * 2 + 2),
        );
      }
    }

    expect(state.tools.length).toBeLessThanOrEqual(MAX_TOOL_EVENTS);
    expect(toolEventBytes(state.tools)).toBeLessThanOrEqual(
      MAX_TOOL_EVENT_BYTES,
    );
    expect(
      state.tools.some((tool) => tool.operationId === "operation-17"),
    ).toBe(true);
    expect(
      state.tools.some((tool) => tool.operationId === "operation-259"),
    ).toBe(true);
  });
});

describe("responsive Ink application", () => {
  test.each([60, 79, 80, 119, 120])(
    "renders the expected panes at width %i",
    (width) => {
      const frame = renderToString(
        <AgentApp state={initialTuiState} width={width} />,
        { columns: width },
      );
      expect(frame).toContain("Plan");
      expect(frame).toContain("Tool activity");
      expect(frame).toContain("Status & budget");
      expect(frame).toContain("Initializing…");
      expect(frame).toContain("Dollar cost available");
      expect(frame).toContain("Step 8");
      expect(frame).not.toContain("o200k_base");
      expect(
        Math.max(...frame.split("\n").map((line) => [...line].length)),
      ).toBeLessThanOrEqual(width);
    },
  );

  test("switches layouts on resize and handles long wide-character content", () => {
    const state = reduceAgentEvent(
      initialTuiState,
      event({
        type: "plan_committed",
        plan: [{
          id: "wide",
          description: `検証 ${"界".repeat(80)}`,
          status: "in_progress",
        }],
      }),
    );
    const view = render(<AgentApp state={state} width={79} />);
    const stacked = view.lastFrame() ?? "";
    view.rerender(<AgentApp state={state} width={120} />);
    const wide = view.lastFrame() ?? "";

    expect(
      stacked.indexOf("Tool activity"),
    ).toBeGreaterThan(stacked.indexOf("Plan"));
    expect(wide.split("\n")[1]).toContain("Tool activity");
    expect(wide).toContain("検証");
    view.unmount();
  });

  test("renders tool outcomes, actual usage, and errors without replacing plan", () => {
    let state = reduceAgentEvent(
      initialTuiState,
      event({
        type: "state_loaded",
        lifecycle: "running",
        plan: [{
          id: "inspect",
          description: "Inspect repository",
          status: "in_progress",
        }],
        usage: { modelTurns: 2, inputTokens: 100, outputTokens: 25 },
      }),
    );
    state = reduceAgentEvent(
      state,
      event({
        type: "tool_started",
        operationId: "operation",
        toolName: "git",
        summary: "status",
      }),
    );
    state = reduceAgentEvent(
      state,
      event({
        type: "tool_finished",
        operationId: "operation",
        durationMs: 1_250,
        outcome: "denied",
      }),
    );
    state = reduceAgentEvent(
      state,
      event({
        type: "run_finished",
        reason: "failed",
        cleanup: "succeeded",
        error: { code: "DENIED", message: "Policy blocked the action" },
      }),
    );
    const frame = renderToString(
      <AgentApp state={state} width={120} />,
      { columns: 120 },
    );

    expect(frame).toContain("Inspect repository");
    expect(frame).toContain("git · status · 1.3s");
    expect(frame).toContain("Turns 2 · Input 100 · Output");
    expect(frame).toContain("25");
    expect(frame).toContain("DENIED: Policy blocked");
  });
});

describe("non-TTY output", () => {
  test("uses line-oriented lifecycle summaries with no ANSI sequences", () => {
    const lines = [
      ...formatStaticEvent(event({
        type: "tool_started",
        operationId: "operation",
        toolName: "run_shell",
        summary: "in .",
      })),
      ...formatStaticEvent(event({
        type: "run_finished",
        reason: "completed",
        cleanup: "succeeded",
      })),
    ];
    const output = `${lines.join("\n")}\n`;
    expect(output).toContain("Tool started: run_shell in .");
    expect(output).toContain("Run finished: completed");
    expect(output).not.toMatch(/\u001B\[[0-?]*[ -/]*[@-~]/);
  });
});

let sequence = 0;

function event(
  input: AgentEventInput,
  explicitSequence?: number,
): AgentEvent {
  return {
    ...input,
    sequence: explicitSequence ?? ++sequence,
    timestamp: new Date(
      1_700_000_000_000 + (explicitSequence ?? sequence),
    ).toISOString(),
  } as AgentEvent;
}
