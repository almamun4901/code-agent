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
import { isMutatingToolCall } from "../tools/contracts";
import { validateToolCall } from "../tools/validate-call";
import { FileProductionCheckpointStore, type ProductionCheckpointStore } from "./checkpoint";
import {
  type AgentEventPublisher,
  type AgentEventInput,
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
  ScreenshotEvidenceSchema,
  type CompactionSummary,
  type BudgetLimits,
} from "./schema";
import {
  LifecycleHookError,
  LifecycleHooks,
  type LifecycleBudgetSnapshot,
} from "./lifecycle";
import { resultDeliveryReceiptDigest, revalidateResultDeliveryReceipt, type ResultDeliveryReceipt } from "../sandbox/result-delivery";
import {
  PlanProposalSchema,
  ApprovalDecisionSchema,
  createInitialApprovalState,
  proposalDigest,
  proposalExecutionPlan,
  protectedProposalDigest,
  verificationContractDigest,
  type ApprovalMode,
  type ApprovalState,
  type PlanProposal,
  type RequestPlanApproval,
} from "./approval";
import { EMPTY_AUDIT_DIGEST } from "./audit";
import {
  AuditCheckpointCoordinator,
  FileAuditJournal,
  MemoryAuditJournal,
  redactedDigest,
  type AuditJournal,
  type AuditRecord,
} from "./audit";
import { revalidateViewportEvidenceFiles } from "./evidence-files";

const MAX_PLAN_TASKS = 20;

export type ProductionLoopResult = {
  status: "finalizing" | "completed";
  modelTurns: number;
  acceptedTurns: number;
  protocolRetries: number;
  toolCalls: number;
  planRewrites: number;
  inputTokens: number;
  outputTokens: number;
  plan: TodoItem[];
  delivery?: ResultDeliveryReceipt;
  completion?: NonNullable<ProductionAgentState["completion"]>;
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
  approvalMode?: ApprovalMode;
  requestApproval?: RequestPlanApproval;
  auditJournal?: AuditJournal;
};

const memoryAuditJournals = new WeakMap<object, MemoryAuditJournal>();

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

export class PlanApprovalRequiredError extends Error {
  readonly code = "PLAN_APPROVAL_REQUIRED";
  constructor(readonly proposalDigest: string) {
    super("A durable plan proposal is awaiting approval.");
    this.name = "PlanApprovalRequiredError";
  }
}

export class PlanApprovalCancelledError extends Error {
  readonly code = "PLAN_CANCELLED";
  constructor() {
    super("Plan approval was cancelled by the user.");
    this.name = "PlanApprovalCancelledError";
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
  "10. If product/visual direction, dependencies, scope, acceptance criteria,",
  "   assumptions, or unresolved questions materially change, call",
  "   request_reapproval after rewrite_plan with proposalJson containing the",
  "   complete replacement proposal as JSON, then pause before further work.",
  "",
  "Use repository-relative paths. Inspect before editing, preview edits before",
  "applying them, verify changes, and do not attempt to publish or access the host.",
].join("\n");

const RAW_TOOL_DEFINITIONS: ModelToolDefinition[] = [
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
    verificationRequirementId: { type: "string" },
  }, ["cwd", "command"]),
  toolDefinition("verify_viewport", "Verify an approved viewport requirement in pinned Chromium.", {
    verificationRequirementId: { type: "string" },
  }, ["verificationRequirementId"]),
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
  {
    name: "request_reapproval",
    description: "Pause implementation and request approval for a material change to protected plan intent.",
    // Keep this small schema advisory at the provider boundary. The complete
    // JSON proposal is parsed and strictly validated by PlanProposalSchema
    // before any checkpoint or sandbox action.
    strict: false,
    inputSchema: {
      type: "object",
      properties: {
        proposalJson: { type: "string" },
        reason: { type: "string" },
      },
      required: ["proposalJson", "reason"],
      additionalProperties: false,
    },
  },
];

const TOOL_DEFINITIONS: ModelToolDefinition[] = RAW_TOOL_DEFINITIONS.map((tool) => ({
  ...tool,
  // Anthropic cannot compile the aggregate eight-tool execution grammar.
  // validateProductionTurn and validateToolCall remain the authoritative
  // fail-closed boundary before checkpoint changes or sandbox dispatch.
  strict: false,
}));

const DISCOVERY_SYSTEM_PROMPT = [
  "You are a coding agent performing read-only repository discovery.",
  "Do not propose mutations until you understand the repository and task.",
  "Each response must call exactly one available tool.",
  "Use repository-relative paths. Git is limited to status and diff.",
  "When discovery is sufficient, call propose_plan with the complete design,",
  "scope, acceptance checks, assumptions, and ordered execution plan.",
].join("\n");

const DISCOVERY_TOOL_DEFINITIONS: ModelToolDefinition[] = [
  toolDefinition("read_file", "Read a repository-relative UTF-8 file.", {
    path: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" },
  }, ["path"]),
  toolDefinition("ripgrep", "Search repository text.", {
    pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, caseSensitive: { type: "boolean" }, fixedString: { type: "boolean" },
  }, ["pattern"]),
  toolDefinition("tree_sitter_symbols", "List symbols in a source file.", { path: { type: "string" } }, ["path"]),
  toolDefinition("git", "Inspect Git status or diff without mutation.", {
    subcommand: { type: "string", enum: ["status", "diff"] }, staged: { type: "boolean" }, path: { type: "string" },
  }, ["subcommand"]),
  {
    name: "propose_plan",
    description: "Submit the complete implementation proposal for human approval.",
    strict: true,
    inputSchema: proposalInputSchema(),
  },
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
  const auditJournal = auditJournalFor(options);
  const recoveredAudit = await auditJournal.recover(state.auditCursor);
  if (recoveredAudit.filter((record) => record.type === "tool_terminal").length !== state.counters.toolCalls) {
    throw new ProductionTurnProtocolError("AUDIT_TOOL_COUNT_MISMATCH: committed tool calls do not match terminal audit records.");
  }
  state = await configureApprovalMode(state, options);
  validateRecoveredState(state, options);
  options.events?.emit({
    type: "state_loaded",
    lifecycle: state.lifecycle,
    plan: state.plan,
    usage: usageFromCounters(state.counters, state),
    evidence: eventEvidenceSummary(state),
  });

  if (state.lifecycle === "failed") {
    throw new ProductionTurnProtocolError(
      state.terminalError ?? "Checkpoint contains a failed run.",
    );
  }
  if (state.lifecycle === "cancelled") {
    throw new PlanApprovalCancelledError();
  }
  if (state.lifecycle === "completed" || state.lifecycle === "finalizing") return toResult(state);
  assertRuntimeMatchesPricing(state, runtime);

  while (state.lifecycle === "running") {
    throwIfAborted(options.signal);

    if (state.approval.phase === "discovering") {
      state = await runDiscoveryStep(state, runtime, options);
      continue;
    }
    if (state.approval.phase === "awaiting_approval") {
      state = await resolvePlanApproval(state, options);
      continue;
    }
    if (state.approval.phase === "approved") {
      state = await installApprovedPlan(state, options);
      continue;
    }

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
  approvalMode?: ApprovalMode;
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
        approval: state.approval.phase === "discovering" && state.approval.discoveryTranscript.length === 0
          ? {
              ...state.approval,
              discoveryTranscript: [{ role: "user", content: discoveryPrompt(state.task, promptResult.appendedContext) }],
            }
          : state.approval,
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
  auditJournal?: AuditJournal;
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
    ...(options.auditJournal ? { auditJournal: options.auditJournal } : {}),
  });
  return true;
}

function createBootstrapState(
  options: { canonicalRepoPath: string; task: string; runIdentity: string; approvalMode?: ApprovalMode },
  limits: ProductionAgentState["limits"],
  pricing: ProductionAgentState["pricing"],
): ProductionAgentState {
  if (!options.approvalMode) {
    throw new PlanApprovalRequiredError("approval-mode-required");
  }
  return {
    version: 4,
    approval: createInitialApprovalState(options.approvalMode),
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
    auditCursor: { sequence: 0, digest: EMPTY_AUDIT_DIGEST },
    verificationEvidence: [],
    completion: null,
    legacyCompletionStatus: null,
  };
}

async function configureApprovalMode(
  state: ProductionAgentState,
  options: ProductionLoopOptions,
): Promise<ProductionAgentState> {
  if (!options.approvalMode) return state;
  if (state.lifecycle !== "running") return state;
  if (state.approval.mode && state.approval.mode !== options.approvalMode) {
    throw new ProductionTurnProtocolError(
      `Checkpoint approval mode ${state.approval.mode} does not match requested mode ${options.approvalMode}.`,
    );
  }
  if (state.approval.mode === options.approvalMode) return state;
  if (state.approval.legacyTerminal || state.counters.modelCalls > 0 || state.plan.length > 0) {
    throw new ProductionTurnProtocolError(
      "Existing execution state cannot be converted into a plan-approval run.",
    );
  }
  const next = {
    ...state,
    approval: {
      ...createInitialApprovalState(options.approvalMode),
      discoveryTranscript: [
        { role: "user" as const, content: discoveryPrompt(state.task, state.appendedPromptContext) },
      ],
    },
  };
  await options.checkpointStore.save(next);
  return next;
}

async function runDiscoveryStep(
  state: ProductionAgentState,
  runtime: ModelRuntime,
  options: ProductionLoopOptions,
): Promise<ProductionAgentState> {
  if (state.approval.pendingDiscoveryTurn) {
    return commitPendingDiscoveryTurn(state, state.approval.pendingDiscoveryTurn, options);
  }
  state = await recoverAmbiguousCall(state, options);
  state = await maybeCompactDiscovery(state, runtime, options);
  const paid = state.pendingModelCall?.response
    ? { state, turn: responseToTurn(state.pendingModelCall.response) }
    : await reserveAndCall(state, createDiscoveryRequest(state), "agent", runtime, options);
  state = paid.state;
  let pending: NonNullable<ApprovalState["pendingDiscoveryTurn"]>;
  try {
    pending = validateDiscoveryTurn(paid.turn.content, paid.turn.stopReason);
  } catch (error) {
    const protocolError = error instanceof ProductionTurnProtocolError
      ? error
      : new ProductionTurnProtocolError("Discovery turn validation failed.");
    if (state.consecutiveInvalidAttempts >= 1) {
      const failed = {
        ...state,
        lifecycle: "failed" as const,
        terminalCode: "MODEL_PROTOCOL_FAILED",
        terminalError: `Model violated the discovery protocol twice: ${protocolError.message}`,
        pendingModelCall: null,
      };
      await options.checkpointStore.save(failed);
      throw protocolError;
    }
    const correction = `The previous discovery response was rejected without executing tools: ${protocolError.message} Retry with exactly one read-only discovery tool or propose_plan.`;
    const retry: ProductionAgentState = {
      ...state,
      pendingModelCall: null,
      consecutiveInvalidAttempts: 1,
      approval: {
        ...state.approval,
        discoveryProtocolRetries: state.approval.discoveryProtocolRetries + 1,
        discoveryTranscript: [...state.approval.discoveryTranscript, { role: "user", content: correction }],
      },
      counters: {
        ...state.counters,
        protocolRetries: state.counters.protocolRetries + 1,
      },
    };
    await options.checkpointStore.save(retry);
    return retry;
  }
  const staged: ProductionAgentState = {
    ...state,
    pendingModelCall: null,
    approval: { ...state.approval, pendingDiscoveryTurn: pending },
  };
  await options.checkpointStore.save(staged);
  return staged;
}

async function maybeCompactDiscovery(
  state: ProductionAgentState,
  runtime: ModelRuntime,
  options: ProductionLoopOptions,
): Promise<ProductionAgentState> {
  const estimate = await runtime.countRequestTokens(createDiscoveryRequest(state), options.signal);
  const checkpointBytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (estimate.tokens < state.limits.compactAtTokens && checkpointBytes < state.limits.compactAtCheckpointBytes) {
    return state;
  }
  const hookContext = options.hooks
    ? await options.hooks.runGating("PreCompact", {
        runIdentity: state.runIdentity,
        contextTokens: estimate.tokens,
        checkpointBytes,
        compactionNumber: state.approval.discoveryCompactions + 1,
      })
    : { appendedContext: "" };
  const observations = state.approval.discoveryTranscript
    .filter((message) => message.role === "user" && Array.isArray(message.content))
    .slice(-12)
    .map((message) => JSON.stringify(message.content).slice(0, 2_048));
  const marker = [
    `Discovery compaction ${state.approval.discoveryCompactions + 1}`,
    `Prior committed turns: ${state.approval.discoveryCommittedTurns}`,
    `Revision feedback: ${JSON.stringify(state.approval.feedbackHistory)}`,
    `Recent read-only observations: ${JSON.stringify(observations)}`,
    ...(hookContext.appendedContext ? [`Lifecycle context: ${hookContext.appendedContext.slice(0, 4_096)}`] : []),
  ].join("\n");
  const first = state.approval.discoveryTranscript[0];
  if (!first) throw new ProductionTurnProtocolError("Discovery compaction requires its canonical prompt.");
  const compacted: ProductionAgentState = {
    ...state,
    approval: {
      ...state.approval,
      discoveryTranscript: [first, { role: "user", content: marker }],
      discoveryCompactions: state.approval.discoveryCompactions + 1,
      discoveryBaselineCommittedTurns: state.approval.discoveryCommittedTurns,
      discoveryBaselineProtocolRetries: state.approval.discoveryProtocolRetries,
      discoveryBaselineToolCalls: state.approval.discoveryToolCalls,
    },
  };
  await options.checkpointStore.save(compacted);
  return compacted;
}

function validateDiscoveryTurn(
  content: AssistantBlock[],
  stopReason: string | null,
): NonNullable<ApprovalState["pendingDiscoveryTurn"]> {
  if (stopReason !== "tool_use") {
    throw new ProductionTurnProtocolError(`Expected discovery tool_use stop reason, received "${stopReason ?? "null"}".`);
  }
  const calls = content.filter((block): block is ToolUseBlock => block.type === "tool_use");
  if (calls.length !== 1 || new Set(calls.map((call) => call.id)).size !== 1) {
    throw new ProductionTurnProtocolError("Discovery must call exactly one tool with a unique ID.");
  }
  const [call] = calls;
  if (!call) throw new ProductionTurnProtocolError("Discovery tool call is missing.");
  if (call.name === "propose_plan") {
    const parsed = PlanProposalSchema.safeParse(call.input);
    if (!parsed.success) {
      throw new ProductionTurnProtocolError("propose_plan must contain one complete valid proposal.");
    }
    return {
      assistantContent: content,
      proposalToolId: call.id,
      proposal: parsed.data,
      action: null,
    };
  }
  if (!["read_file", "ripgrep", "tree_sitter_symbols", "git"].includes(call.name)) {
    throw new ProductionTurnProtocolError(`Tool "${call.name}" is unavailable during read-only discovery.`);
  }
  let request: ModelToolRequest;
  try {
    request = validateToolCall({ name: call.name, input: call.input });
  } catch (error) {
    throw new ProductionTurnProtocolError(error instanceof Error ? error.message : "Invalid discovery tool call.");
  }
  if (isMutatingToolCall(request)) {
    throw new ProductionTurnProtocolError(`Mutating tool "${request.name}" is unavailable before plan approval.`);
  }
  return {
    assistantContent: content,
    proposalToolId: null,
    proposal: null,
    action: { toolUseId: call.id, operationId: crypto.randomUUID(), request: request as NonNullable<ApprovalState["pendingDiscoveryTurn"]>["action"] extends infer A ? A extends { request: infer R } ? R : never : never },
  };
}

async function commitPendingDiscoveryTurn(
  state: ProductionAgentState,
  pending: NonNullable<ApprovalState["pendingDiscoveryTurn"]>,
  options: ProductionLoopOptions,
): Promise<ProductionAgentState> {
  const validated = validateDiscoveryTurn(pending.assistantContent, "tool_use");
  if (
    validated.proposalToolId !== pending.proposalToolId ||
    JSON.stringify(validated.proposal) !== JSON.stringify(pending.proposal) ||
    JSON.stringify(validated.action?.request ?? null) !== JSON.stringify(pending.action?.request ?? null) ||
    validated.action?.toolUseId !== pending.action?.toolUseId
  ) {
    throw new ProductionTurnProtocolError("Checkpoint pending discovery turn does not match its assistant content.");
  }
  const results: ToolResultBlock[] = [];
  let toolIncrement = 0;
  let committedDiscoveryResult: ProductionAgentState["lastToolResult"] = null;
  let discoveryDurationMs = 0;
  if (pending.action) {
    const request = validateToolCall(pending.action.request);
    if (isMutatingToolCall(request)) {
      throw new ProductionTurnProtocolError("Preapproval mutation was denied before sandbox dispatch.");
    }
    throwIfAborted(options.signal);
    const now = options.now ?? (() => performance.now());
    const startedAt = now();
    options.events?.emit({ type: "tool_started", operationId: pending.action.operationId, toolName: request.name, summary: safeToolSummary(request) });
    let result;
    try {
      result = await options.session.call(request, { operationId: pending.action.operationId, ...(options.signal ? { signal: options.signal } : {}) });
      discoveryDurationMs = Math.max(0, now() - startedAt);
      options.events?.emit({ type: "tool_finished", operationId: pending.action.operationId, durationMs: discoveryDurationMs, outcome: toolOutcome(result) });
    } catch (error) {
      options.events?.emit({ type: "tool_finished", operationId: pending.action.operationId, durationMs: Math.max(0, now() - startedAt), outcome: options.signal?.aborted || isAbortError(error) ? "cancelled" : "failed" });
      throw error;
    }
    results.push({ type: "tool_result", toolUseId: pending.action.toolUseId, content: JSON.stringify(result), isError: !result.success });
    const { metadata: discoveryMetadata, ...discoveryWithoutMetadata } = result;
    committedDiscoveryResult = {
      ...discoveryWithoutMetadata,
      ...(discoveryMetadata ? { metadata: Object.fromEntries(Object.entries(discoveryMetadata).filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined)) } : {}),
    };
    toolIncrement = 1;
  } else if (pending.proposal && pending.proposalToolId) {
    results.push({ type: "tool_result", toolUseId: pending.proposalToolId, content: JSON.stringify({ accepted: true, awaitingApproval: true }) });
  }
  const proposal = pending.proposal;
  const next: ProductionAgentState = {
    ...state,
    pendingModelCall: null,
    consecutiveInvalidAttempts: 0,
    approval: {
      ...state.approval,
      ...(proposal
        ? {
            phase: "awaiting_approval" as const,
            currentProposal: proposal,
            proposalDigest: proposalDigest(proposal),
            revision: state.approval.revision + 1,
          }
        : {}),
      pendingDiscoveryTurn: null,
      discoveryTranscript: [
        ...state.approval.discoveryTranscript,
        { role: "assistant", content: pending.assistantContent },
        { role: "user", content: results },
      ],
      discoveryCommittedTurns: state.approval.discoveryCommittedTurns + 1,
      discoveryToolCalls: state.approval.discoveryToolCalls + toolIncrement,
    },
    counters: {
      ...state.counters,
      committedTurns: state.counters.committedTurns + 1,
      toolCalls: state.counters.toolCalls + toolIncrement,
    },
  };
  if (pending.action && committedDiscoveryResult) {
    const request = validateToolCall(pending.action.request);
    const committed = await new AuditCheckpointCoordinator(auditJournalFor(options), options.checkpointStore).commit(
      state,
      next,
      [toolAuditDraft(pending.action.operationId, request, committedDiscoveryResult, discoveryDurationMs)],
    );
    Object.assign(next, committed.state);
    options.events?.emit(toolAuditedEvent(committed.records[0]!));
  } else {
    await options.checkpointStore.save(next);
  }
  return next;
}

function createDiscoveryRequest(state: ProductionAgentState): ModelRequest {
  return {
    system: DISCOVERY_SYSTEM_PROMPT,
    messages: state.approval.discoveryTranscript,
    tools: DISCOVERY_TOOL_DEFINITIONS,
    maxTokens: 4_096,
  };
}

function discoveryPrompt(task: string, appendedContext = ""): string {
  return [
    "Discover the repository and propose a plan for this task:",
    task,
    "",
    "Use only read-only discovery tools. Submit propose_plan when ready.",
    ...(appendedContext ? ["", "Lifecycle context:", appendedContext] : []),
  ].join("\n");
}

async function resolvePlanApproval(
  state: ProductionAgentState,
  options: ProductionLoopOptions,
): Promise<ProductionAgentState> {
  const proposal = state.approval.currentProposal;
  const digest = state.approval.proposalDigest;
  if (!proposal || !digest) {
    throw new ProductionTurnProtocolError("Awaiting approval checkpoint has no proposal.");
  }
  options.events?.emit({
    type: "approval_requested",
    proposal,
    proposalDigest: digest,
    revision: state.approval.revision,
    mode: state.approval.mode ?? "interactive",
    ...(state.approval.pendingReapproval?.reason
      ? { reapprovalReason: state.approval.pendingReapproval.reason }
      : {}),
  });
  let rawDecision;
  if (state.approval.mode === "auto") {
    rawDecision = { kind: "approve" as const };
  } else if (options.requestApproval) {
    rawDecision = await options.requestApproval({
      proposal,
      proposalDigest: digest,
      revision: state.approval.revision,
      ...(state.approval.pendingReapproval?.reason
        ? { reapprovalReason: state.approval.pendingReapproval.reason }
        : {}),
    }, options.signal);
    throwIfAborted(options.signal);
  } else {
    throw new PlanApprovalRequiredError(digest);
  }
  const decision = ApprovalDecisionSchema.parse(rawDecision);
  if (decision.kind === "cancel") {
    const cancelled: ProductionAgentState = {
      ...state,
      lifecycle: "cancelled",
      terminalCode: "PLAN_CANCELLED",
      terminalError: null,
      pendingTurn: null,
      pendingModelCall: null,
      approval: { ...state.approval, phase: "cancelled", pendingDiscoveryTurn: null },
    };
    await options.checkpointStore.save(cancelled);
    options.events?.emit({ type: "approval_resolved", proposalDigest: digest, revision: state.approval.revision, decision: "cancel" });
    throw new PlanApprovalCancelledError();
  }
  if (decision.kind === "revise") {
    const feedback = [
      `Plan revision feedback: ${decision.feedback}`,
      state.approval.pendingReapproval
        ? `Rejected replacement proposal (${digest}) for reapproval reason: ${state.approval.pendingReapproval.reason}`
        : `Rejected proposal (${digest})`,
      ...(state.approval.pendingReapproval ? [JSON.stringify(proposal)] : []),
    ].join("\n");
    const revised: ProductionAgentState = {
      ...state,
      approval: {
        ...state.approval,
        phase: "discovering",
        currentProposal: null,
        proposalDigest: null,
        feedbackHistory: [...state.approval.feedbackHistory, decision.feedback],
        discoveryTranscript: [...state.approval.discoveryTranscript, { role: "user", content: feedback }],
      },
    };
    await options.checkpointStore.save(revised);
    options.events?.emit({ type: "approval_resolved", proposalDigest: digest, revision: state.approval.revision, decision: "revise" });
    return revised;
  }
  const approved: ProductionAgentState = {
    ...state,
    approval: {
      ...state.approval,
      phase: "approved",
      approvedProposalDigest: digest,
    },
  };
  await options.checkpointStore.save(approved);
  options.events?.emit({ type: "approval_resolved", proposalDigest: digest, revision: state.approval.revision, decision: "approve" });
  return approved;
}

async function installApprovedPlan(
  state: ProductionAgentState,
  options: ProductionLoopOptions,
): Promise<ProductionAgentState> {
  const proposal = state.approval.currentProposal;
  const digest = state.approval.approvedProposalDigest;
  if (!proposal || !digest || digest !== state.approval.proposalDigest) {
    throw new ProductionTurnProtocolError("Approved checkpoint has inconsistent proposal state.");
  }
  const reapproval = state.approval.pendingReapproval;
  const next: ProductionAgentState = {
    ...state,
    plan: proposalExecutionPlan(proposal),
    transcript: reapproval
      ? [
          ...state.transcript,
          { role: "user", content: reapprovalTranscriptMarker(proposal, digest) },
        ]
      : [{ role: "user", content: approvedExecutionPrompt(state.task, state.appendedPromptContext, proposal, digest) }],
    lastToolSucceeded: null,
    lastToolResult: null,
    approval: {
      ...state.approval,
      phase: "executing",
      pendingReapproval: null,
      ...(reapproval
        ? {}
        : { executionBaseProposal: proposal, executionBaseDigest: digest }),
    },
  };
  await options.checkpointStore.save(next);
  options.events?.emit({ type: "plan_committed", plan: next.plan });
  return next;
}

function approvedExecutionPrompt(
  task: string,
  appendedContext: string,
  proposal: NonNullable<ProductionAgentState["approval"]["currentProposal"]>,
  digest: string,
): string {
  return [
    initialPrompt(task, appendedContext),
    "",
    `Approved proposal (${digest}):`,
    JSON.stringify(proposal),
    "Continue from the approved execution plan. Request reapproval before changing protected intent.",
  ].join("\n");
}

function reapprovalTranscriptMarker(proposal: PlanProposal, digest: string): string {
  return [
    `Plan reapproval approved: ${digest}`,
    `Replacement proposal: ${JSON.stringify(proposal)}`,
  ].join("\n");
}

function parseReapprovalTranscriptMarker(content: string): PlanProposal {
  const match = /^Plan reapproval approved: ([a-f0-9]{64})\nReplacement proposal: (.+)$/u.exec(content);
  if (!match?.[1] || !match[2]) {
    throw new ProductionTurnProtocolError("Checkpoint contains an invalid reapproval marker.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(match[2]);
  } catch {
    throw new ProductionTurnProtocolError("Checkpoint contains invalid reapproval proposal JSON.");
  }
  const proposal = PlanProposalSchema.parse(decoded);
  if (proposalDigest(proposal) !== match[1]) {
    throw new ProductionTurnProtocolError("Checkpoint reapproval marker digest does not match its proposal.");
  }
  return proposal;
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
    { role: "user", content: currentExecutionPrompt(state) },
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
    if (state.approval.phase !== "executing") {
      throw new ProductionTurnProtocolError("Repository actions are unavailable until plan approval is installed.");
    }
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
      const contractError = verificationContractError(state, request);
      rawResult = contractError
        ? failedToolResult(contractError.code, contractError.message)
        : await options.session.call(request, {
            operationId: pending.action.operationId,
            ...(request.name === "verify_viewport" ? { viewportRequirement: approvedViewportRequirement(state, request.input.verificationRequirementId) } : {}),
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

  if (pending.reapproval) {
    const priorDigest = state.approval.approvedProposalDigest;
    if (!priorDigest || !state.approval.currentProposal) {
      throw new ProductionTurnProtocolError("Material reapproval requires an existing approved proposal.");
    }
    if (protectedProposalDigest(pending.reapproval.proposal) === protectedProposalDigest(state.approval.currentProposal)) {
      throw new ProductionTurnProtocolError("Material reapproval proposal does not change protected intent.");
    }
    const digest = proposalDigest(pending.reapproval.proposal);
    results.push({
      type: "tool_result",
      toolUseId: pending.reapproval.toolUseId,
      content: JSON.stringify({ accepted: true, awaitingApproval: true, proposalDigest: digest }),
    });
    const awaiting: ProductionAgentState = {
      ...state,
      plan: pending.plan,
      transcript: [
        ...state.transcript,
        { role: "assistant", content: pending.assistantContent },
        { role: "user", content: results },
      ],
      pendingTurn: null,
      consecutiveInvalidAttempts: 0,
      approval: {
        ...state.approval,
        phase: "awaiting_approval",
        currentProposal: pending.reapproval.proposal,
        proposalDigest: digest,
        revision: state.approval.revision + 1,
        pendingReapproval: { priorDigest, reason: pending.reapproval.reason },
      },
      counters: {
        ...state.counters,
        committedTurns: state.counters.committedTurns + 1,
        planRewrites: state.counters.planRewrites + (pending.planToolId ? 1 : 0),
      },
    };
    await options.checkpointStore.save(awaiting);
    options.events?.emit({ type: "plan_committed", plan: awaiting.plan });
    return awaiting;
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
  if (completed) {
    const missingRequirementIds = completionEvidenceMissing(state);
    if (missingRequirementIds.length > 0) {
      const reason = `Completion evidence is missing, failed, or stale for: ${missingRequirementIds.join(", ")}.`;
      const rejected: ProductionAgentState = {
        ...state,
        lifecycle: "running",
        transcript: [
          ...state.transcript,
          { role: "assistant", content: pending.assistantContent },
          { role: "user", content: [{ type: "tool_result", toolUseId: pending.planToolId!, content: JSON.stringify({ accepted: false, code: "COMPLETION_EVIDENCE_MISSING", reason, requirementIds: missingRequirementIds }), isError: true }] },
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
      await notify(rejected, options, { kind: "lifecycle", code: "COMPLETION_EVIDENCE_MISSING", title: "Completion evidence required", message: reason });
      return rejected;
    }
  }
  const next: ProductionAgentState = {
    ...state,
    lifecycle: completed ? (state.approval.legacyTerminal ? "completed" : "finalizing") : "running",
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
    legacyCompletionStatus: completed && state.approval.legacyTerminal ? "legacy_unverified" : state.legacyCompletionStatus,
    counters: {
      ...state.counters,
      committedTurns: state.counters.committedTurns + 1,
      toolCalls: state.counters.toolCalls + toolIncrement,
      planRewrites:
        state.counters.planRewrites + (pending.planToolId ? 1 : 0),
    },
  };
  if (pending.action && lastToolResult) {
    const request = validateToolCall(pending.action.request);
    const coordinator = new AuditCheckpointCoordinator(auditJournalFor(options), options.checkpointStore);
    const verificationRequirementId = request.name === "verify_viewport"
      ? request.input.verificationRequirementId
      : request.name === "run_shell"
        ? request.input.verificationRequirementId
        : undefined;
    const auditDrafts = [
      toolAuditDraft(pending.action.operationId, request, lastToolResult, toolDurationMs),
      ...(verificationRequirementId
        ? [verificationAuditDraft(state, pending.action.operationId, verificationRequirementId, lastToolResult)]
        : []),
    ];
    const committed = await coordinator.commit(
      state,
      withStaleEvidence(next, request, lastToolResult),
      auditDrafts,
      (committedState, records) => installVerificationEvidence(committedState, request, lastToolResult!, records.at(-1)!),
    );
    Object.assign(next, committed.state);
    options.events?.emit(toolAuditedEvent(committed.records[0]!));
    for (const evidence of committed.state.verificationEvidence) {
      const previous = state.verificationEvidence.find((item) => item.requirementId === evidence.requirementId);
      if (previous?.status !== evidence.status && evidence.status === "stale") {
        options.events?.emit({ type: "verification_updated", requirementId: evidence.requirementId, status: evidence.status });
      }
    }
    const updatedEvidence = committed.state.verificationEvidence.find((item) => item.operationId === pending.action!.operationId);
    if (updatedEvidence) options.events?.emit({ type: "verification_updated", requirementId: updatedEvidence.requirementId, status: updatedEvidence.status });
  } else if (next.lifecycle === "finalizing") {
    const candidateTree = completionCandidateTree(next);
    const committed = await new AuditCheckpointCoordinator(auditJournalFor(options), options.checkpointStore).commit(
      state,
      next,
      [{ type: "finalization_started", operationId: null, payload: { candidateTree } }],
    );
    Object.assign(next, committed.state);
    options.events?.emit({ type: "finalization_started", candidateTree });
  } else {
    await options.checkpointStore.save(next);
  }
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
  validateReapprovalMateriality = true,
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
      reapproval: null,
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
  let reapproval: PendingProductionTurn["reapproval"] = null;
  if (actionCall) {
    if (actionCall.name === "rewrite_plan") {
      throw new ProductionTurnProtocolError(
        "A turn must contain exactly one rewrite_plan call.",
      );
    }
    if (actionCall.name === "request_reapproval") {
      const input = actionCall.input;
      let decodedProposal: unknown;
      const proposalJson = typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>).proposalJson
        : undefined;
      if (typeof proposalJson === "string") {
        try { decodedProposal = JSON.parse(proposalJson); } catch { decodedProposal = undefined; }
      }
      const parsedReapproval = PlanProposalSchema.safeParse(decodedProposal);
      const reason = typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>).reason
        : undefined;
      if (!parsedReapproval.success || typeof reason !== "string" || !reason.trim() || reason.length > 2_048 || Object.keys(input as Record<string, unknown>).some((key) => key !== "proposalJson" && key !== "reason")) {
        throw new ProductionTurnProtocolError("request_reapproval requires one complete proposal and a bounded reason.");
      }
      if (validateReapprovalMateriality && (!state.approval.currentProposal || protectedProposalDigest(parsedReapproval.data) === protectedProposalDigest(state.approval.currentProposal))) {
        throw new ProductionTurnProtocolError("request_reapproval must materially change protected proposal fields.");
      }
      reapproval = { toolUseId: actionCall.id, proposal: parsedReapproval.data, reason: reason.trim() };
    } else {
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
  }

  return {
    assistantContent: content,
    plan: parsed.data.plan,
    planToolId: planCall.id,
    action,
    reapproval,
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
    tools: state.approval.currentProposal?.verificationRequirements.some((item) => item.type === "viewport")
      ? TOOL_DEFINITIONS
      : TOOL_DEFINITIONS.filter((tool) => tool.name !== "verify_viewport"),
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

function canonicalExecutionPrompt(state: ProductionAgentState): string {
  if (state.approval.legacyTerminal || !state.approval.executionBaseProposal || !state.approval.executionBaseDigest) {
    return initialPrompt(state.task, state.appendedPromptContext);
  }
  return approvedExecutionPrompt(
    state.task,
    state.appendedPromptContext,
    state.approval.executionBaseProposal,
    state.approval.executionBaseDigest,
  );
}

function currentExecutionPrompt(state: ProductionAgentState): string {
  if (state.approval.legacyTerminal || !state.approval.currentProposal || !state.approval.approvedProposalDigest) {
    return canonicalExecutionPrompt(state);
  }
  return approvedExecutionPrompt(
    state.task,
    state.appendedPromptContext,
    state.approval.currentProposal,
    state.approval.approvedProposalDigest,
  );
}

async function initializeState(
  options: ProductionLoopOptions,
  limits: ProductionAgentState["limits"],
  pricing: ReturnType<typeof pricingFor>,
): Promise<ProductionAgentState> {
  const existing = await options.checkpointStore.load();
  if (existing) return existing;
  if (!options.approvalMode) {
    throw new PlanApprovalRequiredError("approval-mode-required");
  }
  const state: ProductionAgentState = {
    version: 4,
    approval: {
      ...createInitialApprovalState(options.approvalMode),
      discoveryTranscript: [{ role: "user", content: discoveryPrompt(options.task) }],
    },
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
    auditCursor: { sequence: 0, digest: EMPTY_AUDIT_DIGEST },
    verificationEvidence: [],
    completion: null,
    legacyCompletionStatus: null,
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
  if (state.lifecycle !== "running" && (state.pendingTurn || state.approval.pendingDiscoveryTurn)) {
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
  const compactedCurrentPrompt = state.compaction.count > 0 && state.transcript[1]?.role === "user" &&
    typeof state.transcript[1].content === "string" && state.transcript[1].content.startsWith("Compaction ")
    ? currentExecutionPrompt(state)
    : null;
  if (
    !firstMessage ||
    firstMessage.role !== "user" ||
    (firstMessage.content !== canonicalExecutionPrompt(state) && firstMessage.content !== compactedCurrentPrompt)
  ) {
    throw new ProductionTurnProtocolError(
      "Checkpoint does not contain the canonical initial task prompt.",
    );
  }
  validateRecoveredDiscovery(state);
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
  const finalMessage = state.approval.phase === "discovering"
    ? state.approval.discoveryTranscript.at(-1)
    : state.transcript.at(-1);
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

function validateRecoveredDiscovery(state: ProductionAgentState): void {
  if (state.approval.legacyTerminal) return;
  const transcript = state.approval.discoveryTranscript;
  const first = transcript[0];
  if (
    !first || first.role !== "user" ||
    first.content !== discoveryPrompt(state.task, state.appendedPromptContext)
  ) {
    throw new ProductionTurnProtocolError("Checkpoint does not contain the canonical discovery prompt.");
  }
  let committedTurns = state.approval.discoveryBaselineCommittedTurns;
  let protocolRetries = state.approval.discoveryBaselineProtocolRetries;
  let toolCalls = state.approval.discoveryBaselineToolCalls;
  for (let index = 1; index < transcript.length; index += 1) {
    const message = transcript[index];
    if (message?.role === "user" && typeof message.content === "string") {
      if (message.content.startsWith("Discovery compaction ")) {
        continue;
      }
      if (message.content.startsWith("Plan revision feedback: ")) {
        continue;
      }
      if (!message.content.startsWith("The previous discovery response was rejected without executing tools:")) {
        throw new ProductionTurnProtocolError("Discovery transcript contains unknown feedback.");
      }
      protocolRetries += 1;
      continue;
    }
    if (!message || message.role !== "assistant") {
      throw new ProductionTurnProtocolError("Discovery transcript contains an unpaired result.");
    }
    const pending = validateDiscoveryTurn(message.content, "tool_use");
    const resultMessage = transcript[index + 1];
    if (!resultMessage || resultMessage.role !== "user" || !Array.isArray(resultMessage.content) || resultMessage.content.length !== 1) {
      throw new ProductionTurnProtocolError("Discovery turn lacks one correlated result.");
    }
    const result = resultMessage.content[0];
    const toolUseId = pending.proposalToolId ?? pending.action?.toolUseId;
    if (result?.type !== "tool_result" || result.toolUseId !== toolUseId) {
      throw new ProductionTurnProtocolError("Discovery result does not correlate with its tool call.");
    }
    if (pending.action) toolCalls += 1;
    committedTurns += 1;
    index += 1;
  }
  if (
    committedTurns !== state.approval.discoveryCommittedTurns ||
    protocolRetries !== state.approval.discoveryProtocolRetries ||
    toolCalls !== state.approval.discoveryToolCalls
  ) {
    throw new ProductionTurnProtocolError("Discovery transcript does not match its committed counters.");
  }
  if (state.approval.pendingDiscoveryTurn) {
    const validated = validateDiscoveryTurn(state.approval.pendingDiscoveryTurn.assistantContent, "tool_use");
    if (
      validated.proposalToolId !== state.approval.pendingDiscoveryTurn.proposalToolId ||
      JSON.stringify(validated.proposal) !== JSON.stringify(state.approval.pendingDiscoveryTurn.proposal) ||
      JSON.stringify(validated.action?.request ?? null) !== JSON.stringify(state.approval.pendingDiscoveryTurn.action?.request ?? null)
    ) {
      throw new ProductionTurnProtocolError("Checkpoint pending discovery turn is inconsistent.");
    }
  }
}

function validateRecoveredTranscript(state: ProductionAgentState): void {
  let historicalPlan: TodoItem[] = state.approval.executionBaseProposal
    ? proposalExecutionPlan(state.approval.executionBaseProposal)
    : [];
  let historicalToolSucceeded: boolean | null = null;
  let historicalToolResult: ProductionAgentState["lastToolResult"] = null;
  let committedTurns = state.approval.discoveryCommittedTurns;
  let protocolRetries = state.approval.discoveryProtocolRetries;
  let toolCalls = state.approval.discoveryToolCalls;
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
      if (message.content.startsWith("Plan reapproval approved: ")) {
        const replacement = parseReapprovalTranscriptMarker(message.content);
        historicalPlan = proposalExecutionPlan(replacement);
        historicalToolSucceeded = null;
        historicalToolResult = null;
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
      false,
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
    if (validated.reapproval) {
      const reapprovalResult = results[resultIndex];
      if (!reapprovalResult || reapprovalResult.isError === true || !isAcceptedReapprovalResult(reapprovalResult.content)) {
        throw new ProductionTurnProtocolError("Checkpoint material reapproval lacks its accepted result.");
      }
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
      Object.keys(decoded).every((key) => ["accepted", "code", "reason", "requirementIds"].includes(key)) &&
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

function isAcceptedReapprovalResult(content: string): boolean {
  try {
    const decoded: unknown = JSON.parse(content);
    return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded) &&
      "accepted" in decoded && decoded.accepted === true &&
      "awaitingApproval" in decoded && decoded.awaitingApproval === true &&
      "proposalDigest" in decoded && typeof decoded.proposalDigest === "string";
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
  const sameReapproval =
    pending.reapproval === null && validated.reapproval === null
      ? true
      : Boolean(
          pending.reapproval && validated.reapproval &&
          pending.reapproval.toolUseId === validated.reapproval.toolUseId &&
          pending.reapproval.reason === validated.reapproval.reason &&
          JSON.stringify(pending.reapproval.proposal) === JSON.stringify(validated.reapproval.proposal),
        );
  if (
    pending.planToolId !== validated.planToolId ||
    JSON.stringify(pending.plan) !== JSON.stringify(validated.plan) ||
    !sameAction ||
    !sameReapproval
  ) {
    throw new ProductionTurnProtocolError(
      "Checkpoint pending turn does not match its validated assistant content.",
    );
  }
}

function toResult(state: ProductionAgentState): ProductionLoopResult {
  if (state.lifecycle !== "completed" && state.lifecycle !== "finalizing") {
    throw new ProductionTurnProtocolError(
      "Production loop did not reach a completed state.",
    );
  }
  return {
    status: state.lifecycle,
    modelTurns: state.counters.modelTurns,
    acceptedTurns: state.counters.committedTurns,
    protocolRetries: state.counters.protocolRetries,
    toolCalls: state.counters.toolCalls,
    planRewrites: state.counters.planRewrites,
    inputTokens: state.counters.inputTokens,
    outputTokens: state.counters.outputTokens,
    plan: state.plan,
    ...(state.completion ? { completion: state.completion } : {}),
  };
}

export async function completeProductionFinalization(options: {
  checkpointStore: ProductionCheckpointStore;
  auditJournal: AuditJournal;
  delivery: ResultDeliveryReceipt;
  events?: AgentEventPublisher;
}): Promise<ProductionLoopResult> {
  // finalizing -> revalidate candidate + artifacts -> bind delivery + audit
  //            -> persist completion receipt -> completed -> sandbox cleanup
  const state = await options.checkpointStore.load();
  if (!state || state.lifecycle !== "finalizing") {
    throw new ProductionTurnProtocolError("FINALIZATION_STATE_INVALID: completion requires a finalizing checkpoint.");
  }
  if (state.pendingTurn || state.pendingModelCall || state.approval.pendingDiscoveryTurn) {
    throw new ProductionTurnProtocolError("FINALIZATION_PENDING_WORK: finalizing checkpoint retains unresolved work.");
  }
  const proposal = state.approval.currentProposal;
  const approvedDigest = state.approval.approvedProposalDigest;
  if (!proposal || !approvedDigest || approvedDigest !== state.approval.proposalDigest) {
    throw new ProductionTurnProtocolError("FINALIZATION_APPROVAL_MISMATCH: approved proposal is unavailable.");
  }
  const records = await options.auditJournal.recover(state.auditCursor);
  validateFinalizationAudit(state, records);
  const candidateTree = completionCandidateTree(state);
  await revalidateViewportEvidenceFiles(state);
  if (options.checkpointStore instanceof FileProductionCheckpointStore) {
    await revalidateResultDeliveryReceipt(options.delivery);
  }
  if (options.delivery.runIdentity !== state.runIdentity || options.delivery.resultTreeSha !== candidateTree) {
    throw new ProductionTurnProtocolError("DELIVERED_TREE_MISMATCH: delivered result does not match the checked candidate tree.");
  }
  const deliveryDigest = await resultDeliveryReceiptDigest(options.delivery);
  const completing: ProductionAgentState = {
    ...state,
    lifecycle: "completed",
    legacyCompletionStatus: "verified",
  };
  const committed = await new AuditCheckpointCoordinator(options.auditJournal, options.checkpointStore).commit(
    state,
    completing,
    [
      { type: "delivery_completed", operationId: null, payload: { resultCommit: options.delivery.resultSha, resultTree: options.delivery.resultTreeSha, branch: options.delivery.branch, deliveryReceiptDigest: deliveryDigest } },
      { type: "completion_verified", operationId: null, payload: { candidateTree, resultCommit: options.delivery.resultSha, resultTree: options.delivery.resultTreeSha } },
    ],
    (completed, records) => {
      completed.completion = {
        version: 1,
        runIdentity: state.runIdentity,
        approvedProposalDigest: approvedDigest,
        verificationContractDigest: verificationContractDigest(proposal),
        candidateTree,
        auditCursor: { sequence: records.at(-1)!.sequence, digest: records.at(-1)!.digest },
        evidence: proposal.verificationRequirements.map((requirement) => {
          const evidence = completed.verificationEvidence.find((item) => item.requirementId === requirement.id && item.status === "satisfied");
          if (!evidence) throw new ProductionTurnProtocolError(`COMPLETION_EVIDENCE_MISSING: ${requirement.id}`);
          return { requirementId: requirement.id, sequence: evidence.auditSequence, recordDigest: evidence.auditRecordDigest };
        }),
        resultDeliveryReceiptDigest: deliveryDigest,
        resultCommit: options.delivery.resultSha,
        resultTree: options.delivery.resultTreeSha,
        completedAt: new Date().toISOString(),
      };
    },
  );
  options.events?.emit({ type: "completion_verified", resultCommit: options.delivery.resultSha, resultTree: options.delivery.resultTreeSha });
  return { ...toResult(committed.state), delivery: options.delivery };
}

function validateFinalizationAudit(state: ProductionAgentState, records: AuditRecord[]): void {
  const terminal = records.filter((record) => record.type === "tool_terminal");
  if (terminal.length !== state.counters.toolCalls) {
    throw new ProductionTurnProtocolError("AUDIT_TOOL_COUNT_MISMATCH: committed tool calls do not match terminal audit records.");
  }
  const bySequence = new Map(records.map((record) => [record.sequence, record]));
  for (const evidence of state.verificationEvidence.filter((item) => item.status === "satisfied")) {
    const verification = bySequence.get(evidence.auditSequence);
    const tool = terminal.find((record) => record.operationId === evidence.operationId);
    if (!verification || evidence.proposalDigest !== state.approval.approvedProposalDigest || verification.digest !== evidence.auditRecordDigest || verification.type !== "verification_updated" || verification.operationId !== evidence.operationId || verification.approvedProposalDigest !== evidence.proposalDigest || verification.payload.requirementId !== evidence.requirementId || verification.payload.satisfied !== true || verification.payload.exitCode !== 0 || verification.payload.timedOut === true || verification.payload.gitCleanBefore !== true || verification.payload.gitCleanAfter !== true || verification.payload.gitCommitBefore !== evidence.candidateCommit || verification.payload.gitCommitAfter !== evidence.candidateCommit || verification.payload.gitTreeBefore !== evidence.candidateTree || verification.payload.gitTreeAfter !== evidence.candidateTree || JSON.stringify(verification.payload.screenshotHashes ?? []) !== JSON.stringify(evidence.screenshots.map((item) => item.sha256)) || JSON.stringify(verification.payload.screenshotPaths ?? []) !== JSON.stringify(evidence.screenshots.map((item) => item.path)) || JSON.stringify(verification.payload.screenshotRoutes ?? []) !== JSON.stringify(evidence.screenshots.map((item) => item.route)) || JSON.stringify(verification.payload.screenshotWidths ?? []) !== JSON.stringify(evidence.screenshots.map((item) => item.width)) || JSON.stringify(verification.payload.screenshotHeights ?? []) !== JSON.stringify(evidence.screenshots.map((item) => item.height)) || !tool || tool.payload.verificationRequirementId !== evidence.requirementId) {
      throw new ProductionTurnProtocolError(`COMPLETION_EVIDENCE_AUDIT_MISMATCH: ${evidence.requirementId}`);
    }
  }
}

function completionCandidateTree(state: ProductionAgentState): string {
  const trees = new Set(state.verificationEvidence.filter((item) => item.status === "satisfied" && item.candidateTree).map((item) => item.candidateTree!));
  if (trees.size !== 1) throw new ProductionTurnProtocolError("COMPLETION_EVIDENCE_TREE_MISMATCH: required evidence does not identify one candidate tree.");
  return [...trees][0]!;
}

function auditJournalFor(options: ProductionLoopOptions): AuditJournal {
  if (options.auditJournal) return options.auditJournal;
  return auditJournalForCheckpoint(options.checkpointStore, options.canonicalRepoPath);
}

export function auditJournalForCheckpoint(checkpointStore: ProductionCheckpointStore, canonicalRepoPath: string): AuditJournal {
  if (checkpointStore instanceof FileProductionCheckpointStore) return new FileAuditJournal(canonicalRepoPath);
  const key = checkpointStore as object;
  const existing = memoryAuditJournals.get(key);
  if (existing) return existing;
  const journal = new MemoryAuditJournal();
  memoryAuditJournals.set(key, journal);
  return journal;
}

function verificationContractError(
  state: ProductionAgentState,
  request: ModelToolRequest,
): { code: string; message: string } | null {
  if (request.name !== "run_shell" && request.name !== "verify_viewport") return null;
  if (request.name === "run_shell" && !request.input.verificationRequirementId) return null;
  const proposal = state.approval.currentProposal;
  const requirement = proposal?.verificationRequirements.find((item) => item.id === request.input.verificationRequirementId);
  if (request.name === "verify_viewport") {
    if (!proposal || state.approval.approvedProposalDigest !== state.approval.proposalDigest || !requirement || requirement.type !== "viewport") {
      return { code: "VERIFICATION_REQUIREMENT_INVALID", message: `Verification requirement "${request.input.verificationRequirementId}" is not an approved viewport requirement.` };
    }
    return null;
  }
  if (!proposal || state.approval.approvedProposalDigest !== state.approval.proposalDigest || !requirement || requirement.type !== "command") {
    return { code: "VERIFICATION_REQUIREMENT_INVALID", message: `Verification requirement "${request.input.verificationRequirementId}" is not an approved command requirement.` };
  }
  if (
    request.input.command !== requirement.command ||
    request.input.cwd !== requirement.workingDirectory ||
    request.input.timeoutMs !== requirement.timeoutMs
  ) {
    return { code: "VERIFICATION_CONTRACT_MISMATCH", message: `Verification requirement "${requirement.id}" must use its exact approved command, working directory, and timeout.` };
  }
  return null;
}

function eventEvidenceSummary(state: ProductionAgentState) {
  const statuses = Object.fromEntries(state.verificationEvidence.map((item) => [item.requirementId, item.status])) as Record<string, "satisfied" | "failed" | "stale">;
  const latestProblem = [...state.verificationEvidence].reverse().find((item) => item.status !== "satisfied");
  const candidateTrees = new Set(state.verificationEvidence.filter((item) => item.status === "satisfied" && item.candidateTree).map((item) => item.candidateTree!));
  return {
    statuses,
    satisfied: Object.values(statuses).filter((status) => status === "satisfied").length,
    total: state.approval.currentProposal?.verificationRequirements.length ?? 0,
    ...(latestProblem ? { latestProblem: `${latestProblem.requirementId}: ${latestProblem.status}` } : {}),
    ...(candidateTrees.size === 1 ? { candidateTree: [...candidateTrees][0]! } : {}),
    ...(state.completion ? { deliveredCommit: state.completion.resultCommit } : {}),
    completed: state.lifecycle === "completed" && state.legacyCompletionStatus === "verified",
  };
}

function toolAuditedEvent(record: AuditRecord): AgentEventInput {
  return {
    type: "tool_audited",
    operationId: record.operationId!,
    auditSequence: record.sequence,
    auditDigest: record.digest,
    detail: {
      errorCode: typeof record.payload.errorCode === "string" ? record.payload.errorCode : null,
      exitCode: typeof record.payload.exitCode === "number" ? record.payload.exitCode : null,
      timedOut: record.payload.timedOut === true,
      outputDigest: typeof record.payload.outputDigest === "string" ? record.payload.outputDigest : "",
    },
  };
}

function approvedViewportRequirement(state: ProductionAgentState, requirementId: string) {
  const requirement = state.approval.currentProposal?.verificationRequirements.find((item) => item.id === requirementId);
  return requirement?.type === "viewport" ? requirement : undefined;
}

function failedToolResult(code: string, message: string): NonNullable<ProductionAgentState["lastToolResult"]> {
  return {
    success: false,
    output: message,
    truncated: false,
    originalTokenCount: 0,
    codec: "runtime",
    metadata: { code, exitCode: null, timedOut: false },
  };
}

function toolAuditDraft(
  operationId: string,
  request: ModelToolRequest,
  result: NonNullable<ProductionAgentState["lastToolResult"]>,
  durationMs: number,
) {
  const metadata = result.metadata ?? {};
  const sensitiveDigest = request.name === "run_shell"
    ? redactedDigest(request.input.command)
    : request.name === "ripgrep"
      ? redactedDigest(request.input.pattern)
      : request.name === "edit_file"
        ? redactedDigest(`${request.input.oldText ?? ""}\u0000${request.input.newText}`)
        : request.name === "git" && request.input.subcommand === "commit"
          ? redactedDigest(request.input.message)
          : request.name === "verify_viewport" ? redactedDigest(request.input.verificationRequirementId) : null;
  return {
    type: "tool_terminal" as const,
    operationId,
    payload: {
      toolName: request.name,
      summary: safeToolSummary(request),
      durationMs,
      success: result.success,
      outputDigest: redactedDigest(result.output),
      outputBytes: new TextEncoder().encode(result.output).byteLength,
      outputTokens: result.originalTokenCount,
      truncated: result.truncated,
      errorCode: typeof metadata.code === "string" ? metadata.code : null,
      exitCode: typeof metadata.exitCode === "number" ? metadata.exitCode : null,
      timedOut: metadata.timedOut === true,
      verificationRequirementId: request.name === "run_shell" ? request.input.verificationRequirementId ?? null : request.name === "verify_viewport" ? request.input.verificationRequirementId : null,
      sensitiveArgumentsDigest: sensitiveDigest,
    },
  };
}

function verificationAuditDraft(
  state: ProductionAgentState,
  operationId: string,
  requirementId: string,
  result: NonNullable<ProductionAgentState["lastToolResult"]>,
) {
  const metadata = result.metadata ?? {};
  let satisfied = result.success && metadata.exitCode === 0 && metadata.timedOut !== true && metadata.gitCleanBefore === true && metadata.gitCleanAfter === true && metadata.gitCommitBefore === metadata.gitCommitAfter && metadata.gitTreeBefore === metadata.gitTreeAfter;
  const screenshots = parseViewportManifest(metadata.viewportManifest);
  const viewport = approvedViewportRequirement(state, requirementId);
  if (viewport) {
    satisfied = satisfied && screenshots.length === viewport.cases.length && screenshots.every((screenshot, index) => {
      const approved = viewport.cases[index];
      return !!approved && screenshot.route === approved.route && screenshot.width === approved.width && screenshot.height === approved.height;
    });
  }
  return {
    type: "verification_updated" as const,
    operationId,
    payload: {
      requirementId,
      success: result.success,
      satisfied,
      errorCode: satisfied ? null : viewport && screenshots.length > 0 && result.success ? "VIEWPORT_CASE_MISMATCH" : verificationFailureCode(result),
      exitCode: typeof result.metadata?.exitCode === "number" ? result.metadata.exitCode : null,
      timedOut: result.metadata?.timedOut === true,
      screenshotHashes: screenshots.map((item) => item.sha256),
      screenshotPaths: screenshots.map((item) => item.path),
      screenshotRoutes: screenshots.map((item) => item.route),
      screenshotWidths: screenshots.map((item) => item.width),
      screenshotHeights: screenshots.map((item) => item.height),
      gitCommitBefore: typeof metadata.gitCommitBefore === "string" ? metadata.gitCommitBefore : null,
      gitCommitAfter: typeof metadata.gitCommitAfter === "string" ? metadata.gitCommitAfter : null,
      gitTreeBefore: typeof metadata.gitTreeBefore === "string" ? metadata.gitTreeBefore : null,
      gitTreeAfter: typeof metadata.gitTreeAfter === "string" ? metadata.gitTreeAfter : null,
      gitCleanBefore: metadata.gitCleanBefore === true,
      gitCleanAfter: metadata.gitCleanAfter === true,
    },
  };
}

function withStaleEvidence(
  state: ProductionAgentState,
  request: ModelToolRequest,
  result: NonNullable<ProductionAgentState["lastToolResult"]>,
): ProductionAgentState {
  const metadata = result.metadata ?? {};
  const verifiedUnchangedTree = ((request.name === "run_shell" && !!request.input.verificationRequirementId) || request.name === "verify_viewport") &&
    result.success && metadata.exitCode === 0 && metadata.timedOut !== true &&
    metadata.gitCleanBefore === true && metadata.gitCleanAfter === true &&
    metadata.gitCommitBefore === metadata.gitCommitAfter && metadata.gitTreeBefore === metadata.gitTreeAfter;
  if (!isMutatingToolCall(request) || verifiedUnchangedTree) return state;
  return {
    ...state,
    verificationEvidence: state.verificationEvidence.map((evidence) => evidence.status === "satisfied"
      ? { ...evidence, status: "stale" as const, errorCode: "POST_CHECK_MUTATION" }
      : evidence),
  };
}

function installVerificationEvidence(
  state: ProductionAgentState,
  request: ModelToolRequest,
  result: NonNullable<ProductionAgentState["lastToolResult"]>,
  record: AuditRecord,
): void {
  if (request.name !== "run_shell" && request.name !== "verify_viewport") return;
  const requirementId = request.input.verificationRequirementId;
  if (!requirementId) return;
  if (!state.approval.approvedProposalDigest) return;
  const metadata = result.metadata ?? {};
  const commitBefore = typeof metadata.gitCommitBefore === "string" ? metadata.gitCommitBefore : null;
  const commitAfter = typeof metadata.gitCommitAfter === "string" ? metadata.gitCommitAfter : null;
  const treeBefore = typeof metadata.gitTreeBefore === "string" ? metadata.gitTreeBefore : null;
  const treeAfter = typeof metadata.gitTreeAfter === "string" ? metadata.gitTreeAfter : null;
  const exitCode = typeof metadata.exitCode === "number" ? metadata.exitCode : null;
  const timedOut = metadata.timedOut === true;
  let satisfied = result.success && exitCode === 0 && !timedOut && metadata.gitCleanBefore === true && metadata.gitCleanAfter === true && commitBefore === commitAfter && treeBefore === treeAfter;
  let screenshots: NonNullable<ProductionAgentState["verificationEvidence"][number]>["screenshots"] = [];
  if (request.name === "verify_viewport" && typeof metadata.viewportManifest === "string") {
    screenshots = parseViewportManifest(metadata.viewportManifest);
    const requirement = approvedViewportRequirement(state, requirementId);
    satisfied = satisfied && !!requirement && screenshots.length === requirement.cases.length && screenshots.every((screenshot, index) => {
      const approved = requirement.cases[index];
      return !!approved && screenshot.route === approved.route && screenshot.width === approved.width && screenshot.height === approved.height;
    });
  } else if (request.name === "verify_viewport") {
    satisfied = false;
  }
  const evidence = {
    requirementId,
    operationId: record.operationId!,
    auditSequence: record.sequence,
    auditRecordDigest: record.digest,
    proposalDigest: state.approval.approvedProposalDigest!,
    candidateCommit: commitAfter,
    candidateTree: treeAfter,
    status: satisfied ? "satisfied" as const : "failed" as const,
    errorCode: satisfied
      ? null
      : request.name === "verify_viewport" && screenshots.length === 0 && result.success
        ? "VIEWPORT_SCREENSHOT_MISSING"
        : request.name === "verify_viewport" && screenshots.length > 0
          ? "VIEWPORT_CASE_MISMATCH"
          : verificationFailureCode(result),
    exitCode,
    timedOut,
    screenshots,
  };
  state.verificationEvidence = [
    ...state.verificationEvidence.filter((item) => item.requirementId !== evidence.requirementId),
    evidence,
  ];
}

function parseViewportManifest(value: unknown): NonNullable<ProductionAgentState["verificationEvidence"][number]>["screenshots"] {
  if (typeof value !== "string") return [];
  try {
    return ScreenshotEvidenceSchema.array().max(12).parse(JSON.parse(value));
  } catch {
    return [];
  }
}

function verificationFailureCode(result: NonNullable<ProductionAgentState["lastToolResult"]>): string {
  const metadata = result.metadata ?? {};
  if (typeof metadata.code === "string") return metadata.code;
  if (metadata.timedOut === true) return "VERIFICATION_TIMEOUT";
  if (metadata.exitCode !== 0) return "VERIFICATION_EXIT_NONZERO";
  if (metadata.gitCleanBefore !== true || metadata.gitCleanAfter !== true) return "VERIFICATION_DIRTY_TREE";
  if (metadata.gitTreeBefore !== metadata.gitTreeAfter) return "VERIFICATION_TREE_CHANGED";
  return "VERIFICATION_FAILED";
}

function completionEvidenceMissing(state: ProductionAgentState): string[] {
  if (state.approval.legacyTerminal) return [];
  const proposal = state.approval.currentProposal;
  if (!proposal || !state.approval.approvedProposalDigest) return ["approved-proposal"];
  const satisfying = proposal.verificationRequirements.map((requirement) => ({
    requirement,
    evidence: state.verificationEvidence.find((item) => item.requirementId === requirement.id),
  }));
  const missing = satisfying.filter(({ evidence }) =>
    !evidence || evidence.status !== "satisfied" || evidence.proposalDigest !== state.approval.approvedProposalDigest || !evidence.candidateTree,
  ).map(({ requirement }) => requirement.id);
  const trees = new Set(satisfying.flatMap(({ evidence }) => evidence?.status === "satisfied" && evidence.candidateTree ? [evidence.candidateTree] : []));
  if (trees.size > 1) return [...new Set([...missing, ...satisfying.map(({ requirement }) => requirement.id)])];
  return missing;
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

function proposalInputSchema(): ModelToolDefinition["inputSchema"] {
  return {
    type: "object",
    properties: {
      approach: { type: "string" },
      productDirection: { type: "string" },
      visualDirection: { type: "string" },
      technologyChoices: { type: "array", items: { type: "object", properties: { name: { type: "string" }, rationale: { type: "string" } }, required: ["name", "rationale"], additionalProperties: false } },
      includedScope: { type: "array", items: { type: "string" } },
      excludedScope: { type: "array", items: { type: "string" } },
      acceptanceCriteria: { type: "array", items: { type: "object", properties: { id: { type: "string" }, criterion: { type: "string" }, verification: { type: "string" }, verificationRequirementIds: { type: "array", items: { type: "string" } } }, required: ["id", "criterion", "verification", "verificationRequirementIds"], additionalProperties: false } },
      verificationRequirements: {
        type: "array",
        items: {
          oneOf: [
            { type: "object", properties: { type: { const: "command" }, id: { type: "string" }, label: { type: "string" }, workingDirectory: { type: "string" }, command: { type: "string" }, timeoutMs: { type: "integer", minimum: 1, maximum: 30000 } }, required: ["type", "id", "label", "workingDirectory", "command", "timeoutMs"], additionalProperties: false },
            { type: "object", properties: { type: { const: "viewport" }, id: { type: "string" }, label: { type: "string" }, workingDirectory: { type: "string" }, serverCommand: { type: "string" }, port: { type: "integer", minimum: 1024, maximum: 65535 }, cases: { type: "array", items: { type: "object", properties: { route: { type: "string" }, width: { type: "integer" }, height: { type: "integer" }, requiredVisibleSelectors: { type: "array", items: { type: "string" } } }, required: ["route", "width", "height", "requiredVisibleSelectors"], additionalProperties: false } } }, required: ["type", "id", "label", "workingDirectory", "serverCommand", "port", "cases"], additionalProperties: false },
          ],
        },
      },
      assumptions: { type: "array", items: { type: "string" } },
      unresolvedQuestions: { type: "array", items: { type: "string" } },
      executionPlan: { type: "array", items: { type: "object", properties: { id: { type: "string" }, description: { type: "string" } }, required: ["id", "description"], additionalProperties: false } },
    },
    required: ["approach", "productDirection", "visualDirection", "technologyChoices", "includedScope", "excludedScope", "acceptanceCriteria", "verificationRequirements", "assumptions", "unresolvedQuestions", "executionPlan"],
    additionalProperties: false,
  };
}
