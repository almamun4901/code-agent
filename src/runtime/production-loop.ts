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
import { toolResultWireSchema } from "../mcp/schemas";
import type { ModelToolRequest } from "../tools/contracts";
import { validateToolCall } from "../tools/validate-call";
import type { ProductionCheckpointStore } from "./checkpoint";
import {
  type AgentEventPublisher,
  safeToolSummary,
  toolOutcome,
  usageFromCounters,
} from "./events";
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
  events?: AgentEventPublisher;
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
  "A plan response must:",
  "1. Call rewrite_plan exactly once and before every other tool call.",
  "2. Keep a complete plan of 1-20 concise tasks with unique IDs.",
  "3. Keep at least one task in_progress while work remains.",
  "4. On later turns, rewrite the complete current plan; revise it when new",
  "   information changes the necessary work.",
  "5. Complete the active task only after enough successful observations.",
  "6. Keep the active task incomplete after a failed tool observation.",
  "7. If work remains, call at most one repository tool after rewrite_plan.",
  "8. When every task is completed, call only rewrite_plan.",
  "9. Between plan rewrites, action responses may call exactly one repository",
  "   tool without repeating rewrite_plan. Rewrite the plan when status changes.",
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
  options.events?.emit({
    type: "state_loaded",
    lifecycle: state.lifecycle,
    plan: state.plan,
    usage: usageFromCounters(state.counters),
  });

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
        options.events?.emit({
          type: "usage_updated",
          usage: usageFromCounters(state.counters),
        });
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
              "Retry with a complete rewrite_plan or one action against the committed plan.",
          },
        ],
      };
      await options.checkpointStore.save(state);
      options.events?.emit({
        type: "usage_updated",
        usage: usageFromCounters(state.counters),
      });
      continue;
    }

    state = {
      ...state,
      counters: countersAfterModel,
      pendingTurn,
    };
    await options.checkpointStore.save(state);
    options.events?.emit({
      type: "usage_updated",
      usage: usageFromCounters(state.counters),
    });
  }

  return toResult(state);
}

async function commitPendingTurn(
  state: ProductionAgentState,
  pending: PendingProductionTurn,
  options: ProductionLoopOptions,
): Promise<ProductionAgentState> {
  const results: ToolResultBlock[] = pending.planToolId
    ? [{
      type: "tool_result",
      toolUseId: pending.planToolId,
      content: JSON.stringify({ accepted: true }),
    }]
    : [];
  let lastToolSucceeded: boolean | null = null;
  let lastToolResult: ProductionAgentState["lastToolResult"] = null;
  let toolIncrement = 0;

  if (pending.action) {
    throwIfAborted(options.signal);
    const request = validateToolCall(pending.action.request);
    const startedAt = performance.now();
    options.events?.emit({
      type: "tool_started",
      operationId: pending.action.operationId,
      toolName: request.name,
      summary: safeToolSummary(request),
    });
    let rawResult;
    try {
      rawResult = await options.session.call(request, {
        operationId: pending.action.operationId,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      options.events?.emit({
        type: "tool_finished",
        operationId: pending.action.operationId,
        durationMs: Math.max(0, performance.now() - startedAt),
        outcome: toolOutcome(rawResult),
      });
    } catch (error) {
      options.events?.emit({
        type: "tool_finished",
        operationId: pending.action.operationId,
        durationMs: Math.max(0, performance.now() - startedAt),
        outcome:
          options.signal?.aborted || isAbortError(error)
            ? "cancelled"
            : "failed",
      });
      throw error;
    }
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
      planRewrites:
        state.counters.planRewrites + (pending.planToolId ? 1 : 0),
    },
  };
  await options.checkpointStore.save(next);
  options.events?.emit({
    type: "plan_committed",
    plan: next.plan,
  });
  return next;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    error instanceof Error && error.name === "AbortError"
  );
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
  const [firstCall, secondCall] = calls;
  if (!firstCall) {
    throw new ProductionTurnProtocolError(
      "A turn must contain a tool call.",
    );
  }

  if (firstCall.name !== "rewrite_plan") {
    if (
      calls.length !== 1 ||
      state.plan.length === 0
    ) {
      throw new ProductionTurnProtocolError(
        "An action-only turn requires a committed incomplete plan.",
      );
    }
    let request: ModelToolRequest;
    try {
      request = validateToolCall({
        name: firstCall.name,
        input: firstCall.input,
      });
    } catch (error) {
      throw new ProductionTurnProtocolError(
        error instanceof Error ? error.message : "Invalid repository action.",
      );
    }
    return {
      assistantContent: content,
      plan: state.plan,
      planToolId: null,
      action: {
        toolUseId: firstCall.id,
        operationId: crypto.randomUUID(),
        request,
      },
    };
  }

  const planCall = firstCall;
  const actionCall = secondCall;
  if (actionCall?.name === "rewrite_plan") {
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
  if (complete && actionCall) {
    throw new ProductionTurnProtocolError(
      "A completed plan must not include a repository action.",
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
  validatePlanShape(plan);
  const completed = countCompleted(plan);
  if (state.plan.length === 0) {
    if (completed === plan.length) {
      throw new ProductionTurnProtocolError(
        "The initial plan must contain an in-progress task.",
      );
    }
    return;
  }
  const previousCompleted = countCompleted(state.plan);
  if (
    completed > previousCompleted &&
    state.lastToolSucceeded !== true
  ) {
    throw new ProductionTurnProtocolError(
      "Plan completion may advance only after a successful action.",
    );
  }
}

function validatePlanShape(plan: TodoItem[]): void {
  const ids = new Set(plan.map((task) => task.id));
  if (ids.size !== plan.length) {
    throw new ProductionTurnProtocolError("Plan task IDs must be unique.");
  }
  const completed = countCompleted(plan);
  const statuses = plan.map((task) => task.status);
  if (
    completed !== plan.length &&
    !statuses.includes("in_progress")
  ) {
    throw new ProductionTurnProtocolError(
      "An incomplete plan must contain an in_progress task.",
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
  if (state.plan.length > 0) {
    validatePlanShape(state.plan);
  }
  if (state.lifecycle !== "running" && state.pendingTurn) {
    throw new ProductionTurnProtocolError(
      "A terminal checkpoint cannot contain a pending turn.",
    );
  }
  if (
    (state.lifecycle === "failed") !== Boolean(state.terminalError)
  ) {
    throw new ProductionTurnProtocolError(
      "Checkpoint lifecycle and terminal error disagree.",
    );
  }
  const [firstMessage] = state.transcript;
  if (
    !firstMessage ||
    firstMessage.role !== "user" ||
    firstMessage.content !== initialPrompt(state.task)
  ) {
    throw new ProductionTurnProtocolError(
      "Checkpoint does not contain the canonical initial task prompt.",
    );
  }
  validateRecoveredTranscript(state);
  const terminalAttempt = state.lifecycle === "failed" ? 1 : 0;
  const pendingAttempt = state.pendingTurn ? 1 : 0;
  if (
    state.counters.modelTurns !==
      state.counters.committedTurns +
        state.counters.protocolRetries +
        terminalAttempt +
        pendingAttempt ||
    state.counters.toolCalls > state.counters.committedTurns ||
    state.counters.planRewrites > state.counters.committedTurns
  ) {
    throw new ProductionTurnProtocolError(
      "Checkpoint turn counters are inconsistent.",
    );
  }
  if (
    (state.lastToolResult === null) !==
      (state.lastToolSucceeded === null) ||
    (state.lastToolResult &&
      state.lastToolResult.success !== state.lastToolSucceeded)
  ) {
    throw new ProductionTurnProtocolError(
      "Checkpoint tool observation fields disagree.",
    );
  }
  const finalMessage = state.transcript.at(-1);
  const endsWithCorrection =
    finalMessage?.role === "user" &&
    typeof finalMessage.content === "string" &&
    finalMessage.content.startsWith(
      "The previous response was rejected without executing tools:",
    );
  if ((state.consecutiveInvalidAttempts === 1) !== endsWithCorrection) {
    throw new ProductionTurnProtocolError(
      "Checkpoint protocol-retry state and transcript disagree.",
    );
  }
  if (state.pendingTurn) {
    validateRecoveredPendingTurn(state);
  }
}

function validateRecoveredTranscript(state: ProductionAgentState): void {
  let historicalPlan: TodoItem[] = [];
  let historicalToolSucceeded: boolean | null = null;
  let historicalToolResult: ProductionAgentState["lastToolResult"] = null;
  let committedTurns = 0;
  let protocolRetries = 0;
  let toolCalls = 0;
  let planRewrites = 0;

  for (let index = 1; index < state.transcript.length; index += 1) {
    const message = state.transcript[index];
    if (!message) {
      throw new ProductionTurnProtocolError(
        "Checkpoint transcript contains a missing message.",
      );
    }
    if (message.role === "user" && typeof message.content === "string") {
      if (
        !message.content.startsWith(
          "The previous response was rejected without executing tools:",
        )
      ) {
        throw new ProductionTurnProtocolError(
          "Checkpoint transcript contains an unknown correction.",
        );
      }
      protocolRetries += 1;
      continue;
    }
    if (message.role !== "assistant") {
      throw new ProductionTurnProtocolError(
        "Checkpoint tool results lack a preceding assistant turn.",
      );
    }
    const resultMessage = state.transcript[index + 1];
    if (
      !resultMessage ||
      resultMessage.role !== "user" ||
      !Array.isArray(resultMessage.content)
    ) {
      throw new ProductionTurnProtocolError(
        "Checkpoint assistant turn lacks correlated tool results.",
      );
    }

    const historicalState: ProductionAgentState = {
      ...state,
      lifecycle: "running",
      plan: historicalPlan,
      lastToolSucceeded: historicalToolSucceeded,
      lastToolResult: historicalToolResult,
      pendingTurn: null,
      terminalError: null,
    };
    const validated = validateProductionTurn(
      message.content,
      "tool_use",
      historicalState,
    );
    const calls = message.content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use",
    );
    const results = resultMessage.content.filter(
      (block): block is ToolResultBlock => block.type === "tool_result",
    );
    if (
      results.length !== resultMessage.content.length ||
      results.length !== calls.length ||
      calls.some(
        (call, callIndex) => results[callIndex]?.toolUseId !== call.id,
      )
    ) {
      throw new ProductionTurnProtocolError(
        "Checkpoint tool calls and results are not exactly correlated.",
      );
    }

    let resultIndex = 0;
    if (validated.planToolId) {
      const planResult = results[resultIndex++];
      if (
        !planResult ||
        planResult.isError === true ||
        !isAcceptedPlanResult(planResult.content)
      ) {
        throw new ProductionTurnProtocolError(
          "Checkpoint plan rewrite lacks its accepted result.",
        );
      }
      planRewrites += 1;
    }

    historicalToolSucceeded = null;
    historicalToolResult = null;
    if (validated.action) {
      const actionResult = results[resultIndex];
      if (!actionResult) {
        throw new ProductionTurnProtocolError(
          "Checkpoint action lacks its terminal result.",
        );
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(actionResult.content);
      } catch {
        throw new ProductionTurnProtocolError(
          "Checkpoint action result is not valid JSON.",
        );
      }
      const parsed = toolResultWireSchema.safeParse(decoded);
      if (
        !parsed.success ||
        Boolean(actionResult.isError) !== !parsed.data.success
      ) {
        throw new ProductionTurnProtocolError(
          "Checkpoint action result is invalid or contradictory.",
        );
      }
      historicalToolResult = parsed.data;
      historicalToolSucceeded = parsed.data.success;
      toolCalls += 1;
    }

    historicalPlan = validated.plan;
    committedTurns += 1;
    index += 1;
  }

  if (
    committedTurns !== state.counters.committedTurns ||
    protocolRetries !== state.counters.protocolRetries ||
    toolCalls !== state.counters.toolCalls ||
    planRewrites !== state.counters.planRewrites ||
    JSON.stringify(historicalPlan) !== JSON.stringify(state.plan) ||
    historicalToolSucceeded !== state.lastToolSucceeded ||
    JSON.stringify(historicalToolResult) !==
      JSON.stringify(state.lastToolResult)
  ) {
    throw new ProductionTurnProtocolError(
      "Checkpoint transcript does not match its committed state.",
    );
  }
}

function isAcceptedPlanResult(content: string): boolean {
  try {
    const decoded: unknown = JSON.parse(content);
    return (
      typeof decoded === "object" &&
      decoded !== null &&
      !Array.isArray(decoded) &&
      Object.keys(decoded).length === 1 &&
      "accepted" in decoded &&
      decoded.accepted === true
    );
  } catch {
    return false;
  }
}

function validateRecoveredPendingTurn(state: ProductionAgentState): void {
  const pending = state.pendingTurn!;
  const validated = validateProductionTurn(
    pending.assistantContent,
    "tool_use",
    { ...state, pendingTurn: null },
  );
  const sameAction =
    pending.action === null && validated.action === null
      ? true
      : Boolean(
          pending.action &&
            validated.action &&
            pending.action.toolUseId === validated.action.toolUseId &&
            JSON.stringify(pending.action.request) ===
              JSON.stringify(validated.action.request),
        );
  if (
    pending.planToolId !== validated.planToolId ||
    JSON.stringify(pending.plan) !== JSON.stringify(validated.plan) ||
    !sameAction
  ) {
    throw new ProductionTurnProtocolError(
      "Checkpoint pending turn does not match its validated assistant content.",
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
  return plan.filter((task) => task.status === "completed").length;
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
