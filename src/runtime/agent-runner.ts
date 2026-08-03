import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CallModel, ModelRuntime } from "../model/contracts";
import { createAnthropicRuntime } from "../model/anthropic";
import { createOpenRouterRuntime } from "../model/openrouter";
import { createInjectedModelRuntime } from "../model/runtime";
import {
  createE2bTaskSession,
  recoverE2bTaskSession,
  type E2bTaskSession,
} from "../sandbox/e2b-session";
import {
  FileE2bSessionRecoveryStore,
  type E2bSessionRecoveryStore,
} from "../sandbox/session-recovery";
import {
  FileResultDeliveryStore,
  loadCompletedResultDelivery,
  type ResultDeliveryStore,
} from "../sandbox/result-delivery";
import {
  FileProductionCheckpointStore,
  type ProductionCheckpointStore,
} from "./checkpoint";
import {
  runProductionLoop,
  prepareProductionLifecycle,
  commitReconciledProductionMutation,
  type ProductionLoopResult,
} from "./production-loop";
import { LifecycleHooks } from "./lifecycle";
import {
  createAgentEventPublisher,
  sanitizeTerminalText,
  type AgentEventPublisher,
  type AgentEventSink,
} from "./events";

const MAX_TASK_BYTES = 32 * 1024;
const SESSION_END_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

export type PreparedAgentRun = {
  canonicalRepoPath: string;
  task: string;
  runIdentity: string;
};

export type AgentModelProvider = "anthropic" | "openrouter";

export type HeadlessAgentRunOptions = {
  repoPath: string;
  task: string;
  templateId?: string;
  signal?: AbortSignal;
  maxModelTurns?: number;
  eventSink?: AgentEventSink;
  modelProvider?: AgentModelProvider;
  callModel?: CallModel;
  modelRuntime?: ModelRuntime;
  hooks?: LifecycleHooks;
  checkpointStore?: ProductionCheckpointStore;
  sessionRecoveryStore?: E2bSessionRecoveryStore;
  resultDeliveryStore?: ResultDeliveryStore;
  openSession?: (context: {
    prepared: PreparedAgentRun;
    recoveryStore: E2bSessionRecoveryStore;
    resultDeliveryStore: ResultDeliveryStore;
    templateId: string;
    signal?: AbortSignal;
  }) => Promise<E2bTaskSession>;
};

export type SessionEndContext = {
  reason: "completed" | "cancelled" | "failed";
  cleanup: "succeeded" | "failed";
  error?: { code: string; message: string };
};

export type AgentRunResult = SessionEndContext & {
  status: SessionEndContext["reason"];
  exitCode: 0 | 1 | 2 | 130;
  productionResult?: ProductionLoopResult;
};

export type AgentRunController = {
  result: Promise<AgentRunResult>;
  stop(reason: "sigint" | "ui" | "runtime"): Promise<AgentRunResult>;
};

export type ControlledAgentRunOptions = HeadlessAgentRunOptions & {
  sessionEnd?: (context: SessionEndContext) => void | Promise<void>;
  sessionEndTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};

export class AgentRunConfigurationError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "AgentRunConfigurationError";
  }
}

export class AgentRunUsageError extends AgentRunConfigurationError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "AgentRunUsageError";
  }
}

export async function prepareAgentRun(
  repoPath: string,
  task: string,
): Promise<PreparedAgentRun> {
  const normalizedTask = task.trim();
  if (!normalizedTask) {
    throw new AgentRunUsageError("Task must not be blank.");
  }
  if (
    new TextEncoder().encode(normalizedTask).byteLength >
    MAX_TASK_BYTES
  ) {
    throw new AgentRunUsageError(
      `Task must not exceed ${MAX_TASK_BYTES} UTF-8 bytes.`,
    );
  }
  if (!path.isAbsolute(repoPath)) {
    throw new AgentRunUsageError(
      "Repository path must be absolute.",
    );
  }

  let canonicalRepoPath: string;
  try {
    const details = await stat(repoPath);
    if (!details.isDirectory()) {
      throw new AgentRunUsageError(
        "Repository path must identify a directory.",
      );
    }
    canonicalRepoPath = await realpath(repoPath);
  } catch (error) {
    if (error instanceof AgentRunUsageError) throw error;
    throw new AgentRunUsageError(
      `Repository path does not exist: ${repoPath}`,
      { cause: error },
    );
  }

  const topLevel = await gitTopLevel(canonicalRepoPath);
  if ((await realpath(topLevel)) !== canonicalRepoPath) {
    throw new AgentRunUsageError(
      "Repository path must be the root of a Git repository.",
    );
  }

  const runIdentity = await sha256(
    `${canonicalRepoPath}\0${normalizedTask}`,
  );
  return { canonicalRepoPath, task: normalizedTask, runIdentity };
}

export async function runHeadlessAgent(
  options: HeadlessAgentRunOptions,
): Promise<ProductionLoopResult> {
  const events = createAgentEventPublisher(options.eventSink);
  let started = false;
  let hooksStarted = false;
  let shutdown = false;
  const beginShutdown = (reason: SessionEndContext["reason"]) => {
    if (shutdown) return;
    shutdown = true;
    if (started) events.emit({ type: "shutdown_started", reason });
  };
  const execution = await executeAgentRun(
    options,
    events,
    (event) => {
      if (event === "run_started") started = true;
      if (event === "hooks_started") hooksStarted = true;
    },
    beginShutdown,
  );
  const reason = execution.cleanupError
    ? "failed"
    : resultReason(
      execution.runError,
      options.signal?.aborted ? "ui" : undefined,
    );
  beginShutdown(reason);
  if (hooksStarted && options.hooks) {
    try {
      await options.hooks.runSessionEnd({
        reason,
        cleanup: execution.cleanupError ? "failed" : "succeeded",
        ...((execution.runError || execution.cleanupError) ? { error: safeError(execution.runError ?? execution.cleanupError, [options.task, options.repoPath]) } : {}),
      });
    } catch (error) {
      execution.cleanupError = execution.cleanupError
        ? new AggregateError([execution.cleanupError, error], "Cleanup and SessionEnd failed.")
        : error;
    }
  }
  if (started) {
    events.emit({
      type: "run_finished",
      ...publicEventContext({
        reason,
        cleanup: execution.cleanupError ? "failed" : "succeeded",
        ...((execution.runError || execution.cleanupError) &&
            (reason === "failed" || execution.cleanupError)
          ? {
              error: safeError(
                execution.runError ?? execution.cleanupError,
                [options.task, options.repoPath],
              ),
            }
          : {}),
      }),
    });
  }
  if (execution.runError && execution.cleanupError) {
    throw new AggregateError(
      [execution.runError, execution.cleanupError],
      "Agent run and sandbox cleanup both failed.",
    );
  }
  if (execution.runError) throw execution.runError;
  if (execution.cleanupError) throw execution.cleanupError;
  return execution.result!;
}

export function startAgentRun(
  options: ControlledAgentRunOptions,
): AgentRunController {
  const abortController = new AbortController();
  const events = createAgentEventPublisher(options.eventSink);
  let stopReason: "sigint" | "ui" | "runtime" | undefined;
  let runStarted = false;
  let hooksStarted = false;
  let shutdownReason:
    | SessionEndContext["reason"]
    | undefined;
  let shutdownStartedAt: number | undefined;

  const beginShutdown = (reason: SessionEndContext["reason"]) => {
    if (shutdownReason) return;
    shutdownReason = reason;
    shutdownStartedAt = performance.now();
    if (runStarted) {
      events.emit({ type: "shutdown_started", reason });
    }
  };

  const linkedAbort = () => {
    stopReason ??= "runtime";
    beginShutdown("failed");
    abortController.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) {
    linkedAbort();
  } else {
    options.signal?.addEventListener("abort", linkedAbort, { once: true });
  }

  const executionPromise = executeAgentRun(
    {
      ...options,
      signal: abortController.signal,
      eventSink: undefined,
    },
    events,
    (event) => {
      if (event === "run_started") {
        runStarted = true;
        if (shutdownReason) {
          events.emit({
            type: "shutdown_started",
            reason: shutdownReason,
          });
        }
      }
      if (event === "hooks_started") hooksStarted = true;
    },
    beginShutdown,
  );

  const normalResult = executionPromise.then(async (execution) => {
    const reason = resultReason(execution.runError, stopReason);
    beginShutdown(reason);
    const initialError = execution.runError ?? execution.cleanupError;
    let cleanup: SessionEndContext["cleanup"] =
      execution.cleanupError ? "failed" : "succeeded";
    const context: SessionEndContext = {
      reason,
      cleanup,
      ...(initialError && (reason === "failed" || execution.cleanupError)
        ? {
            error: safeError(initialError, [
              options.task,
              options.repoPath,
            ]),
          }
        : {}),
    };

    if (runStarted && options.sessionEnd) {
      try {
        await withTimeout(
          Promise.resolve(options.sessionEnd(context)),
          options.sessionEndTimeoutMs ?? SESSION_END_TIMEOUT_MS,
          "SessionEnd handler timed out.",
        );
      } catch (error) {
        cleanup = "failed";
        context.cleanup = "failed";
        context.error = safeError(error, [
          options.task,
          options.repoPath,
        ]);
      }
    }
    if (hooksStarted && options.hooks) {
      try {
        await options.hooks.runSessionEnd(context);
      } catch (error) {
        cleanup = "failed";
        context.cleanup = "failed";
        context.error = safeError(error, [options.task, options.repoPath]);
      }
    }

    const shutdownDuration = shutdownStartedAt === undefined
      ? 0
      : performance.now() - shutdownStartedAt;
    const shutdownLimit =
      options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
    if (shutdownDuration > shutdownLimit) {
      cleanup = "failed";
      context.cleanup = "failed";
      context.error = {
        code: "SHUTDOWN_TIMEOUT",
        message:
          `Shutdown exceeded ${shutdownLimit}ms but cleanup was still awaited.`,
      };
    }

    return finishResult(
      events,
      context,
      execution.result,
      cleanup === "failed" ? 1 : exitCodeFor(reason, execution.runError),
    );
  });

  const result = normalResult.finally(() => {
    options.signal?.removeEventListener("abort", linkedAbort);
  });

  return {
    result,
    stop(reason) {
      if (!stopReason) {
        stopReason = reason;
        beginShutdown(reason === "runtime" ? "failed" : "cancelled");
        abortController.abort(reason);
      }
      return result;
    },
  };
}

type ExecutionResult = {
  result?: ProductionLoopResult;
  runError?: unknown;
  cleanupError?: unknown;
};

async function executeAgentRun(
  options: HeadlessAgentRunOptions,
  events: AgentEventPublisher,
  lifecycleEvent: (event: "run_started" | "hooks_started") => void,
  beginShutdown: (
    reason: SessionEndContext["reason"],
  ) => void = () => {},
): Promise<ExecutionResult> {
  let prepared: PreparedAgentRun;
  try {
    prepared = await prepareAgentRun(options.repoPath, options.task);
  } catch (runError) {
    return { runError };
  }
  events.emit({
    type: "run_started",
    runIdentity: prepared.runIdentity,
  });
  lifecycleEvent("run_started");
  if (options.signal?.aborted) {
    beginShutdown("cancelled");
    return { runError: abortError(options.signal.reason) };
  }

  let session: E2bTaskSession | undefined;
  let result: ProductionLoopResult | undefined;
  let runError: unknown;
  let cleanupError: unknown;
  let checkpointStore: ProductionCheckpointStore | undefined;
  try {
    checkpointStore =
      options.checkpointStore ??
      new FileProductionCheckpointStore(prepared.canonicalRepoPath);
    const existing = await checkpointStore.load();
    if (
      existing &&
      (existing.runIdentity !== prepared.runIdentity ||
        existing.canonicalRepoPath !== prepared.canonicalRepoPath ||
        existing.task !== prepared.task)
    ) {
      throw new AgentRunConfigurationError(
        "Existing checkpoint belongs to another repository or task.",
      );
    }
    const templateId =
      options.templateId ?? process.env.E2B_TEMPLATE_ID?.trim() ?? "";
    if ((!existing || existing.lifecycle === "running") && !templateId) {
      throw new AgentRunConfigurationError(
        "E2B_TEMPLATE_ID is required to start a production run.",
      );
    }
    const modelRuntime = options.modelRuntime ?? (options.callModel
      ? createInjectedModelRuntime(options.callModel)
      : createConfiguredRuntime(parseModelProvider(options.modelProvider ?? process.env.AGENT_MODEL_PROVIDER)));
    await prepareProductionLifecycle({
      ...prepared,
      checkpointStore,
      modelRuntime,
      hooks: options.hooks,
      onSessionStart: () => lifecycleEvent("hooks_started"),
      ...(options.maxModelTurns === undefined ? {} : { budgetLimits: { maxModelCalls: options.maxModelTurns } }),
    });
    const preparedState = await checkpointStore.load();
    const recoveryStore =
      options.sessionRecoveryStore ??
      new FileE2bSessionRecoveryStore(
        path.join(prepared.canonicalRepoPath, ".agent", "e2b-session.json"),
      );
    const resultDeliveryStore =
      options.resultDeliveryStore ??
      new FileResultDeliveryStore(prepared.canonicalRepoPath);
    if (preparedState && preparedState.lifecycle !== "running") {
      result = await runProductionLoop({
        ...prepared,
        modelRuntime,
        session: {
          async call() {
            throw new Error("Completed checkpoints must not call tools.");
          },
        },
        checkpointStore,
        maxModelTurns: options.maxModelTurns,
        signal: options.signal,
        events,
        hooks: options.hooks,
      });
      const completedDelivery = await loadCompletedResultDelivery(
        resultDeliveryStore,
      );
      const recoveryState = await recoveryStore.load();
      if (completedDelivery) {
        result = { ...result, delivery: completedDelivery };
        if (!recoveryState) {
          beginShutdown("completed");
          return { result };
        }
      } else if (!recoveryState) {
        throw new AgentRunConfigurationError(
          "Completed checkpoint has no durable result receipt or recoverable sandbox.",
        );
      }
    }
    session = options.openSession
      ? await options.openSession({
          prepared,
          recoveryStore,
          resultDeliveryStore,
          templateId,
          signal: options.signal,
        })
      : await openDefaultSession(
          prepared,
          recoveryStore,
          resultDeliveryStore,
          templateId,
          options.signal,
        );
    if (!result) {
      result = await runProductionLoop({
        ...prepared,
        modelRuntime,
        session,
        checkpointStore,
        maxModelTurns: options.maxModelTurns,
        signal: options.signal,
        events,
        hooks: options.hooks,
      });
    }
  } catch (error) {
    runError = error;
  }

  beginShutdown(
    resultReason(runError, options.signal?.aborted ? "ui" : undefined),
  );
  if (session) {
    const cleanupErrors: unknown[] = [];
    let deliveryFailed = false;
    try {
      const mutation = await session.reconcileActiveMutation();
      if (mutation && checkpointStore) {
        await commitReconciledProductionMutation({
          checkpointStore,
          mutation,
          hooks: options.hooks,
          events,
        });
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 0 && result && !runError) {
      try {
        const delivery = await session.deliverResult(prepared.runIdentity);
        result = { ...result, delivery };
      } catch (error) {
        deliveryFailed = true;
        cleanupErrors.push(error);
      }
    }
    if (!deliveryFailed) {
      try {
        await session.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    cleanupError = cleanupErrors.length === 1
      ? cleanupErrors[0]
      : cleanupErrors.length > 1
        ? new AggregateError(cleanupErrors, "Sandbox cleanup failed.")
        : undefined;
  }

  return { result, runError, cleanupError };
}

function resultReason(
  error: unknown,
  stopReason: "sigint" | "ui" | "runtime" | undefined,
): SessionEndContext["reason"] {
  if (!error) return "completed";
  if (stopReason === "sigint" || stopReason === "ui") return "cancelled";
  return "failed";
}

function exitCodeFor(
  reason: SessionEndContext["reason"],
  error: unknown,
): 0 | 1 | 2 | 130 {
  if (reason === "completed") return 0;
  if (reason === "cancelled") return 130;
  return error instanceof AgentRunUsageError ? 2 : 1;
}

const finishedEvents = new WeakSet<AgentEventPublisher>();

function finishResult(
  events: AgentEventPublisher,
  context: SessionEndContext,
  productionResult: ProductionLoopResult | undefined,
  exitCode: 0 | 1 | 2 | 130,
): AgentRunResult {
  if (!finishedEvents.has(events)) {
    finishedEvents.add(events);
    events.emit({
      type: "run_finished",
      ...publicEventContext(context),
    });
  }
  return {
    ...context,
    status: context.reason,
    exitCode,
    ...(productionResult ? { productionResult } : {}),
  };
}

function safeError(
  error: unknown,
  sensitiveValues: string[] = [],
): { code: string; message: string } {
  if (error instanceof Error) {
    const candidate = error.name
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toUpperCase();
    let message = sanitizeTerminalText(error.message);
    for (const sensitive of sensitiveValues) {
      if (sensitive) message = message.replaceAll(sensitive, "[redacted]");
    }
    return {
      code: /^[A-Z][A-Z0-9_]*$/.test(candidate)
        ? candidate
        : "RUNTIME_ERROR",
      message: message.slice(0, 2_048),
    };
  }
  return { code: "UNKNOWN_ERROR", message: "Unknown runtime failure." };
}

function publicEventContext(
  context: SessionEndContext,
): SessionEndContext {
  if (!context.error) return context;
  return {
    ...context,
    error: {
      code: /^[A-Z][A-Z0-9_]*$/.test(context.error.code)
        ? context.error.code
        : "RUNTIME_ERROR",
      message: "Run failed. See stderr for diagnostics.",
    },
  };
}

function abortError(reason: unknown): DOMException {
  return new DOMException(
    typeof reason === "string" ? reason : "Agent run was cancelled.",
    "AbortError",
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


function parseModelProvider(
  value: string | undefined,
): AgentModelProvider {
  const normalized = value?.trim() || "anthropic";
  if (normalized !== "anthropic" && normalized !== "openrouter") {
    throw new AgentRunConfigurationError(
      'AGENT_MODEL_PROVIDER must be "anthropic" or "openrouter".',
    );
  }
  return normalized;
}

function createConfiguredRuntime(
  provider: AgentModelProvider,
): ModelRuntime {
  return provider === "anthropic"
    ? createAnthropicRuntime()
    : createOpenRouterRuntime();
}

async function openDefaultSession(
  prepared: PreparedAgentRun,
  recoveryStore: E2bSessionRecoveryStore,
  resultDeliveryStore: ResultDeliveryStore,
  templateId: string,
  signal?: AbortSignal,
): Promise<E2bTaskSession> {
  const recovery = {
    runIdentity: prepared.runIdentity,
    store: recoveryStore,
  };
  return (await recoveryStore.load())
    ? recoverE2bTaskSession({
        ...recovery,
        localRepoPath: prepared.canonicalRepoPath,
        resultDeliveryStore,
        signal,
      })
    : createE2bTaskSession({
        localRepoPath: prepared.canonicalRepoPath,
        taskId: `run-${prepared.runIdentity.slice(0, 24)}`,
        templateId,
        recovery,
        resultDeliveryStore,
        signal,
      });
}

async function gitTopLevel(repositoryPath: string): Promise<string> {
  const child = Bun.spawn(
    ["git", "rev-parse", "--show-toplevel"],
    {
      cwd: repositoryPath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new AgentRunUsageError(
      `Repository path is not a Git repository: ${stderr.trim() || repositoryPath}`,
    );
  }
  return stdout.trim();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
