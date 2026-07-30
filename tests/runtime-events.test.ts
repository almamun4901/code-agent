import { afterEach, describe, expect, test } from "bun:test";
import type { ModelTurn } from "../src/model/contracts";
import type { McpToolCallOptions } from "../src/mcp/client";
import {
  createAgentEventPublisher,
  safeToolSummary,
  type AgentEvent,
} from "../src/runtime/events";
import { prepareAgentRun } from "../src/runtime/agent-runner";
import {
  MemoryProductionCheckpointStore,
  type ProductionCheckpointStore,
} from "../src/runtime/checkpoint";
import { runProductionLoop } from "../src/runtime/production-loop";
import type { ProductionAgentState } from "../src/runtime/schema";
import type {
  ModelToolRequest,
  ToolResult,
} from "../src/tools/contracts";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "./support/temp-repo";

const repositories: TemporaryRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repo) => repo.cleanup()));
});

describe("runtime observation events", () => {
  test("publishes ordered durable state, usage, and paired tool events", async () => {
    const repo = await createTemporaryRepository();
    repositories.push(repo);
    const prepared = await prepareAgentRun(repo.worktreePath, "Inspect safely");
    const observed: AgentEvent[] = [];
    const events = createAgentEventPublisher((event) => observed.push(event));
    const store = new MemoryProductionCheckpointStore();
    const turns = [
      modelTurn(
        [["inspect", "Inspect the file", "in_progress"]],
        {
          name: "read_file",
          input: { path: "README.md" },
        },
      ),
      modelTurn([["inspect", "Inspect the file", "completed"]]),
    ];
    let modelIndex = 0;

    await runProductionLoop({
      ...prepared,
      checkpointStore: store,
      events,
      callModel: async () => turns[modelIndex++]!,
      session: new FakeSession(),
    });

    expect(observed.map((event) => event.type)).toEqual([
      "state_loaded",
      "usage_updated",
      "tool_started",
      "tool_finished",
      "plan_committed",
      "usage_updated",
      "plan_committed",
    ]);
    expect(observed.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(observed.every((event) =>
      !Number.isNaN(Date.parse(event.timestamp))
    )).toBe(true);
    expect(observed.find((event) => event.type === "tool_started"))
      .toMatchObject({
        toolName: "read_file",
        summary: "README.md",
      });
    expect(observed.find((event) => event.type === "tool_finished"))
      .toMatchObject({ outcome: "succeeded" });
  });

  test("does not claim a plan commit when durable persistence fails", async () => {
    const repo = await createTemporaryRepository();
    repositories.push(repo);
    const prepared = await prepareAgentRun(repo.worktreePath, "Inspect safely");
    const observed: AgentEvent[] = [];
    const backing = new MemoryProductionCheckpointStore();
    let saves = 0;
    const store: ProductionCheckpointStore = {
      load: () => backing.load(),
      async save(state: ProductionAgentState) {
        saves += 1;
        if (saves === 3) throw new Error("durability unavailable");
        await backing.save(state);
      },
    };

    await expect(runProductionLoop({
      ...prepared,
      checkpointStore: store,
      events: createAgentEventPublisher((event) => observed.push(event)),
      callModel: async () =>
        modelTurn(
          [["inspect", "Inspect the file", "in_progress"]],
          { name: "read_file", input: { path: "README.md" } },
        ),
      session: new FakeSession(),
    })).rejects.toThrow("durability unavailable");

    expect(observed.some((event) => event.type === "plan_committed"))
      .toBe(false);
  });

  test("redacts sensitive tool inputs and caps summaries at 2 KiB", () => {
    const secret = "do-not-display-this-secret";
    const summaries = [
      safeToolSummary({
        name: "ripgrep",
        input: {
          pattern: secret,
          path: "src",
          glob: "*.ts",
        },
      }),
      safeToolSummary({
        name: "run_shell",
        input: { cwd: ".", command: `echo ${secret}` },
      }),
      safeToolSummary({
        name: "git",
        input: {
          subcommand: "commit",
          message: secret,
          addAll: true,
        },
      }),
      safeToolSummary({
        name: "read_file",
        input: { path: `${"界".repeat(1_000)}.ts` },
      }),
    ];

    expect(summaries.every((summary) => !summary.includes(secret))).toBe(true);
    expect(
      summaries.every(
        (summary) => new TextEncoder().encode(summary).byteLength <= 2_048,
      ),
    ).toBe(true);
  });

  test("isolates sink failures from the runner", () => {
    const publisher = createAgentEventPublisher(() => {
      throw new Error("render failed");
    });
    expect(() =>
      publisher.emit({
        type: "run_started",
        runIdentity: "a".repeat(64),
      })
    ).not.toThrow();
  });

  test("reports denied and cancelled outcomes without tool output", async () => {
    const repo = await createTemporaryRepository();
    repositories.push(repo);
    const prepared = await prepareAgentRun(repo.worktreePath, "Check policy");
    const observed: AgentEvent[] = [];
    const session = new FakeSession();
    session.result = {
      success: false,
      output: "secret denied command",
      truncated: false,
      originalTokenCount: 3,
      codec: "test",
      metadata: { code: "TEST_POLICY_DENIED", denied: true },
    };

    await runProductionLoop({
      ...prepared,
      checkpointStore: new MemoryProductionCheckpointStore(),
      events: createAgentEventPublisher((event) => observed.push(event)),
      callModel: sequence([
        modelTurn(
          [["check", "Check policy", "in_progress"]],
          { name: "run_shell", input: { cwd: ".", command: "secret" } },
        ),
        modelTurn([["check", "Check policy", "in_progress"]]),
      ]),
      maxModelTurns: 2,
      session,
    }).catch(() => {});

    const finished = observed.find((event) => event.type === "tool_finished");
    expect(finished).toMatchObject({ outcome: "denied" });
    expect(JSON.stringify(observed)).not.toContain("secret denied command");
    expect(JSON.stringify(observed)).not.toContain('"command":"secret"');
  });
});

class FakeSession {
  result: ToolResult = {
    success: true,
    output: "ok",
    truncated: false,
    originalTokenCount: 1,
    codec: "test",
  };

  async call(
    _request: ModelToolRequest,
    _options?: McpToolCallOptions,
  ): Promise<ToolResult> {
    return this.result;
  }
}

function sequence(turns: ModelTurn[]) {
  let index = 0;
  return async () => {
    const turn = turns[index++];
    if (!turn) throw new Error("No more model turns.");
    return turn;
  };
}

function modelTurn(
  tasks: Array<
    [string, string, "pending" | "in_progress" | "completed"]
  >,
  request?: ModelToolRequest,
): ModelTurn {
  return {
    content: [
      {
        type: "tool_use",
        id: crypto.randomUUID(),
        name: "rewrite_plan",
        input: {
          plan: tasks.map(([id, description, status]) => ({
            id,
            description,
            status,
          })),
        },
      },
      ...(request
        ? [{
            type: "tool_use" as const,
            id: crypto.randomUUID(),
            name: request.name,
            input: request.input,
          }]
        : []),
    ],
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}
