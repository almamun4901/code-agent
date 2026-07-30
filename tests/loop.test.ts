import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import {
  createInitialPlan,
  LoopLimitError,
  MemoryCheckpointStore,
  PHASE_ONE_TOOLS,
  PHASE_ONE_TASKS,
  runAgentLoop,
  TurnProtocolError,
  validateTurn,
  type PlanTask,
} from "../src/loop";
import {
  createAnthropicModel,
  ModelConfigurationError,
  ModelProviderError,
  ModelRequestCancelledError,
  type CallModel,
  type ModelRequest,
  type ModelTurn,
  type ToolResultBlock,
} from "../src/model/anthropic";
import { fakeReadFile } from "../src/tools/fake-read-file";

describe("validateTurn", () => {
  test("accepts a full plan rewrite followed by the current read", () => {
    const turn = makeTurn(0);

    const validated = validateTurn(turn, createInitialPlan());

    expect(validated.plan).toEqual(makePlan(0));
    expect(validated.planTool.id).toBe("plan-0");
    expect(validated.readTool?.id).toBe("read-0");
    expect(validated.readPath).toBe("package.json");
  });

  test("accepts a completed plan with no read after the last success", () => {
    const validated = validateTurn(makeTurn(3), makePlan(2), true);

    expect(validated.plan.every((task) => task.status === "completed")).toBe(
      true,
    );
    expect(validated.readTool).toBeNull();
    expect(validated.readPath).toBeNull();
  });

  test.each([
    {
      name: "missing rewrite_plan",
      turn: makeRawTurn([
        tool("read-only", "read_file", { path: "package.json" }),
      ]),
      message: "exactly one rewrite_plan",
    },
    {
      name: "duplicate rewrite_plan",
      turn: makeRawTurn([
        tool("plan-a", "rewrite_plan", { plan: makePlan(0) }),
        tool("plan-b", "rewrite_plan", { plan: makePlan(0) }),
      ]),
      message: "exactly one rewrite_plan",
    },
    {
      name: "unknown tool",
      turn: makeRawTurn([
        tool("plan", "rewrite_plan", { plan: makePlan(0) }),
        tool("unknown", "write_file", { path: "package.json" }),
      ]),
      message: "Unknown tool",
    },
    {
      name: "multiple reads",
      turn: makeRawTurn([
        tool("plan", "rewrite_plan", { plan: makePlan(0) }),
        tool("read-a", "read_file", { path: "package.json" }),
        tool("read-b", "read_file", { path: "package.json" }),
      ]),
      message: "at most one read_file",
    },
    {
      name: "action before plan",
      turn: makeRawTurn([
        tool("read", "read_file", { path: "package.json" }),
        tool("plan", "rewrite_plan", { plan: makePlan(0) }),
      ]),
      message: "first tool call",
    },
    {
      name: "duplicate tool IDs",
      turn: makeRawTurn([
        tool("same-id", "rewrite_plan", { plan: makePlan(0) }),
        tool("same-id", "read_file", { path: "package.json" }),
      ]),
      message: "non-empty and unique",
    },
    {
      name: "malformed plan input",
      turn: makeRawTurn([
        tool("plan", "rewrite_plan", { tasks: makePlan(0) }),
      ]),
      message: "failed validation",
    },
    {
      name: "unexpected rewrite_plan field",
      turn: makeRawTurn([
        tool("plan", "rewrite_plan", {
          plan: makePlan(0),
          untrusted: true,
        }),
      ]),
      message: "failed validation",
    },
    {
      name: "unexpected plan task field",
      turn: makeRawTurn([
        tool("plan", "rewrite_plan", {
          plan: makePlan(0).map((task, index) =>
            index === 0 ? { ...task, untrusted: true } : task,
          ),
        }),
      ]),
      message: "failed validation",
    },
    {
      name: "malformed read input",
      turn: makeRawTurn([
        tool("plan", "rewrite_plan", { plan: makePlan(0) }),
        tool("read", "read_file", { path: "" }),
      ]),
      message: "non-empty path",
    },
    {
      name: "unexpected read field",
      turn: makeRawTurn([
        tool("plan", "rewrite_plan", { plan: makePlan(0) }),
        tool("read", "read_file", {
          path: "package.json",
          untrusted: true,
        }),
      ]),
      message: "non-empty path",
    },
    {
      name: "wrong path",
      turn: makeRawTurn([
        tool("plan", "rewrite_plan", { plan: makePlan(0) }),
        tool("read", "read_file", { path: "src/loop.ts" }),
      ]),
      message: "does not match current task",
    },
  ])("rejects $name", ({ turn, message }) => {
    expect(() => validateTurn(turn, createInitialPlan())).toThrow(message);
  });

  test("rejects a non-tool stop reason", () => {
    const turn = makeRawTurn([], "end_turn");

    expect(() => validateTurn(turn, createInitialPlan())).toThrow(
      'Expected stop_reason "tool_use"',
    );
  });

  test("rejects reordered or changed plan definitions", () => {
    const changed = makePlan(0);
    const firstTask = changed[0];
    if (!firstTask) throw new Error("Missing first test task");
    changed[0] = { ...firstTask, description: "Different task" };

    expect(() =>
      validateTurn(
        makeRawTurn([
          tool("plan", "rewrite_plan", { plan: changed }),
          tool("read", "read_file", { path: "package.json" }),
        ]),
        createInitialPlan(),
      ),
    ).toThrow("preserve its original ID and description");
  });

  test("does not normalize canonical plan text before comparison", () => {
    const changed = makePlan(0);
    const firstTask = changed[0];
    if (!firstTask) throw new Error("Missing first test task");
    changed[0] = { ...firstTask, id: ` ${firstTask.id}` };

    expect(() =>
      validateTurn(
        makeRawTurn([
          tool("plan", "rewrite_plan", { plan: changed }),
          tool("read", "read_file", { path: "package.json" }),
        ]),
        createInitialPlan(),
      ),
    ).toThrow("preserve its original ID and description");
  });

  test("rejects status gaps and multiple in-progress tasks", () => {
    const invalid = makePlan(0);
    const secondTask = invalid[1];
    if (!secondTask) throw new Error("Missing second test task");
    secondTask.status = "in_progress";

    expect(() =>
      validateTurn(
        makeRawTurn([
          tool("plan", "rewrite_plan", { plan: invalid }),
          tool("read", "read_file", { path: "package.json" }),
        ]),
        createInitialPlan(),
      ),
    ).toThrow("completed*, then one in_progress");
  });

  test("rejects completion before a successful observation", () => {
    expect(() =>
      validateTurn(makeTurn(1), createInitialPlan(), null),
    ).toThrow("before a successful read observation");
  });

  test("rejects a successful observation that does not advance", () => {
    expect(() => validateTurn(makeTurn(0), makePlan(0), true)).toThrow(
      "must become completed",
    );
  });

  test("keeps a task incomplete after a failed observation", () => {
    expect(validateTurn(makeTurn(0), makePlan(0), false).plan).toEqual(
      makePlan(0),
    );
    expect(() => validateTurn(makeTurn(1), makePlan(0), false)).toThrow(
      "failed read observation",
    );
  });
});

describe("runAgentLoop", () => {
  test("completes four accepted turns and correlates every tool result", async () => {
    const requests: ModelRequest[] = [];
    const reads: string[] = [];
    const callModel = queuedModel(
      [makeTurn(0), makeTurn(1), makeTurn(2), makeTurn(3)],
      requests,
    );

    const result = await runAgentLoop({
      callModel,
      checkpointStore: new MemoryCheckpointStore(),
      readFile: (path) => {
        reads.push(path);
        return fakeReadFile(path);
      },
      logger: () => {},
    });

    expect(result.status).toBe("completed");
    expect(result.modelTurns).toBe(4);
    expect(result.acceptedTurns).toBe(4);
    expect(result.planRewrites).toBe(4);
    expect(result.readCalls).toBe(3);
    expect(result.protocolRetries).toBe(0);
    expect(result.inputTokens).toBe(40);
    expect(result.outputTokens).toBe(8);
    expect(reads).toEqual([
      "package.json",
      "src/loop.ts",
      "tests/loop.test.ts",
    ]);
    expect(result.plan.every((task) => task.status === "completed")).toBe(true);
    expect(requests).toHaveLength(4);

    const resultMessages = result.transcript.filter(
      (message) =>
        message.role === "user" && Array.isArray(message.content),
    );
    expect(resultMessages).toHaveLength(4);

    for (const [index, message] of resultMessages.entries()) {
      if (!Array.isArray(message.content)) {
        throw new Error("Expected tool-result content");
      }
      const blocks = message.content as ToolResultBlock[];
      const planResult = blocks[0];
      if (!planResult) throw new Error("Missing plan result");
      expect(planResult.toolUseId).toBe(`plan-${index}`);

      if (index < 3) {
        expect(blocks).toHaveLength(2);
        const readResult = blocks[1];
        if (!readResult) throw new Error("Missing read result");
        expect(readResult.toolUseId).toBe(`read-${index}`);
      } else {
        expect(blocks).toHaveLength(1);
      }
    }
  });

  test("provides the canonical plan before the first model turn", async () => {
    const requests: ModelRequest[] = [];

    await runAgentLoop({
      checkpointStore: new MemoryCheckpointStore(),
      callModel: queuedModel(
        [makeTurn(0), makeTurn(1), makeTurn(2), makeTurn(3)],
        requests,
      ),
      logger: () => {},
    });

    const firstRequest = requests[0];
    if (!firstRequest) throw new Error("Missing first model request");
    const initialMessage = firstRequest.messages[0];
    if (!initialMessage || typeof initialMessage.content !== "string") {
      throw new Error("Missing initial user prompt");
    }

    for (const task of PHASE_ONE_TASKS) {
      expect(initialMessage.content).toContain(task.id);
      expect(initialMessage.content).toContain(task.description);
    }
    expect(initialMessage.content).toContain('"status":"pending"');
    expect(firstRequest.system).toContain(
      "Each turn may complete at most one task.",
    );
    expect(firstRequest.system).not.toContain("only one status change");
  });

  test("retries one malformed response without executing a tool", async () => {
    const reads: string[] = [];
    const invalid = makeRawTurn([], "end_turn");
    const callModel = queuedModel([
      invalid,
      makeTurn(0),
      makeTurn(1),
      makeTurn(2),
      makeTurn(3),
    ]);

    const result = await runAgentLoop({
      callModel,
      checkpointStore: new MemoryCheckpointStore(),
      readFile: (path) => {
        reads.push(path);
        return fakeReadFile(path);
      },
      logger: () => {},
    });

    expect(result.modelTurns).toBe(5);
    expect(result.acceptedTurns).toBe(4);
    expect(result.protocolRetries).toBe(1);
    expect(reads).toHaveLength(3);
    expect(
      result.transcript.some(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes("rejected without executing any tool"),
      ),
    ).toBe(true);
  });

  test("does not replay rejected tool calls in the provider transcript", async () => {
    const requests: ModelRequest[] = [];
    const invalid = makeRawTurn([
      tool("rejected-plan", "rewrite_plan", { plan: makePlan(0) }),
      tool("rejected-read", "read_file", { path: "wrong.txt" }),
    ]);

    await runAgentLoop({
      checkpointStore: new MemoryCheckpointStore(),
      callModel: queuedModel(
        [
          invalid,
          makeTurn(0),
          makeTurn(1),
          makeTurn(2),
          makeTurn(3),
        ],
        requests,
      ),
      logger: () => {},
    });

    const retryRequest = requests[1];
    if (!retryRequest) throw new Error("Missing retry request");

    expect(retryRequest.messages).toHaveLength(2);
    expect(retryRequest.messages.every((message) => message.role === "user")).toBe(
      true,
    );
    expect(JSON.stringify(retryRequest.messages)).not.toContain(
      "rejected-plan",
    );
    expect(JSON.stringify(retryRequest.messages)).not.toContain(
      "rejected-read",
    );
  });

  test("aborts after two consecutive malformed responses", async () => {
    let readCount = 0;
    const invalid = makeRawTurn([], "end_turn");

    await expect(
      runAgentLoop({
        callModel: queuedModel([invalid, invalid]),
        checkpointStore: new MemoryCheckpointStore(),
        readFile: () => {
          readCount += 1;
          return { success: true, content: "unexpected" };
        },
        logger: () => {},
      }),
    ).rejects.toBeInstanceOf(TurnProtocolError);
    expect(readCount).toBe(0);
  });

  test("enforces the maximum model-turn ceiling", async () => {
    await expect(
      runAgentLoop({
        callModel: queuedModel([makeTurn(0)]),
        checkpointStore: new MemoryCheckpointStore(),
        maxModelTurns: 1,
        logger: () => {},
      }),
    ).rejects.toBeInstanceOf(LoopLimitError);
  });

  test("passes the caller cancellation signal to model requests", async () => {
    const controller = new AbortController();
    controller.abort();
    let receivedSignal: AbortSignal | undefined;

    await expect(
      runAgentLoop({
        callModel: async (_request, options) => {
          receivedSignal = options?.signal;
          throw new ModelRequestCancelledError();
        },
        checkpointStore: new MemoryCheckpointStore(),
        logger: () => {},
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ModelRequestCancelledError);
    expect(receivedSignal).toBe(controller.signal);
  });
});

describe("fakeReadFile", () => {
  test("returns canned content for each accepted fixture", () => {
    for (const task of PHASE_ONE_TASKS) {
      const result = fakeReadFile(task.path);
      expect(result.success).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    }
  });

  test.each(["", "/etc/passwd", "../secret", "src//loop.ts", "src\\loop.ts"])(
    "rejects unsafe path %p",
    (path) => {
      expect(fakeReadFile(path)).toEqual({
        success: false,
        content: expect.stringContaining("Invalid fake path"),
      });
    },
  );

  test("returns a visible error for an unknown safe path", () => {
    expect(fakeReadFile("unknown.txt")).toEqual({
      success: false,
      content: 'Fake file not found: "unknown.txt".',
    });
  });
});

describe("Anthropic model adapter", () => {
  test("fails before making a request when the API key is missing", () => {
    expect(() => createAnthropicModel({ apiKey: "" })).toThrow(
      ModelConfigurationError,
    );
  });

  test("normalizes provider failures without exposing raw error content", async () => {
    const callModel = createAnthropicModel({
      apiKey: "test-key",
      client: {
        messages: {
          create: async () => {
            throw new Error("secret raw provider body");
          },
        },
      },
    });

    await expect(callModel(makeRequest())).rejects.toEqual(
      new ModelProviderError("Anthropic request failed unexpectedly."),
    );
  });

  test("propagates caller cancellation to the Anthropic request", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const callModel = createAnthropicModel({
      apiKey: "test-key",
      client: {
        messages: {
          create: async (_params, options) => {
            receivedSignal = options?.signal;
            throw new DOMException("aborted", "AbortError");
          },
        },
      },
    });

    controller.abort();
    await expect(
      callModel(makeRequest(), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ModelRequestCancelledError);
    expect(receivedSignal).toBe(controller.signal);
  });

  test("keeps safe 4xx validation detail without exposing the raw envelope", async () => {
    const callModel = createAnthropicModel({
      apiKey: "test-key",
      client: {
        messages: {
          create: async () => {
            throw new Anthropic.BadRequestError(
              400,
              {
                type: "error",
                error: {
                  type: "invalid_request_error",
                  message:
                    " tools.0.input_schema: minItems is not supported\n",
                },
                secret_envelope_field: "must-not-leak",
              },
              undefined,
              new Headers(),
            );
          },
        },
      },
    });

    await expect(callModel(makeRequest())).rejects.toEqual(
      new ModelProviderError(
        "Anthropic request failed (400): tools.0.input_schema: minItems is not supported",
        400,
      ),
    );
  });

  test("Phase 1 strict tool schemas use Anthropic's supported subset", () => {
    const serialized = JSON.stringify(PHASE_ONE_TOOLS);

    expect(serialized).not.toContain('"minItems"');
    expect(serialized).not.toContain('"maxItems"');
    expect(serialized).not.toContain('"minLength"');
    expect(PHASE_ONE_TOOLS.every((tool) => tool.strict)).toBe(true);
  });

  test("normalizes a successful provider response", async () => {
    const originalModel = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = "";
    let requestedModel: string | undefined;
    try {
      const callModel = createAnthropicModel({
        apiKey: "test-key",
        model: "   ",
        client: {
          messages: {
            create: async (params) => {
              requestedModel = params.model;
              return {
                content: [
                  { type: "text", text: "working" },
                  {
                    type: "tool_use",
                    id: "plan",
                    name: "rewrite_plan",
                    input: { plan: makePlan(0) },
                    caller: { type: "direct" },
                  },
                ],
                stop_reason: "tool_use",
                usage: { input_tokens: 7, output_tokens: 3 },
              } as never;
            },
          },
        },
      });

      expect(await callModel(makeRequest())).toEqual({
        content: [
          { type: "text", text: "working" },
          {
            type: "tool_use",
            id: "plan",
            name: "rewrite_plan",
            input: { plan: makePlan(0) },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 7, outputTokens: 3 },
      });
      expect(requestedModel).toBe("claude-haiku-4-5");
    } finally {
      if (originalModel === undefined) {
        delete process.env.ANTHROPIC_MODEL;
      } else {
        process.env.ANTHROPIC_MODEL = originalModel;
      }
    }
  });
});

function makePlan(completedCount: number): PlanTask[] {
  return PHASE_ONE_TASKS.map((task, index) => ({
    id: task.id,
    description: task.description,
    status:
      index < completedCount
        ? "completed"
        : index === completedCount
          ? "in_progress"
          : "pending",
  }));
}

function makeTurn(completedCount: number): ModelTurn {
  const plan = makePlan(completedCount);
  const blocks = [
    tool(`plan-${completedCount}`, "rewrite_plan", { plan }),
  ];

  if (completedCount < PHASE_ONE_TASKS.length) {
    const task = PHASE_ONE_TASKS[completedCount];
    if (!task) throw new Error("Missing Phase 1 task fixture");
    blocks.push(
      tool(`read-${completedCount}`, "read_file", {
        path: task.path,
      }),
    );
  }

  return makeRawTurn(blocks);
}

function makeRawTurn(
  content: ModelTurn["content"],
  stopReason: ModelTurn["stopReason"] = "tool_use",
): ModelTurn {
  return {
    content,
    stopReason,
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}

function tool(
  id: string,
  name: string,
  input: unknown,
): ModelTurn["content"][number] {
  return { type: "tool_use", id, name, input };
}

function queuedModel(
  turns: ModelTurn[],
  requests: ModelRequest[] = [],
): CallModel {
  let index = 0;

  return async (request) => {
    requests.push(structuredClone(request));
    const turn = turns[index];
    index += 1;

    if (!turn) {
      throw new Error("Fake model queue exhausted");
    }
    return structuredClone(turn);
  };
}

function makeRequest(): ModelRequest {
  return {
    system: "test",
    messages: [{ role: "user", content: "test" }],
    tools: [],
    maxTokens: 32,
  };
}
