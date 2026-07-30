import type {
  AssistantBlock,
  CallModel,
  ConversationMessage,
  ModelRequest,
  ModelToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "../model/contracts";
import {
  TodoWriteInputSchema,
  type TodoItem,
} from "../plan/schema";
import type { E2bTaskSession } from "../sandbox/e2b-session";
import type { ModelToolRequest } from "../tools/contracts";
import { validateToolCall } from "../tools/validate-call";
import type { ProductionCheckpointStore } from "./checkpoint";
import type {
  PendingProductionTurn,
  ProductionAgentState,
} from "./schema";

const MAX_PLAN_TASKS = 20;

export type ProductionLoopResult = {
  status: "completed";
  modelTurns: number;
  acceptedTurns: number;
  protocolRetries: number;
  toolCalls: number;
  planRewrites: number;
  inputTokens: number;
  outputTokens: number;
  plan: TodoItem[];
};

export type ProductionLoopOptions = {
  canonicalRepoPath: string;
  task: string;
  runIdentity: string;
  callModel: CallModel;
  session: Pick<E2bTaskSession, "call">;
  checkpointStore: ProductionCheckpointStore;
  maxModelTurns?: number;
  signal?: AbortSignal;
};

export class ProductionTurnProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionTurnProtocolError";
  }
}

export class ProductionLoopLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionLoopLimitError";
  }
}

const SYSTEM_PROMPT = [
  "You are a coding agent operating in an isolated repository worktree.",
  "Use the strict plan/action protocol below.",
  "",
  "Every response must:",
  "1. Call rewrite_plan exactly once and before every other tool call.",
  "2. Keep a complete plan of 1-20 concise tasks with unique stable IDs.",
  "3. On the first turn, create the plan with completed*, one in_progress, then pending*.",
  "4. On later turns, preserve task IDs, descriptions, order, and count.",
  "5. Complete the active task only after enough successful observations.",
  "6. Keep the active task incomplete after a failed tool observation.",
  "7. If work remains, call exactly one repository tool after rewrite_plan.",
  "8. When every task is completed, call only rewrite_plan.",
  "",
  "Use repository-relative paths. Inspect before editing, preview edits before",
  "applying them, verify changes, and do not attempt to publish or access the host.",
].join("\n");

const TOOL_DEFINITIONS: ModelToolDefinition[] = [
  {
    name: "rewrite_plan",
    description:
      "Replace the complete current plan. This must be the first tool call.",
    strict: true,
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PLAN_TASKS,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              description: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["id", "description", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
  },
  toolDefinition("read_file", "Read a repository-relative UTF-8 file.", {
    path: { type: "string" },
    startLine: { type: "integer" },
    endLine: { type: "integer" },
  }, ["path"]),
  toolDefinition("edit_file", "Preview or apply an exact file edit.", {
    path: { type: "string" },
    mode: { type: "string", enum: ["preview", "apply"] },
    oldText: { type: ["string", "null"] },
    newText: { type: "string" },
    replaceAll: { type: "boolean" },
    baseVersion: { type: "string" },
  }, ["path", "mode", "oldText", "newText"]),
  toolDefinition("ripgrep", "Search repository text.", {
    pattern: { type: "string" },
    path: { type: "string" },
    glob: { type: "string" },
    caseSensitive: { type: "boolean" },
    fixedString: { type: "boolean" },
  }, ["pattern"]),
  toolDefinition("tree_sitter_symbols", "List symbols in a source file.", {
    path: { type: "string" },
  }, ["path"]),
  toolDefinition("run_shell", "Run a bounded shell command in the worktree.", {
    cwd: { type: "string" },
    command: { type: "string" },
    timeoutMs: { type: "integer" },
  }, ["cwd", "command"]),
  toolDefinition("git", "Inspect Git state or create a local commit.", {
    subcommand: {
      type: "string",
      enum: ["status", "diff", "commit"],
    },
    staged: { type: "boolean" },
    path: { type: "string" },
    message: { type: "string" },
    addAll: { type: "boolean" },
  }, ["subcommand"]),
];

export async function runProductionLoop(
  options: ProductionLoopOptions,
): Promise<ProductionLoopResult> {
  const maxModelTurns = options.maxModelTurns ?? 50;
  let state = await initializeState(options);
  validateRecoveredState(state, options);

  if (state.lifecycle === "failed") {
    throw new ProductionTurnProtocolError(
      state.terminalError ?? "Checkpoint contains a failed run.",
    );
  }
  if (state.lifecycle === "completed") return toResult(state);

  while (state.lifecycle === "running") {
    throwIfAborted(options.signal);

    if (state.pendingTurn) {
      state = await commitPendingTurn(state, state.pendingTurn, options);
      continue;
    }
    if (state.counters.modelTurns >= maxModelTurns) {
      throw new ProductionLoopLimitError(
        `Maximum model turn limit of ${maxModelTurns} exceeded.`,
      );
    }

    const turn = await options.callModel(
      createModelRequest(state),
      options.signal ? { signal: options.signal } : undefined,
    );
    const countersAfterModel = {
      ...state.counters,
      modelTurns: state.counters.modelTurns + 1,
      inputTokens: state.counters.inputTokens + turn.usage.inputTokens,
      outputTokens: state.counters.outputTokens + turn.usage.outputTokens,
    };

    let pendingTurn: PendingProductionTurn;
    try {
      pendingTurn = validateProductionTurn(turn.content, turn.stopReason, state);
    } catch (error) {
      const protocolError =
        error instanceof ProductionTurnProtocolError
          ? error
          : new ProductionTurnProtocolError("Model turn validation failed.");
      if (state.consecutiveInvalidAttempts >= 1) {
        state = {
          ...state,
          lifecycle: "failed",
          counters: countersAfterModel,
          terminalError:
            `Model violated the production turn protocol twice: ${protocolError.message}`,
        };
        await options.checkpointStore.save(state);
        throw protocolError;
      }
      state = {
        ...state,
        counters: {
          ...countersAfterModel,
          protocolRetries: countersAfterModel.protocolRetries + 1,
        },
        consecutiveInvalidAttempts: 1,
        transcript: [
          ...state.transcript,
          {
            role: "user",
            content:
              `The previous response was rejected without executing tools: ${protocolError.message} ` +
              "Retry with rewrite_plan first, the complete stable plan, and at most one repository action.",
          },
        ],
      };
      await options.checkpointStore.save(state);
      continue;
    }

    state = {
      ...state,
      counters: countersAfterModel,
      pendingTurn,
    };
    await options.checkpointStore.save(state);
  }

  return toResult(state);
}

async function commitPendingTurn(
  state: ProductionAgentState,
  pending: PendingProductionTurn,
  options: ProductionLoopOptions,
): Promise<ProductionAgentState> {
  const results: ToolResultBlock[] = [
    {
      type: "tool_result",
      toolUseId: pending.planToolId,
      content: JSON.stringify({ accepted: true }),
    },
  ];
  let lastToolSucceeded: boolean | null = null;
  let lastToolResult: ProductionAgentState["lastToolResult"] = null;
  let toolIncrement = 0;

  if (pending.action) {
    throwIfAborted(options.signal);
    const request = validateToolCall(pending.action.request);
    const rawResult = await options.session.call(request, {
      operationId: pending.action.operationId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const { metadata, ...resultWithoutMetadata } = rawResult;
    const persistedResult: NonNullable<
      ProductionAgentState["lastToolResult"]
    > = {
      ...resultWithoutMetadata,
      ...(rawResult.metadata
        ? {
            metadata: Object.fromEntries(
              Object.entries(metadata ?? {}).filter(
                (entry): entry is [
                  string,
                  string | number | boolean | null,
                ] => entry[1] !== undefined,
              ),
            ),
          }
        : {}),
    };
    lastToolResult = persistedResult;
    lastToolSucceeded = persistedResult.success;
    toolIncrement = 1;
    results.push({
      type: "tool_result",
      toolUseId: pending.action.toolUseId,
      content: JSON.stringify(persistedResult),
      isError: !persistedResult.success,
    });
  }

  const completed = pending.plan.every(
    (task) => task.status === "completed",
  );
  const next: ProductionAgentState = {
    ...state,
    lifecycle: completed ? "completed" : "running",
    plan: pending.plan,
    transcript: [
      ...state.transcript,
      { role: "assistant", content: pending.assistantContent },
      { role: "user", content: results },
    ],
    lastToolSucceeded,
    lastToolResult,
    pendingTurn: null,
    consecutiveInvalidAttempts: 0,
    terminalError: null,
    counters: {
      ...state.counters,
      committedTurns: state.counters.committedTurns + 1,
      toolCalls: state.counters.toolCalls + toolIncrement,
      planRewrites: state.counters.planRewrites + 1,
    },
  };
  await options.checkpointStore.save(next);
  return next;
}

function validateProductionTurn(
  content: AssistantBlock[],
  stopReason: string | null,
  state: ProductionAgentState,
): PendingProductionTurn {
  if (stopReason !== "tool_use") {
    throw new ProductionTurnProtocolError(
      `Expected tool_use stop reason, received "${stopReason ?? "null"}".`,
    );
  }
  const calls = content.filter(
    (block): block is ToolUseBlock => block.type === "tool_use",
  );
  const ids = new Set(calls.map((call) => call.id));
  if (
    calls.length < 1 ||
    calls.length > 2 ||
    ids.size !== calls.length ||
    calls.some((call) => !call.id.trim())
  ) {
    throw new ProductionTurnProtocolError(
      "A turn must contain one plan call, at most one action, and unique IDs.",
    );
  }
  const [planCall, actionCall] = calls;
  if (!planCall || planCall.name !== "rewrite_plan") {
    throw new ProductionTurnProtocolError(
      "rewrite_plan must be the first tool call.",
    );
  }
  if (calls.some((call) => call.name === "rewrite_plan") && calls.length > 1 &&
      actionCall?.name === "rewrite_plan") {
    throw new ProductionTurnProtocolError(
      "A turn must contain exactly one rewrite_plan call.",
    );
  }

  const parsed = TodoWriteInputSchema.safeParse(planCall.input);
  if (!parsed.success || parsed.data.plan.length > MAX_PLAN_TASKS) {
    throw new ProductionTurnProtocolError(
      `rewrite_plan must contain 1-${MAX_PLAN_TASKS} valid tasks.`,
    );
  }
  validatePlan(parsed.data.plan, state);
  const complete = parsed.data.plan.every(
    (task) => task.status === "completed",
  );
  if (complete === Boolean(actionCall)) {
    throw new ProductionTurnProtocolError(
      complete
        ? "A completed plan must not include a repository action."
        : "An incomplete plan must include exactly one repository action.",
    );
  }

  let action: PendingProductionTurn["action"] = null;
  if (actionCall) {
    if (actionCall.name === "rewrite_plan") {
      throw new ProductionTurnProtocolError(
        "A turn must contain exactly one rewrite_plan call.",
      );
    }
    let request: ModelToolRequest;
    try {
      request = validateToolCall({
        name: actionCall.name,
        input: actionCall.input,
      });
    } catch (error) {
      throw new ProductionTurnProtocolError(
        error instanceof Error ? error.message : "Invalid repository action.",
      );
    }
    action = {
      toolUseId: actionCall.id,
      operationId: crypto.randomUUID(),
      request,
    };
  }

  return {
    assistantContent: content,
    plan: parsed.data.plan,
    planToolId: planCall.id,
    action,
  };
}

function validatePlan(plan: TodoItem[], state: ProductionAgentState): void {
  const ids = new Set(plan.map((task) => task.id));
  if (ids.size !== plan.length) {
    throw new ProductionTurnProtocolError("Plan task IDs must be unique.");
  }
  const completed = countCompleted(plan);
  const statuses = plan.map((task) => task.status);
  const expected = plan.map((_, index) =>
    index < completed
      ? "completed"
      : index === completed
        ? "in_progress"
        : "pending",
  );
  if (
    completed === plan.length
      ? statuses.some((status) => status !== "completed")
      : statuses.some((status, index) => status !== expected[index])
  ) {
    throw new ProductionTurnProtocolError(
      "Plan statuses must be completed*, one in_progress, then pending*.",
    );
  }
  if (state.plan.length === 0) {
    if (completed !== 0) {
      throw new ProductionTurnProtocolError(
        "The initial plan cannot contain completed tasks.",
      );
    }
    return;
  }
  if (
    plan.length !== state.plan.length ||
    plan.some(
      (task, index) =>
        task.id !== state.plan[index]?.id ||
        task.description !== state.plan[index]?.description,
    )
  ) {
    throw new ProductionTurnProtocolError(
      "Plan task IDs, descriptions, order, and count must remain stable.",
    );
  }
  const previousCompleted = countCompleted(state.plan);
  const maximumCompleted =
    state.lastToolSucceeded === true
      ? previousCompleted + 1
      : previousCompleted;
  if (
    completed < previousCompleted ||
    completed > maximumCompleted
  ) {
    throw new ProductionTurnProtocolError(
      state.lastToolSucceeded
        ? "A successful action may complete at most the active task."
        : "The active task cannot complete without a successful action.",
    );
  }
}

function createModelRequest(state: ProductionAgentState): ModelRequest {
  return {
    system: SYSTEM_PROMPT,
    messages: state.transcript,
    tools: TOOL_DEFINITIONS,
    maxTokens: 4_096,
  };
}

function initialPrompt(task: string): string {
  return [
    "Complete the following repository task:",
    task,
    "",
    "First create a concrete plan, then perform one safe action per turn.",
  ].join("\n");
}

async function initializeState(
  options: ProductionLoopOptions,
): Promise<ProductionAgentState> {
  const existing = await options.checkpointStore.load();
  if (existing) return existing;
  const state: ProductionAgentState = {
    version: 2,
    runIdentity: options.runIdentity,
    canonicalRepoPath: options.canonicalRepoPath,
    task: options.task,
    lifecycle: "running",
    plan: [],
    transcript: [{ role: "user", content: initialPrompt(options.task) }],
    lastToolSucceeded: null,
    pendingTurn: null,
    counters: {
      modelTurns: 0,
      committedTurns: 0,
      protocolRetries: 0,
      toolCalls: 0,
      planRewrites: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    consecutiveInvalidAttempts: 0,
    terminalError: null,
    lastToolResult: null,
  };
  await options.checkpointStore.save(state);
  return state;
}

function validateRecoveredState(
  state: ProductionAgentState,
  options: ProductionLoopOptions,
): void {
  if (
    state.runIdentity !== options.runIdentity ||
    state.canonicalRepoPath !== options.canonicalRepoPath ||
    state.task !== options.task
  ) {
    throw new ProductionTurnProtocolError(
      "Checkpoint identity does not match the canonical repository and task.",
    );
  }
  if (
    state.lifecycle === "completed" !==
    (state.plan.length > 0 &&
      state.plan.every((task) => task.status === "completed"))
  ) {
    throw new ProductionTurnProtocolError(
      "Checkpoint lifecycle and committed plan disagree.",
    );
  }
  if (state.lifecycle !== "running" && state.pendingTurn) {
    throw new ProductionTurnProtocolError(
      "A terminal checkpoint cannot contain a pending turn.",
    );
  }
}

function toResult(state: ProductionAgentState): ProductionLoopResult {
  if (state.lifecycle !== "completed") {
    throw new ProductionTurnProtocolError(
      "Production loop did not reach a completed state.",
    );
  }
  return {
    status: "completed",
    modelTurns: state.counters.modelTurns,
    acceptedTurns: state.counters.committedTurns,
    protocolRetries: state.counters.protocolRetries,
    toolCalls: state.counters.toolCalls,
    planRewrites: state.counters.planRewrites,
    inputTokens: state.counters.inputTokens,
    outputTokens: state.counters.outputTokens,
    plan: state.plan,
  };
}

function countCompleted(plan: TodoItem[]): number {
  return plan.findIndex((task) => task.status !== "completed") === -1
    ? plan.length
    : plan.findIndex((task) => task.status !== "completed");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The production run was aborted.", "AbortError");
  }
}

function toolDefinition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ModelToolDefinition {
  return {
    name,
    description,
    strict: true,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}
