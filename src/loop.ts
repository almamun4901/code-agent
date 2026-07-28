import {
  createAnthropicModel,
  type AssistantBlock,
  type CallModel,
  type ConversationMessage,
  type ModelRequest,
  type ModelToolDefinition,
  type ModelTurn,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./model/anthropic";
import {
  fakeReadFile,
  type FakeReadFileResult,
} from "./tools/fake-read-file";
import {
  TodoWriteInputSchema,
  type AgentStateV1,
  type TaskStatus,
  type TodoItem,
} from "./plan/schema";
import {
  FileCheckpointStore,
  IncompatibleCheckpointError,
  MemoryCheckpointStore,
  MissingCheckpointError,
  type CheckpointStore,
  type StartupPolicy,
} from "./state/checkpoint";

export type PlanTask = TodoItem;
export type { AgentStateV1, CheckpointStore, StartupPolicy, TaskStatus };
export { MemoryCheckpointStore };

type TaskDefinition = {
  id: string;
  description: string;
  path: string;
};

export type ValidatedTurn = {
  plan: PlanTask[];
  planTool: ToolUseBlock;
  readTool: ToolUseBlock | null;
  readPath: string | null;
};

export type LoopResult = {
  status: "completed";
  modelTurns: number;
  acceptedTurns: number;
  protocolRetries: number;
  readCalls: number;
  planRewrites: number;
  inputTokens: number;
  outputTokens: number;
  plan: PlanTask[];
  transcript: ConversationMessage[];
};

export type LoopOptions = {
  callModel: CallModel;
  readFile?: (path: string) => FakeReadFileResult;
  maxModelTurns?: number;
  logger?: (message: string) => void;
  checkpointStore?: CheckpointStore;
  repoPath?: string;
  startupPolicy?: StartupPolicy;
};

export class TurnProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnProtocolError";
  }
}

export class LoopLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopLimitError";
  }
}

export const PHASE_ONE_TASKS: readonly TaskDefinition[] = [
  {
    id: "inspect-package",
    description: "Inspect the package manifest",
    path: "package.json",
  },
  {
    id: "inspect-loop",
    description: "Inspect the agent loop",
    path: "src/loop.ts",
  },
  {
    id: "inspect-tests",
    description: "Inspect the loop tests",
    path: "tests/loop.test.ts",
  },
] as const;

export const PHASE_ONE_RUN_IDENTITY = "phase-1-fixtures-v1";

export const SYSTEM_PROMPT = [
  "You are driving Phase 1 of a terminal coding agent through a strict tool protocol.",
  "",
  "Fixture path mapping (fixed for this session):",
  ...PHASE_ONE_TASKS.map((task) => `- ${task.id}: ${task.path}`),
  "",
  "On every response:",
  "1. Call rewrite_plan exactly once and place it before every other tool call.",
  "2. Include all three plan tasks in their original order. Copy each id and",
  "   description verbatim from the current plan; only status may change.",
  "3. Each turn may complete at most one task. After a successful read, mark",
  "   that task completed and, if work remains, move exactly the next pending",
  "   task to in_progress in the same rewrite.",
  "4. Complete a task if and only if that task's successful read_file result",
  "   appeared in the immediately preceding message. Otherwise leave every",
  "   task's completion status unchanged this turn.",
  "5. If the preceding read failed, keep that task in_progress and call",
  "   read_file again with the same path next turn.",
  "6. Keep completed tasks first, followed by exactly one in_progress task,",
  "   followed by pending tasks.",
  "7. If work remains, call read_file exactly once, using the exact path listed",
  "   above for the current in_progress task. Never invent, guess, or modify a path.",
  "8. Once all three tasks are completed, call only rewrite_plan with every",
  "   task marked completed, and do not call read_file.",
  "",
  "Do not call an unknown tool, call read_file more than once per turn, or",
  "omit rewrite_plan. You may include brief reasoning text alongside your",
  "tool calls, but every response must still contain the required tool calls.",
].join("\n");

const INITIAL_USER_PROMPT = [
  "Begin the plan. Inspect each fixture in order, following the system protocol.",
  "This is the authoritative current plan. Copy every id and description exactly; only status may change:",
  JSON.stringify(createInitialPlan()),
].join("\n");

export const PHASE_ONE_TOOLS: ModelToolDefinition[] = [
  {
    name: "rewrite_plan",
    description:
      "Replace the entire current plan. This must be the first tool call in every response.",
    strict: true,
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          type: "array",
          description:
            "The complete three-task Phase 1 plan. Local validation enforces the exact task count, identities, order, and legal state transition.",
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
  {
    name: "read_file",
    description:
      "Read one Phase 1 fixture. Call it only after rewrite_plan and only for the current in-progress task.",
    strict: true,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "A non-empty path for the current Phase 1 fixture. Local validation enforces the exact expected path.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

/**
 * Run the real-model/fake-tool Phase 1 loop.
 *
 * A model turn is validated in full before the plan changes or a tool runs.
 * This makes the single protocol retry safe: rejected output has no side
 * effects and never enters the provider transcript.
 */
export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const readFile = options.readFile ?? fakeReadFile;
  const maxModelTurns = options.maxModelTurns ?? 8;
  const logger = options.logger ?? console.log;
  const checkpointStore =
    options.checkpointStore ??
    new FileCheckpointStore(options.repoPath ?? process.cwd());
  const startupPolicy = options.startupPolicy ?? "auto";
  let state = await initializeState(checkpointStore, startupPolicy);

  if (state.lifecycle === "failed") {
    throw new TurnProtocolError(
      `Checkpoint contains a terminal protocol failure: ${state.terminalError ?? "unknown failure"}`,
    );
  }

  if (state.lifecycle === "completed") {
    const completedResult = toLoopResult(state);
    printSummary(completedResult, logger);
    return completedResult;
  }

  while (!isPlanComplete(state.plan)) {
    if (state.counters.modelTurns >= maxModelTurns) {
      throw new LoopLimitError(
        `Maximum model turn limit of ${maxModelTurns} exceeded.`,
      );
    }

    const modelTurnNumber = state.counters.modelTurns + 1;
    logger(`\n=== MODEL TURN ${modelTurnNumber} ===`);

    const turn = await options.callModel(
      createModelRequest(state.transcript),
    );
    const countersAfterModel = {
      ...state.counters,
      modelTurns: modelTurnNumber,
      inputTokens: state.counters.inputTokens + turn.usage.inputTokens,
      outputTokens: state.counters.outputTokens + turn.usage.outputTokens,
    };

    let validated: ValidatedTurn;

    try {
      validated = validateTurn(
        turn,
        state.plan,
        state.lastReadSucceeded,
      );
    } catch (error) {
      if (!(error instanceof TurnProtocolError)) {
        throw error;
      }

      if (state.consecutiveInvalidAttempts >= 1) {
        const terminalError =
          `Model violated the turn protocol twice: ${error.message}`;
        state = {
          ...state,
          lifecycle: "failed",
          counters: countersAfterModel,
          terminalError,
        };
        await checkpointStore.save(state);
        throw new TurnProtocolError(terminalError);
      }

      logger(`PROTOCOL RETRY: ${error.message}`);
      state = {
        ...state,
        counters: {
          ...countersAfterModel,
          protocolRetries: countersAfterModel.protocolRetries + 1,
        },
        consecutiveInvalidAttempts: state.consecutiveInvalidAttempts + 1,
        terminalError: null,
        transcript: [
          ...state.transcript,
          {
          role: "user",
          content:
            `Your previous response was rejected without executing any tool: ${error.message} ` +
            "Reminder: call rewrite_plan first with all three tasks, unchanged ids and " +
            "descriptions, and advance only according to the most recent read result. " +
            "Then call read_file with the exact path for the current in_progress task, " +
            "unless the plan is fully complete.",
          },
        ],
      };
      await checkpointStore.save(state);
      continue;
    }

    const nextPlan = validated.plan;
    let lastReadSucceeded: boolean | null = null;
    let readCallIncrement = 0;

    const results: ToolResultBlock[] = [
      {
        type: "tool_result",
        toolUseId: validated.planTool.id,
        content: JSON.stringify({
          accepted: true,
          completedTasks: countCompleted(nextPlan),
          totalTasks: nextPlan.length,
        }),
      },
    ];

    logger("PLAN");
    for (const task of nextPlan) {
      const marker = task.status === "completed" ? "x" : " ";
      logger(`  [${marker}] ${task.description} (${task.status})`);
    }

    if (validated.readTool && validated.readPath) {
      readCallIncrement = 1;
      const readResult = readFile(validated.readPath);
      lastReadSucceeded = readResult.success;
      results.push({
        type: "tool_result",
        toolUseId: validated.readTool.id,
        content: readResult.content,
        isError: !readResult.success,
      });
      logger(`ACT: read_file ${validated.readPath}`);
      logger(`OBSERVE: ${readResult.success ? "success" : "failure"}`);
    }

    state = {
      ...state,
      lifecycle: isPlanComplete(nextPlan) ? "completed" : "running",
      plan: nextPlan,
      lastReadSucceeded,
      consecutiveInvalidAttempts: 0,
      terminalError: null,
      counters: {
        ...countersAfterModel,
        committedTurns: countersAfterModel.committedTurns + 1,
        readCalls: countersAfterModel.readCalls + readCallIncrement,
        planRewrites: countersAfterModel.planRewrites + 1,
      },
      transcript: [
        ...state.transcript,
        { role: "assistant", content: turn.content },
        { role: "user", content: results },
      ],
    };
    await checkpointStore.save(state);
  }

  const result = toLoopResult(state);
  printSummary(result, logger);
  return result;
}

async function initializeState(
  checkpointStore: CheckpointStore,
  startupPolicy: StartupPolicy,
): Promise<AgentStateV1> {
  const existing =
    startupPolicy === "fresh" ? null : await checkpointStore.load();

  if (startupPolicy === "required" && !existing) {
    const path =
      checkpointStore instanceof FileCheckpointStore
        ? checkpointStore.statePath
        : "<checkpoint store>";
    throw new MissingCheckpointError(path);
  }

  if (existing) {
    validateRecoveredState(existing);
    return existing;
  }

  const initialState: AgentStateV1 = {
    version: 1,
    runIdentity: PHASE_ONE_RUN_IDENTITY,
    lifecycle: "running",
    plan: createInitialPlan(),
    transcript: [{ role: "user", content: INITIAL_USER_PROMPT }],
    lastReadSucceeded: null,
    counters: {
      modelTurns: 0,
      committedTurns: 0,
      protocolRetries: 0,
      readCalls: 0,
      planRewrites: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    consecutiveInvalidAttempts: 0,
    terminalError: null,
  };
  await checkpointStore.save(initialState);
  return initialState;
}

function validateRecoveredState(state: AgentStateV1): void {
  if (state.runIdentity !== PHASE_ONE_RUN_IDENTITY) {
    throw new IncompatibleCheckpointError(
      `Checkpoint run identity "${state.runIdentity}" does not match "${PHASE_ONE_RUN_IDENTITY}".`,
    );
  }

  if (!isPristineInitialPlan(state)) {
    try {
      validatePlanShape(state.plan);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid plan";
      throw new IncompatibleCheckpointError(
        `Checkpoint plan is incompatible with this run: ${message}`,
      );
    }
  }

  if (state.lifecycle === "completed" && !isPlanComplete(state.plan)) {
    throw new IncompatibleCheckpointError(
      "Checkpoint lifecycle is completed, but its plan is incomplete.",
    );
  }
  if (state.lifecycle === "running" && isPlanComplete(state.plan)) {
    throw new IncompatibleCheckpointError(
      "Checkpoint lifecycle is running, but its plan is complete.",
    );
  }
  if (state.lifecycle === "failed" && !state.terminalError) {
    throw new IncompatibleCheckpointError(
      "Checkpoint lifecycle is failed, but no terminal error is recorded.",
    );
  }
  if (state.lifecycle !== "failed" && state.terminalError) {
    throw new IncompatibleCheckpointError(
      "Checkpoint records a terminal error without a failed lifecycle.",
    );
  }

  validateCheckpointConsistency(state);
}

function validateCheckpointConsistency(state: AgentStateV1): void {
  const [initialMessage] = state.transcript;
  if (
    !initialMessage ||
    initialMessage.role !== "user" ||
    initialMessage.content !== INITIAL_USER_PROMPT
  ) {
    throw new IncompatibleCheckpointError(
      "Checkpoint does not contain the canonical initial request.",
    );
  }

  let committedTurns = 0;
  let planRewrites = 0;
  let protocolRetries = 0;
  let readCalls = 0;
  let lastReadSucceeded: boolean | null = null;
  let latestPlan: PlanTask[] | null = null;
  let historicalPlan = createInitialPlan();
  let historicalObservation: boolean | null = null;

  for (let index = 1; index < state.transcript.length; index += 1) {
    const message = state.transcript[index];
    if (!message) {
      throw new IncompatibleCheckpointError(
        "Checkpoint transcript contains a missing message.",
      );
    }

    if (message.role === "user" && typeof message.content === "string") {
      if (
        !message.content.startsWith(
          "Your previous response was rejected without executing any tool:",
        )
      ) {
        throw new IncompatibleCheckpointError(
          "Checkpoint transcript contains an unknown user correction.",
        );
      }
      protocolRetries += 1;
      continue;
    }

    if (message.role !== "assistant") {
      throw new IncompatibleCheckpointError(
        "Checkpoint contains tool results without a preceding assistant turn.",
      );
    }

    const resultMessage = state.transcript[index + 1];
    if (
      !resultMessage ||
      resultMessage.role !== "user" ||
      !Array.isArray(resultMessage.content) ||
      resultMessage.content.some((block) => block.type !== "tool_result")
    ) {
      throw new IncompatibleCheckpointError(
        "Checkpoint assistant turn is missing its correlated tool results.",
      );
    }
    const resultBlocks = resultMessage.content;

    const toolCalls = message.content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use",
    );
    const planCalls = toolCalls.filter(
      (block) => block.name === "rewrite_plan",
    );
    const readToolCalls = toolCalls.filter(
      (block) => block.name === "read_file",
    );
    const [planCall] = planCalls;
    if (
      planCalls.length !== 1 ||
      !planCall ||
      toolCalls[0] !== planCall ||
      readToolCalls.length > 1 ||
      toolCalls.length !== resultBlocks.length ||
      toolCalls.some(
        (toolCall, toolIndex) => {
          const resultBlock = resultBlocks[toolIndex];
          return (
            resultBlock?.type !== "tool_result" ||
            resultBlock.toolUseId !== toolCall.id
          );
        },
      )
    ) {
      throw new IncompatibleCheckpointError(
        "Checkpoint tool calls and results are not exactly correlated.",
      );
    }

    const parsedPlan = TodoWriteInputSchema.safeParse(planCall.input);
    if (!parsedPlan.success) {
      throw new IncompatibleCheckpointError(
        "Checkpoint transcript contains an invalid historical plan rewrite.",
      );
    }
    try {
      validateTurn(
        {
          content: message.content,
          stopReason: "tool_use",
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        historicalPlan,
        historicalObservation,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid turn";
      throw new IncompatibleCheckpointError(
        `Checkpoint contains an invalid historical model turn: ${detail}`,
      );
    }

    latestPlan = parsedPlan.data.plan;
    historicalPlan = latestPlan;
    committedTurns += 1;
    planRewrites += 1;
    const readTool = readToolCalls[0];
    if (readTool) {
      readCalls += 1;
      const resultIndex = toolCalls.indexOf(readTool);
      const readResult = resultBlocks[resultIndex];
      if (!readResult || readResult.type !== "tool_result") {
        throw new IncompatibleCheckpointError(
          "Checkpoint read call is missing its observation.",
        );
      }
      lastReadSucceeded = readResult.isError !== true;
    } else {
      lastReadSucceeded = null;
    }
    historicalObservation = lastReadSucceeded;

    index += 1;
  }

  const terminalAttempts = state.lifecycle === "failed" ? 1 : 0;

  if (
    state.counters.committedTurns !== committedTurns ||
    state.counters.planRewrites !== planRewrites
  ) {
    throw new IncompatibleCheckpointError(
      "Checkpoint committed-turn, plan-rewrite, and transcript counts disagree.",
    );
  }
  if (state.counters.protocolRetries !== protocolRetries) {
    throw new IncompatibleCheckpointError(
      "Checkpoint retry count does not match its correction transcript.",
    );
  }
  if (
    state.counters.modelTurns !==
    state.counters.committedTurns +
      state.counters.protocolRetries +
      terminalAttempts
  ) {
    throw new IncompatibleCheckpointError(
      "Checkpoint model-turn accounting is inconsistent.",
    );
  }

  if (state.counters.readCalls !== readCalls) {
    throw new IncompatibleCheckpointError(
      "Checkpoint read count does not match its tool-result transcript.",
    );
  }

  const expectedTranscriptLength =
    1 +
    state.counters.committedTurns * 2 +
    state.counters.protocolRetries;
  if (state.transcript.length !== expectedTranscriptLength) {
    throw new IncompatibleCheckpointError(
      "Checkpoint transcript length is inconsistent with its counters.",
    );
  }
  if (
    latestPlan &&
    JSON.stringify(latestPlan) !== JSON.stringify(state.plan)
  ) {
    throw new IncompatibleCheckpointError(
      "Checkpoint plan does not match the latest committed rewrite.",
    );
  }
  if (state.lastReadSucceeded !== lastReadSucceeded) {
    throw new IncompatibleCheckpointError(
      "Checkpoint observation does not match the latest committed tool result.",
    );
  }
  const finalMessage = state.transcript.at(-1);
  const endsWithCorrection =
    finalMessage?.role === "user" &&
    typeof finalMessage.content === "string" &&
    state.transcript.length > 1;
  if (
    (state.consecutiveInvalidAttempts === 1) !== endsWithCorrection
  ) {
    throw new IncompatibleCheckpointError(
      "Checkpoint consecutive-invalid state does not match its transcript.",
    );
  }
  if (
    state.lifecycle === "completed" &&
    (state.counters.committedTurns === 0 ||
      state.lastReadSucceeded !== null ||
      state.consecutiveInvalidAttempts !== 0)
  ) {
    throw new IncompatibleCheckpointError(
      "Completed checkpoint has inconsistent progress or retry state.",
    );
  }
  if (
    state.lifecycle === "failed" &&
    state.consecutiveInvalidAttempts !== 1
  ) {
    throw new IncompatibleCheckpointError(
      "Failed checkpoint does not preserve the exhausted retry state.",
    );
  }
}

function isPristineInitialPlan(state: AgentStateV1): boolean {
  const initialPlan = createInitialPlan();
  return (
    state.counters.committedTurns === 0 &&
    state.lastReadSucceeded === null &&
    state.plan.length === initialPlan.length &&
    state.plan.every(
      (task, index) =>
        task.id === initialPlan[index]?.id &&
        task.description === initialPlan[index]?.description &&
        task.status === "pending",
    )
  );
}

function toLoopResult(state: AgentStateV1): LoopResult {
  return {
    status: "completed",
    modelTurns: state.counters.modelTurns,
    acceptedTurns: state.counters.committedTurns,
    protocolRetries: state.counters.protocolRetries,
    readCalls: state.counters.readCalls,
    planRewrites: state.counters.planRewrites,
    inputTokens: state.counters.inputTokens,
    outputTokens: state.counters.outputTokens,
    plan: state.plan,
    transcript: state.transcript,
  };
}

export function createInitialPlan(): PlanTask[] {
  return PHASE_ONE_TASKS.map(({ id, description }) => ({
    id,
    description,
    status: "pending",
  }));
}

export function validateTurn(
  turn: ModelTurn,
  currentPlan: PlanTask[],
  lastReadSucceeded: boolean | null = null,
): ValidatedTurn {
  if (turn.stopReason !== "tool_use") {
    throw new TurnProtocolError(
      `Expected stop_reason "tool_use", received "${turn.stopReason ?? "null"}".`,
    );
  }

  const toolCalls = turn.content.filter(
    (block): block is ToolUseBlock => block.type === "tool_use",
  );

  if (toolCalls.length === 0) {
    throw new TurnProtocolError("Response did not contain a tool call.");
  }

  const unknownTool = toolCalls.find(
    (block) => block.name !== "rewrite_plan" && block.name !== "read_file",
  );
  if (unknownTool) {
    throw new TurnProtocolError(`Unknown tool "${unknownTool.name}".`);
  }

  const planCalls = toolCalls.filter((block) => block.name === "rewrite_plan");
  const readToolCalls = toolCalls.filter(
    (block) => block.name === "read_file",
  );
  const [planTool] = planCalls;

  if (planCalls.length !== 1 || !planTool) {
    throw new TurnProtocolError(
      `Expected exactly one rewrite_plan call, received ${planCalls.length}.`,
    );
  }
  if (readToolCalls.length > 1) {
    throw new TurnProtocolError(
      `Expected at most one read_file call, received ${readToolCalls.length}.`,
    );
  }
  if (toolCalls[0] !== planTool) {
    throw new TurnProtocolError("rewrite_plan must be the first tool call.");
  }

  const ids = new Set(toolCalls.map((block) => block.id));
  if (
    ids.size !== toolCalls.length ||
    toolCalls.some((block) => !block.id.trim())
  ) {
    throw new TurnProtocolError("Tool-use IDs must be non-empty and unique.");
  }

  const nextPlan = parsePlanInput(planTool.input);
  validatePlanShape(nextPlan);
  validatePlanTransition(currentPlan, nextPlan, lastReadSucceeded);

  const complete = isPlanComplete(nextPlan);
  const readTool = readToolCalls[0] ?? null;

  if (complete && readTool) {
    throw new TurnProtocolError(
      "A completed plan must not include a read_file call.",
    );
  }
  if (!complete && !readTool) {
    throw new TurnProtocolError(
      "An incomplete plan must include exactly one read_file call.",
    );
  }

  let readPath: string | null = null;
  if (readTool) {
    readPath = parseReadPath(readTool.input);
    const activeIndex = nextPlan.findIndex(
      (task) => task.status === "in_progress",
    );
    const expectedPath = PHASE_ONE_TASKS[activeIndex]?.path;
    if (readPath !== expectedPath) {
      throw new TurnProtocolError(
        `read_file path "${readPath}" does not match current task path "${expectedPath}".`,
      );
    }
  }

  return {
    plan: nextPlan,
    planTool,
    readTool,
    readPath,
  };
}

function createModelRequest(
  messages: ConversationMessage[],
): ModelRequest {
  return {
    system: SYSTEM_PROMPT,
    messages,
    tools: PHASE_ONE_TOOLS,
    maxTokens: 2_048,
  };
}

function parsePlanInput(input: unknown): PlanTask[] {
  const parsed = TodoWriteInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new TurnProtocolError(
      `rewrite_plan input failed validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data.plan;
}

function validatePlanShape(plan: PlanTask[]): void {
  if (plan.length !== PHASE_ONE_TASKS.length) {
    throw new TurnProtocolError(
      `Plan must contain ${PHASE_ONE_TASKS.length} tasks.`,
    );
  }

  for (const [index, task] of plan.entries()) {
    const definition = PHASE_ONE_TASKS[index];
    if (!definition) {
      throw new TurnProtocolError(`Plan task ${index + 1} is unexpected.`);
    }
    if (
      task.id !== definition.id ||
      task.description !== definition.description
    ) {
      throw new TurnProtocolError(
        `Plan task ${index + 1} must preserve its original ID and description.`,
      );
    }
  }

  const completedCount = countCompleted(plan);
  const expectedStatuses: TaskStatus[] =
    completedCount === plan.length
      ? plan.map(() => "completed")
      : plan.map((_, index) => {
          if (index < completedCount) return "completed";
          if (index === completedCount) return "in_progress";
          return "pending";
        });

  if (plan.some((task, index) => task.status !== expectedStatuses[index])) {
    throw new TurnProtocolError(
      "Plan statuses must be completed*, then one in_progress, then pending*.",
    );
  }
}

function validatePlanTransition(
  currentPlan: PlanTask[],
  nextPlan: PlanTask[],
  lastReadSucceeded: boolean | null,
): void {
  const currentCompleted = countCompleted(currentPlan);
  const nextCompleted = countCompleted(nextPlan);

  if (nextCompleted < currentCompleted) {
    throw new TurnProtocolError("Completed tasks cannot regress.");
  }
  if (nextCompleted > currentCompleted + 1) {
    throw new TurnProtocolError("A turn cannot complete more than one task.");
  }
  if (lastReadSucceeded === null && nextCompleted !== currentCompleted) {
    throw new TurnProtocolError(
      "A task cannot complete before a successful read observation.",
    );
  }
  if (lastReadSucceeded === true && nextCompleted !== currentCompleted + 1) {
    throw new TurnProtocolError(
      "The task from the preceding successful read must become completed.",
    );
  }
  if (lastReadSucceeded === false && nextCompleted !== currentCompleted) {
    throw new TurnProtocolError(
      "A task with a failed read observation must remain incomplete.",
    );
  }
}

function parseReadPath(input: unknown): string {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["path"]) ||
    typeof input.path !== "string" ||
    !input.path.trim()
  ) {
    throw new TurnProtocolError(
      "read_file input must contain a non-empty path string.",
    );
  }
  return input.path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function countCompleted(plan: PlanTask[]): number {
  return plan.filter((task) => task.status === "completed").length;
}

function isPlanComplete(plan: PlanTask[]): boolean {
  return plan.every((task) => task.status === "completed");
}

function printSummary(
  result: LoopResult,
  logger: (message: string) => void,
): void {
  logger("\nSUMMARY");
  logger(`  Status: ${result.status}`);
  logger(`  Model turns: ${result.modelTurns}`);
  logger(`  Accepted turns: ${result.acceptedTurns}`);
  logger(`  Plan rewrites: ${result.planRewrites}`);
  logger(`  Fake reads: ${result.readCalls}`);
  logger(`  Protocol retries: ${result.protocolRetries}`);
  logger(
    `  Tokens: ${result.inputTokens} input / ${result.outputTokens} output`,
  );
}

async function main(): Promise<void> {
  try {
    await runAgentLoop({ callModel: createAnthropicModel() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    console.error(`\nFAILED: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
