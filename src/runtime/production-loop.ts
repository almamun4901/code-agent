import type {
  AssistantBlock,
  CallModel,
  ConversationMessage,
  ModelRequest,
  ModelToolDefinition,
  ModelRuntime,
  ModelTurn,
  ToolResultBlock,
  ToolUseBlock,
} from "../model/contracts";
import {
  catalogCostMicroUsd,
  createInjectedModelRuntime,
  pricingFor,
} from "../model/runtime";
import {
  TodoWriteInputSchema,
  type TodoItem,
} from "../plan/schema";
import type { E2bTaskSession } from "../sandbox/e2b-session";
import type { MutationRecord } from "../tools/mutation-journal";
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
import {
  CompactionSummarySchema,
  DEFAULT_BUDGET_LIMITS,
  type CompactionSummary,
  type BudgetLimits,
} from "./schema";
import {
  LifecycleHookError,
  LifecycleHooks,
  type LifecycleBudgetSnapshot,
} from "./lifecycle";

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
  callModel?: CallModel;
  modelRuntime?: ModelRuntime;
  session: Pick<E2bTaskSession, "call">;
  checkpointStore: ProductionCheckpointStore;
  maxModelTurns?: number;
  signal?: AbortSignal;
  events?: AgentEventPublisher;
  now?: () => number;
  hooks?: LifecycleHooks;
  budgetLimits?: Partial<BudgetLimits>;
};

export class ProductionTurnProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionTurnProtocolError";
  }
}

export class ProductionLoopLimitError extends Error {
  readonly code: string;
  constructor(message: string, code = "MODEL_CALL_LIMIT") {
    super(message);
    this.name = "ProductionLoopLimitError";
    this.code = code;
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
  const runtime = options.modelRuntime ?? (options.callModel
    ? createInjectedModelRuntime(options.callModel)
    : undefined);
  if (!runtime) {
    throw new ProductionTurnProtocolError("A model runtime is required.");
  }
  const configuredLimits = {
    ...DEFAULT_BUDGET_LIMITS,
    ...(options.budgetLimits ?? {}),
    ...(options.maxModelTurns === undefined
      ? {}
      : { maxModelCalls: options.maxModelTurns }),
  };
  const pricing = pricingFor(runtime.identity);
  let state = await initializeState(options, configuredLimits, pricing);
  validateRecoveredState(state, options);
  options.events?.emit({
    type: "state_loaded",
    lifecycle: state.lifecycle,
    plan: state.plan,
    usage: usageFromCounters(state.counters, state),
  });

  if (state.lifecycle === "failed") {
    throw new ProductionTurnProtocolError(
      state.terminalError ?? "Checkpoint contains a failed run.",
    );
  }
  if (state.lifecycle === "completed") return toResult(state);
  assertRuntimeMatchesPricing(state, runtime);

  while (state.lifecycle === "running") {
    throwIfAborted(options.signal);

    if (state.pendingTurn) {
      state = await commitPendingTurn(state, state.pendingTurn, options);
      continue;
    }
    state = await recoverAmbiguousCall(state, options);
    state = await recoverPersistedCompaction(state, runtime, options);
    const compacted = await maybeCompact(state, runtime, options);
    state = compacted;
    const paid = state.pendingModelCall?.response
      ? { state, turn: responseToTurn(state.pendingModelCall.response) }
      : await reserveAndCall(state, createModelRequest(state), "agent", runtime, options);
    state = paid.state;
    const turn = paid.turn;
    const countersAfterModel = state.counters;

    if (!sameIdentity(turn.actualIdentity, state.pricing.identity)) {
      state = await failState(
        state,
        "MODEL_PRICING_MISMATCH",
        "Provider routed the request to a model without the persisted pricing identity.",
        options,
      );
      throw new ProductionLoopLimitError(state.terminalError!, "MODEL_PRICING_MISMATCH");
    }

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
          terminalCode: "MODEL_PROTOCOL_FAILED",
          counters: countersAfterModel,
          pendingModelCall: null,
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
        pendingModelCall: null,
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
      continue;
    }

    state = {
      ...state,
      counters: countersAfterModel,
      pendingTurn,
      pendingModelCall: null,
    };
    await options.checkpointStore.save(state);
  }

  return toResult(state);
}

export async function prepareProductionLifecycle(options: {
  canonicalRepoPath: string;
  task: string;
  runIdentity: string;
  checkpointStore: ProductionCheckpointStore;
  modelRuntime: ModelRuntime;
  hooks?: LifecycleHooks;
  budgetLimits?: Partial<BudgetLimits>;
  onSessionStart?: () => void;
}): Promise<ProductionAgentState> {
  const existing = await options.checkpointStore.load();
  const limits = { ...DEFAULT_BUDGET_LIMITS, ...(options.budgetLimits ?? {}) };
  const pricing = existing?.pricing ?? pricingFor(options.modelRuntime.identity);
  let state = existing ?? createBootstrapState(options, limits, pricing);
  if (state.lifecycle === "running") {
    assertRuntimeMatchesPricing(state, options.modelRuntime);
  }
  if (!existing) await options.checkpointStore.save(state);
  if (options.hooks) {
    options.onSessionStart?.();
    try {
      await options.hooks.runGating("SessionStart", {
        mode: existing ? "resumed" : "fresh",
        runIdentity: state.runIdentity,
        lifecycle: state.lifecycle,
        plan: state.plan,
        budget: budgetSnapshot(state),
      });
    } catch (error) {
      if (existing && existing.lifecycle !== "running") throw error;
      state = {
        ...state,
        lifecycle: "failed",
        terminalCode: error instanceof LifecycleHookError ? error.code : "HOOK_FAILED",
        terminalError: error instanceof Error ? error.message : "SessionStart failed.",
      };
      await options.checkpointStore.save(state);
      throw error;
    }
  }
  if (state.promptStatus === "pending") {
    try {
      const promptResult = options.hooks
        ? await options.hooks.runGating("UserPromptSubmit", { runIdentity: state.runIdentity, task: state.task })
        : { appendedContext: "" };
      state = {
        ...state,
        promptStatus: "accepted",
        appendedPromptContext: promptResult.appendedContext,
        transcript: [{ role: "user", content: initialPrompt(state.task, promptResult.appendedContext) }],
      };
      await options.checkpointStore.save(state);
    } catch (error) {
      state = {
        ...state,
        promptStatus: "denied",
        lifecycle: "failed",
        terminalCode: error instanceof LifecycleHookError ? error.code : "HOOK_FAILED",
        terminalError: error instanceof Error ? error.message : "UserPromptSubmit failed.",
      };
      await options.checkpointStore.save(state);
      throw error;
    }
  }
  return state;
}

export async function commitReconciledProductionMutation(options: {
  checkpointStore: ProductionCheckpointStore;
  mutation: MutationRecord;
  hooks?: LifecycleHooks;
  events?: AgentEventPublisher;
}): Promise<boolean> {
  const state = await options.checkpointStore.load();
  if (
    !state ||
    state.lifecycle !== "running" ||
    !state.pendingTurn?.action ||
    state.pendingTurn.action.operationId !== options.mutation.operationId ||
    options.mutation.status !== "completed" ||
    !options.mutation.result
  ) {
    return false;
  }
  await commitPendingTurn(state, state.pendingTurn, {
    canonicalRepoPath: state.canonicalRepoPath,
    task: state.task,
    runIdentity: state.runIdentity,
    session: { async call() { return options.mutation.result!; } },
    checkpointStore: options.checkpointStore,
    hooks: options.hooks,
    events: options.events,
  });
  return true;
}

function createBootstrapState(
  options: { canonicalRepoPath: string; task: string; runIdentity: string },
  limits: ProductionAgentState["limits"],
  pricing: ProductionAgentState["pricing"],
): ProductionAgentState {
  return {
    version: 3,
    runIdentity: options.runIdentity,
    canonicalRepoPath: options.canonicalRepoPath,
    task: options.task,
    promptStatus: "pending",
    appendedPromptContext: "",
    lifecycle: "running",
    plan: [],
    transcript: [],
    lastToolSucceeded: null,
    pendingTurn: null,
    pendingModelCall: null,
    limits,
    pricing,
    context: { lastEstimateTokens: 0, estimateSource: null, requestFingerprint: null },
    cost: { projectedMicroUsd: 0, observedMicroUsd: 0, observedAvailable: false, driftMicroUsd: 0 },
    compaction: { count: 0, lastPreTokens: 0, lastPostTokens: 0, baselineCommittedTurns: 0, baselineProtocolRetries: 0, baselineToolCalls: 0, baselinePlanRewrites: 0, baselineStopRejections: 0 },
    notificationKeys: [],
    lastNotification: null,
    counters: { modelTurns: 0, modelCalls: 0, agentCalls: 0, compactionCalls: 0, stopRejections: 0, committedTurns: 0, protocolRetries: 0, toolCalls: 0, planRewrites: 0, inputTokens: 0, outputTokens: 0 },
    consecutiveInvalidAttempts: 0,
    terminalCode: null,
    terminalError: null,
    lastToolResult: null,
  };
}

async function reserveAndCall(
  state: ProductionAgentState,
  request: ModelRequest,
  kind: "agent" | "compaction",
  runtime: ModelRuntime,
  options: ProductionLoopOptions,
): Promise<{ state: ProductionAgentState; turn: ModelTurn }> {
  throwIfAborted(options.signal);
  if (state.counters.modelCalls >= state.limits.maxModelCalls) {
    const failed = await failState(state, "MODEL_CALL_LIMIT", `Maximum paid model-call limit of ${state.limits.maxModelCalls} reached.`, options);
    throw new ProductionLoopLimitError(failed.terminalError!, "MODEL_CALL_LIMIT");
  }
  const estimate = await runtime.countRequestTokens(request, options.signal);
  if (!Number.isInteger(estimate.tokens) || estimate.tokens < 0) {
    throw new ProductionTurnProtocolError("Model runtime returned an invalid context-token estimate.");
  }
  if (estimate.tokens > state.limits.maxContextTokens) {
    const failed = await failState(state, "CONTEXT_BUDGET_EXCEEDED", `Next model request is ${estimate.tokens} tokens; limit is ${state.limits.maxContextTokens}.`, options);
    throw new ProductionLoopLimitError(failed.terminalError!, "CONTEXT_BUDGET_EXCEEDED");
  }
  const reservation = catalogCostMicroUsd(estimate.tokens, request.maxTokens, state.pricing);
  if (state.cost.projectedMicroUsd + reservation > state.limits.maxProjectedCostMicroUsd) {
    const failed = await failState(state, "COST_BUDGET_EXCEEDED", "Next model request would exceed the projected $5.00 task ceiling.", options);
    throw new ProductionLoopLimitError(failed.terminalError!, "COST_BUDGET_EXCEEDED");
  }
  const pending = {
    id: crypto.randomUUID(),
    requestDigest: await sha256Text(JSON.stringify(request)),
    kind,
    inputEstimate: estimate.tokens,
    maxOutputTokens: request.maxTokens,
    reservedCostMicroUsd: reservation,
    ...(kind === "compaction" ? {
      sourceTranscriptDigest: await sha256Text(JSON.stringify(state.transcript)),
      sourceContextTokens: state.context.lastEstimateTokens,
    } : {}),
    response: null,
  };
  state = {
    ...state,
    context: {
      lastEstimateTokens: estimate.tokens,
      estimateSource: estimate.source,
      requestFingerprint: estimate.fingerprint ?? null,
    },
    cost: {
      ...state.cost,
      projectedMicroUsd: state.cost.projectedMicroUsd + reservation,
    },
    pendingModelCall: pending,
  };
  await options.checkpointStore.save(state);

  let turn: ModelTurn;
  try {
    turn = await runtime.call(request, options.signal ? { signal: options.signal } : undefined);
  } catch (error) {
    // The persisted reservation deliberately remains ambiguous across provider errors.
    throw error;
  }
  const actualIdentity = turn.actualIdentity ?? runtime.identity;
  const normalized = { ...turn, actualIdentity };
  const projectedActual = catalogCostMicroUsd(turn.usage.inputTokens, turn.usage.outputTokens, state.pricing);
  const observed = turn.providerCostMicroUsd;
  const callCounters = kind === "agent"
    ? { agentCalls: state.counters.agentCalls + 1, compactionCalls: state.counters.compactionCalls }
    : { agentCalls: state.counters.agentCalls, compactionCalls: state.counters.compactionCalls + 1 };
  const modelCalls = callCounters.agentCalls + callCounters.compactionCalls;
  state = {
    ...state,
    counters: {
      ...state.counters,
      ...callCounters,
      modelCalls,
      modelTurns: modelCalls,
      inputTokens: state.counters.inputTokens + turn.usage.inputTokens,
      outputTokens: state.counters.outputTokens + turn.usage.outputTokens,
    },
    cost: {
      projectedMicroUsd: state.cost.projectedMicroUsd - reservation + projectedActual,
      observedMicroUsd: state.cost.observedMicroUsd + (observed ?? 0),
      observedAvailable: state.cost.observedAvailable || observed !== undefined,
      driftMicroUsd: state.cost.driftMicroUsd + (observed === undefined ? 0 : observed - projectedActual),
    },
    pendingModelCall: {
      ...pending,
      response: {
        content: normalized.content,
        stopReason: normalized.stopReason,
        usage: normalized.usage,
        actualIdentity,
        ...(observed === undefined ? {} : { providerCostMicroUsd: observed }),
      },
    },
  };
  await options.checkpointStore.save(state);
  options.events?.emit({ type: "usage_updated", usage: usageFromCounters(state.counters, state) });
  state = await maybeWarnBudgets(state, options);
  return { state, turn: normalized };
}

async function maybeWarnBudgets(state: ProductionAgentState, options: ProductionLoopOptions): Promise<ProductionAgentState> {
  if (state.counters.modelCalls * 5 >= state.limits.maxModelCalls * 4) {
    state = await recordNotification(state, "MODEL_CALLS_80", options, {
      kind: "budget", code: "MODEL_CALLS_80", title: "Model-call budget warning",
      message: `Used ${state.counters.modelCalls} of ${state.limits.maxModelCalls} paid model calls.`,
    });
  }
  if (state.cost.projectedMicroUsd * 5 >= state.limits.maxProjectedCostMicroUsd * 4) {
    state = await recordNotification(state, "PROJECTED_COST_80", options, {
      kind: "budget", code: "PROJECTED_COST_80", title: "Projected-cost warning",
      message: "Projected task cost reached at least 80% of its ceiling.",
    });
  }
  if (state.cost.observedAvailable && state.cost.driftMicroUsd !== 0) {
    state = await recordNotification(state, "COST_LEDGER_DRIFT", options, {
      kind: "warning", code: "COST_LEDGER_DRIFT", title: "Provider cost differs",
      message: "Provider-reported cost differs from the checked-in pricing ledger.",
    });
  }
  return state;
}

async function recoverAmbiguousCall(
  state: ProductionAgentState,
  options: ProductionLoopOptions,
): Promise<ProductionAgentState> {
  if (!state.pendingModelCall || state.pendingModelCall.response) return state;
  const counters = state.pendingModelCall.kind === "agent"
    ? { agentCalls: state.counters.agentCalls + 1, compactionCalls: state.counters.compactionCalls }
    : { agentCalls: state.counters.agentCalls, compactionCalls: state.counters.compactionCalls + 1 };
  const modelCalls = counters.agentCalls + counters.compactionCalls;
  state = {
    ...state,
    lifecycle: "failed",
    terminalCode: "AMBIGUOUS_MODEL_CALL",
    terminalError: "A paid model call may have completed without a durable response; it will not be replayed.",
    pendingModelCall: null,
    counters: { ...state.counters, ...counters, modelCalls, modelTurns: modelCalls },
  };
  await options.checkpointStore.save(state);
  throw new ProductionLoopLimitError(state.terminalError!, "AMBIGUOUS_MODEL_CALL");
}

async function maybeCompact(
  state: ProductionAgentState,
  runtime: ModelRuntime,
  options: ProductionLoopOptions,
): Promise<ProductionAgentState> {
  if (state.pendingModelCall?.response) return state;
  const request = createModelRequest(state);
  const estimate = await runtime.countRequestTokens(request, options.signal);
  const checkpointBytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (estimate.tokens < state.limits.compactAtTokens && checkpointBytes < state.limits.compactAtCheckpointBytes) {
    return state;
  }
  if (state.counters.modelCalls + 2 > state.limits.maxModelCalls) {
    const failed = await failState(state, "MODEL_CALL_LIMIT", "Compaction requires two remaining paid model calls.", options);
    throw new ProductionLoopLimitError(failed.terminalError!, "MODEL_CALL_LIMIT");
  }
  let hookContext: { appendedContext: string };
  try {
    hookContext = options.hooks
      ? await options.hooks.runGating("PreCompact", {
          runIdentity: state.runIdentity,
          contextTokens: estimate.tokens,
          checkpointBytes,
          compactionNumber: state.compaction.count + 1,
        })
      : { appendedContext: "" };
  } catch (error) {
    await failState(
      state,
      error instanceof LifecycleHookError ? error.code : "HOOK_FAILED",
      error instanceof Error ? error.message : "PreCompact failed.",
      options,
    );
    throw error;
  }
  state = await recordNotification(state, undefined, options, {
    kind: "compaction",
    code: "COMPACTION_STARTED",
    title: "Compaction started",
    message: `Compacting request context at ${estimate.tokens} tokens.`,
  });
  state = {
    ...state,
    context: {
      lastEstimateTokens: estimate.tokens,
      estimateSource: estimate.source,
      requestFingerprint: estimate.fingerprint ?? null,
    },
  };
  const summaryRequest = createSummaryRequest(state, hookContext.appendedContext);
  const paid = await reserveAndCall(state, summaryRequest, "compaction", runtime, options);
  state = paid.state;
  return installCompactionResponse(state, runtime, options, paid.turn);
}

async function recoverPersistedCompaction(
  state: ProductionAgentState,
  runtime: ModelRuntime,
  options: ProductionLoopOptions,
): Promise<ProductionAgentState> {
  if (state.pendingModelCall?.kind !== "compaction" || !state.pendingModelCall.response) return state;
  return installCompactionResponse(state, runtime, options, responseToTurn(state.pendingModelCall.response));
}

async function installCompactionResponse(
  state: ProductionAgentState,
  runtime: ModelRuntime,
  options: ProductionLoopOptions,
  turn: ModelTurn,
): Promise<ProductionAgentState> {
  const pending = state.pendingModelCall;
  if (!pending || pending.kind !== "compaction" || !pending.response) {
    throw new ProductionTurnProtocolError("Compaction response was not staged.");
  }
  let summary: CompactionSummary;
  try {
    summary = pending.response.summary ?? parseCompactionSummary(turn);
  } catch (error) {
    await failState(
      state,
      "COMPACTION_INVALID",
      error instanceof Error ? error.message : "Compaction summary was invalid.",
      options,
    );
    throw error;
  }
  if (!state.pendingModelCall?.response) throw new ProductionTurnProtocolError("Compaction response was not staged.");
  state = {
    ...state,
    pendingModelCall: {
      ...state.pendingModelCall,
      response: { ...state.pendingModelCall.response, summary },
    },
  };
  await options.checkpointStore.save(state);
  const transcript = compactedTranscript(state, summary);
  const candidate = { ...state, transcript };
  const post = await runtime.countRequestTokens(createModelRequest(candidate), options.signal);
  if (post.tokens >= state.limits.compactAtTokens) {
    const failed = await failState(state, "COMPACTION_INEFFECTIVE", "Compacted context did not fall below the configured compaction threshold.", options);
    throw new ProductionLoopLimitError(failed.terminalError!, "COMPACTION_INEFFECTIVE");
  }
  state = {
    ...candidate,
    pendingModelCall: null,
    context: { lastEstimateTokens: post.tokens, estimateSource: post.source, requestFingerprint: post.fingerprint ?? null },
    compaction: {
      count: state.compaction.count + 1,
      lastPreTokens: pending.sourceContextTokens ?? pending.inputEstimate,
      lastPostTokens: post.tokens,
      baselineCommittedTurns: state.counters.committedTurns,
      baselineProtocolRetries: state.counters.protocolRetries,
      baselineToolCalls: state.counters.toolCalls,
      baselinePlanRewrites: state.counters.planRewrites,
      baselineStopRejections: state.counters.stopRejections,
    },
  };
  await options.checkpointStore.save(state);
  state = await recordNotification(state, undefined, options, {
    kind: "compaction",
    code: "COMPACTION_COMPLETED",
    title: "Compaction completed",
    message: `Context reduced from ${pending.sourceContextTokens ?? pending.inputEstimate} to ${post.tokens} tokens.`,
  });
  return state;
}

function createSummaryRequest(state: ProductionAgentState, extra: string): ModelRequest {
  return {
    mode: "summary",
    system: [
      "Summarize the coding-agent session as one strict JSON object.",
      "Use version 1 and arrays discoveries, decisions, changedFiles, verification, failures, unresolved.",
      "Return JSON only. Each array has at most 50 strings.",
      extra ? `Additional lifecycle instructions:\n${extra}` : "",
    ].filter(Boolean).join("\n"),
    messages: state.transcript,
    tools: [],
    maxTokens: 4_096,
  };
}

function parseCompactionSummary(turn: ModelTurn): CompactionSummary {
  if (turn.stopReason !== "end_turn") throw new ProductionTurnProtocolError("Compaction must end without tool use.");
  const text = turn.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { throw new ProductionTurnProtocolError("Compaction returned invalid JSON."); }
  const parsed = CompactionSummarySchema.safeParse(decoded);
  if (!parsed.success) throw new ProductionTurnProtocolError("Compaction returned an invalid bounded summary.");
  return parsed.data;
}

function compactedTranscript(state: ProductionAgentState, summary: CompactionSummary): ConversationMessage[] {
  return [
    { role: "user", content: initialPrompt(state.task, state.appendedPromptContext) },
    {
      role: "user",
      content: [
        `Compaction ${state.compaction.count + 1}`,
        `Summary: ${JSON.stringify(summary)}`,
        `Current plan: ${JSON.stringify(state.plan)}`,
        `Last terminal tool result: ${JSON.stringify(state.lastToolResult)}`,
      ].join("\n"),
    },
  ];
}

function responseToTurn(response: NonNullable<ProductionAgentState["pendingModelCall"]>["response"] & {}): ModelTurn {
  return {
    content: response.content,
    stopReason: response.stopReason as ModelTurn["stopReason"],
    usage: response.usage,
    actualIdentity: response.actualIdentity,
    ...(response.providerCostMicroUsd === undefined ? {} : { providerCostMicroUsd: response.providerCostMicroUsd }),
  };
}

async function failState(state: ProductionAgentState, code: string, message: string, options: ProductionLoopOptions): Promise<ProductionAgentState> {
  const failed = { ...state, lifecycle: "failed" as const, terminalCode: code, terminalError: message, pendingTurn: null };
  await options.checkpointStore.save(failed);
  return recordNotification(failed, `TERMINAL_${code}`, options, { kind: "budget", code, title: "Run stopped", message });
}

async function recordNotification(
  state: ProductionAgentState,
  dedupKey: string | undefined,
  options: ProductionLoopOptions,
  context: { kind: "budget" | "compaction" | "lifecycle" | "warning"; code: string; title: string; message: string },
): Promise<ProductionAgentState> {
  if (dedupKey && state.notificationKeys.includes(dedupKey)) return state;
  const next: ProductionAgentState = {
    ...state,
    notificationKeys: dedupKey ? [...state.notificationKeys, dedupKey].slice(-16) : state.notificationKeys,
    lastNotification: { code: context.code, message: context.message.slice(0, 2_048) },
  };
  await options.checkpointStore.save(next);
  await notify(next, options, context);
  return next;
}

async function notify(state: ProductionAgentState, options: ProductionLoopOptions, context: {
  kind: "budget" | "compaction" | "lifecycle" | "warning";
  code: string;
  title: string;
  message: string;
}): Promise<void> {
  if (options.hooks) {
    const warnings = await options.hooks.runObservers("Notification", context as never);
    for (const warning of warnings) {
      options.events?.emit({
        type: "notification",
        notification: {
          kind: "warning",
          code: warning.code,
          title: `${warning.hook} warning`,
          message: warning.message,
        },
      });
    }
  }
  options.events?.emit({ type: "notification", notification: context });
}

function sameIdentity(actual: ModelTurn["actualIdentity"], expected: ProductionAgentState["pricing"]["identity"]): boolean {
  return Boolean(actual && actual.provider === expected.provider && actual.model === expected.model);
}

function assertRuntimeMatchesPricing(state: ProductionAgentState, runtime: ModelRuntime): void {
  if (!sameIdentity(runtime.identity, state.pricing.identity)) {
    throw new ProductionTurnProtocolError(
      `Checkpoint pricing identity ${state.pricing.identity.provider}:${state.pricing.identity.model} does not match runtime ${runtime.identity.provider}:${runtime.identity.model}.`,
    );
  }
}

function budgetSnapshot(state: ProductionAgentState): LifecycleBudgetSnapshot {
  return {
    modelCalls: state.counters.modelCalls,
    maxModelCalls: state.limits.maxModelCalls,
    contextTokens: state.context.lastEstimateTokens,
    maxContextTokens: state.limits.maxContextTokens,
    projectedCostMicroUsd: state.cost.projectedMicroUsd,
    maxProjectedCostMicroUsd: state.limits.maxProjectedCostMicroUsd,
    compactions: state.compaction.count,
  };
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  let toolDurationMs = 0;
  let postToolSummary = "repository action";
  let postToolName: ModelToolRequest["name"] | null = null;

  if (pending.action) {
    throwIfAborted(options.signal);
    const request = validateToolCall(pending.action.request);
    postToolName = request.name;
    postToolSummary = safeToolSummary(request);
    const now = options.now ?? (() => performance.now());
    const startedAt = now();
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
      toolDurationMs = Math.max(0, now() - startedAt);
      options.events?.emit({
        type: "tool_finished",
        operationId: pending.action.operationId,
        durationMs: toolDurationMs,
        outcome: toolOutcome(rawResult),
      });
    } catch (error) {
      const outcome = options.signal?.aborted || isAbortError(error) ? "cancelled" : "failed";
      options.events?.emit({
        type: "tool_finished",
        operationId: pending.action.operationId,
        durationMs: Math.max(0, now() - startedAt),
        outcome,
      });
      if (options.hooks && outcome !== "cancelled") {
        await options.hooks.runObservers("PostToolUse", {
          operationId: pending.action.operationId,
          toolName: request.name,
          summary: safeToolSummary(request),
          durationMs: Math.max(0, now() - startedAt),
          outcome,
        });
      }
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
  if (completed && options.hooks) {
    try {
      await options.hooks.runGating("Stop", {
        runIdentity: state.runIdentity,
        proposedPlan: pending.plan,
        budget: budgetSnapshot(state),
      });
    } catch (error) {
      if (error instanceof LifecycleHookError && !error.code.startsWith("HOOK_")) {
        const rejected: ProductionAgentState = {
          ...state,
          lifecycle: "running",
          transcript: [
            ...state.transcript,
            { role: "assistant", content: pending.assistantContent },
            { role: "user", content: [{ type: "tool_result", toolUseId: pending.planToolId!, content: JSON.stringify({ accepted: false, code: error.code, reason: error.message }), isError: true }] },
          ],
          pendingTurn: null,
          consecutiveInvalidAttempts: 0,
          counters: {
            ...state.counters,
            committedTurns: state.counters.committedTurns + 1,
            stopRejections: state.counters.stopRejections + 1,
          },
        };
        await options.checkpointStore.save(rejected);
        await notify(rejected, options, { kind: "lifecycle", code: "STOP_REJECTED", title: "Completion rejected", message: error.message });
        return rejected;
      }
      await failState(
        state,
        error instanceof LifecycleHookError ? error.code : "HOOK_FAILED",
        error instanceof Error ? error.message : "Stop hook failed.",
        options,
      );
      throw error;
    }
  }
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
  if (pending.action && postToolName && options.hooks) {
    const warnings = await options.hooks.runObservers("PostToolUse", {
      operationId: pending.action.operationId,
      toolName: postToolName,
      summary: postToolSummary,
      durationMs: toolDurationMs,
      outcome: lastToolResult ? toolOutcome(lastToolResult) : "failed",
    });
    for (const warning of warnings) {
      options.events?.emit({ type: "notification", notification: { kind: "warning", code: warning.code, title: `${warning.hook} warning`, message: warning.message } });
    }
  }
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

function initialPrompt(task: string, appendedContext = ""): string {
  return [
    "Complete the following repository task:",
    task,
    "",
    "First create a concrete plan, then perform one safe action per turn.",
    ...(appendedContext ? ["", "Lifecycle context:", appendedContext] : []),
  ].join("\n");
}

async function initializeState(
  options: ProductionLoopOptions,
  limits: ProductionAgentState["limits"],
  pricing: ReturnType<typeof pricingFor>,
): Promise<ProductionAgentState> {
  const existing = await options.checkpointStore.load();
  if (existing) return existing;
  const state: ProductionAgentState = {
    version: 3,
    runIdentity: options.runIdentity,
    canonicalRepoPath: options.canonicalRepoPath,
    task: options.task,
    promptStatus: "accepted",
    appendedPromptContext: "",
    lifecycle: "running",
    plan: [],
    transcript: [{ role: "user", content: initialPrompt(options.task) }],
    lastToolSucceeded: null,
    pendingTurn: null,
    pendingModelCall: null,
    limits,
    pricing,
    context: { lastEstimateTokens: 0, estimateSource: null, requestFingerprint: null },
    cost: { projectedMicroUsd: 0, observedMicroUsd: 0, observedAvailable: false, driftMicroUsd: 0 },
    compaction: { count: 0, lastPreTokens: 0, lastPostTokens: 0, baselineCommittedTurns: 0, baselineProtocolRetries: 0, baselineToolCalls: 0, baselinePlanRewrites: 0, baselineStopRejections: 0 },
    notificationKeys: [],
    lastNotification: null,
    counters: {
      modelTurns: 0,
      modelCalls: 0,
      agentCalls: 0,
      compactionCalls: 0,
      stopRejections: 0,
      committedTurns: 0,
      protocolRetries: 0,
      toolCalls: 0,
      planRewrites: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    consecutiveInvalidAttempts: 0,
    terminalError: null,
    terminalCode: null,
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
    (state.lifecycle === "completed" && !(state.plan.length > 0 && state.plan.every((task) => task.status === "completed"))) ||
    (state.lifecycle === "running" && state.plan.length > 0 && state.plan.every((task) => task.status === "completed"))
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
  if (state.promptStatus !== "accepted") {
    if (state.promptStatus === "denied" && state.lifecycle === "failed") return;
    throw new ProductionTurnProtocolError("Checkpoint prompt bootstrap is incomplete.");
  }
  const [firstMessage] = state.transcript;
  if (
    !firstMessage ||
    firstMessage.role !== "user" ||
    firstMessage.content !== initialPrompt(state.task, state.appendedPromptContext)
  ) {
    throw new ProductionTurnProtocolError(
      "Checkpoint does not contain the canonical initial task prompt.",
    );
  }
  validateRecoveredTranscript(state);
  if (
    state.counters.modelTurns !== state.counters.modelCalls ||
    state.counters.modelCalls !== state.counters.agentCalls + state.counters.compactionCalls ||
    state.counters.agentCalls < state.counters.committedTurns + state.counters.protocolRetries ||
    state.counters.agentCalls > state.counters.committedTurns + state.counters.protocolRetries + 1 ||
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
  let stopRejections = 0;

  for (let index = 1; index < state.transcript.length; index += 1) {
    const message = state.transcript[index];
    if (!message) {
      throw new ProductionTurnProtocolError(
        "Checkpoint transcript contains a missing message.",
      );
    }
    if (message.role === "user" && typeof message.content === "string") {
      if (message.content.startsWith("Checkpoint transcript omitted")) {
        continue;
      }
      if (message.content.startsWith("Compaction ")) {
        const compacted = parseCompactionTranscriptContext(message.content);
        historicalPlan = compacted.plan;
        historicalToolResult = compacted.lastToolResult;
        historicalToolSucceeded = compacted.lastToolResult?.success ?? null;
        committedTurns = state.compaction.baselineCommittedTurns;
        protocolRetries = state.compaction.baselineProtocolRetries;
        toolCalls = state.compaction.baselineToolCalls;
        planRewrites = state.compaction.baselinePlanRewrites;
        stopRejections = state.compaction.baselineStopRejections;
        continue;
      }
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
        planResult &&
        planResult.isError === true &&
        isRejectedStopResult(planResult.content) &&
        validated.action === null &&
        validated.plan.every((task) => task.status === "completed")
      ) {
        committedTurns += 1;
        stopRejections += 1;
        index += 1;
        continue;
      }
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
    stopRejections !== state.counters.stopRejections ||
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

function parseCompactionTranscriptContext(content: string): {
  plan: TodoItem[];
  lastToolResult: ProductionAgentState["lastToolResult"];
} {
  const planLine = content.split("\n").find((line) => line.startsWith("Current plan: "));
  const resultLine = content.split("\n").find((line) => line.startsWith("Last terminal tool result: "));
  if (!planLine || !resultLine) {
    throw new ProductionTurnProtocolError("Checkpoint compaction context is incomplete.");
  }
  try {
    const plan = TodoWriteInputSchema.shape.plan.parse(JSON.parse(planLine.slice("Current plan: ".length)));
    const resultValue: unknown = JSON.parse(resultLine.slice("Last terminal tool result: ".length));
    const lastToolResult = resultValue === null
      ? null
      : toolResultWireSchema.parse(resultValue);
    return { plan, lastToolResult };
  } catch {
    throw new ProductionTurnProtocolError("Checkpoint compaction context is invalid.");
  }
}

function isRejectedStopResult(content: string): boolean {
  try {
    const decoded: unknown = JSON.parse(content);
    return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded) &&
      Object.keys(decoded).every((key) => ["accepted", "code", "reason"].includes(key)) &&
      "accepted" in decoded && decoded.accepted === false &&
      "code" in decoded && typeof decoded.code === "string" &&
      "reason" in decoded && typeof decoded.reason === "string";
  } catch {
    return false;
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
