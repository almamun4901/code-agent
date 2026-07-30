import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CallModel } from "../model/contracts";
import { createOpenRouterModel } from "../model/openrouter";
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
  FileProductionCheckpointStore,
  type ProductionCheckpointStore,
} from "./checkpoint";
import {
  runProductionLoop,
  type ProductionLoopResult,
} from "./production-loop";

export type PreparedAgentRun = {
  canonicalRepoPath: string;
  task: string;
  runIdentity: string;
};

export type HeadlessAgentRunOptions = {
  repoPath: string;
  task: string;
  templateId?: string;
  signal?: AbortSignal;
  maxModelTurns?: number;
  callModel?: CallModel;
  checkpointStore?: ProductionCheckpointStore;
  sessionRecoveryStore?: E2bSessionRecoveryStore;
  openSession?: (context: {
    prepared: PreparedAgentRun;
    recoveryStore: E2bSessionRecoveryStore;
    templateId: string;
  }) => Promise<E2bTaskSession>;
};

export class AgentRunConfigurationError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "AgentRunConfigurationError";
  }
}

export async function prepareAgentRun(
  repoPath: string,
  task: string,
): Promise<PreparedAgentRun> {
  const normalizedTask = task.trim();
  if (!normalizedTask) {
    throw new AgentRunConfigurationError("Task must not be blank.");
  }
  if (!path.isAbsolute(repoPath)) {
    throw new AgentRunConfigurationError(
      "Repository path must be absolute.",
    );
  }

  let canonicalRepoPath: string;
  try {
    const details = await stat(repoPath);
    if (!details.isDirectory()) {
      throw new AgentRunConfigurationError(
        "Repository path must identify a directory.",
      );
    }
    canonicalRepoPath = await realpath(repoPath);
  } catch (error) {
    if (error instanceof AgentRunConfigurationError) throw error;
    throw new AgentRunConfigurationError(
      `Repository path does not exist: ${repoPath}`,
      { cause: error },
    );
  }

  const topLevel = await gitTopLevel(canonicalRepoPath);
  if ((await realpath(topLevel)) !== canonicalRepoPath) {
    throw new AgentRunConfigurationError(
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
  const prepared = await prepareAgentRun(options.repoPath, options.task);
  const checkpointStore =
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
  if (existing?.lifecycle === "completed") {
    return runProductionLoop({
      ...prepared,
      callModel:
        options.callModel ??
        (async () => {
          throw new Error("Completed checkpoints must not call the model.");
        }),
      session: {
        async call() {
          throw new Error("Completed checkpoints must not call tools.");
        },
      },
      checkpointStore,
      maxModelTurns: options.maxModelTurns,
      signal: options.signal,
    });
  }

  const templateId =
    options.templateId ?? process.env.E2B_TEMPLATE_ID?.trim() ?? "";
  if (!templateId) {
    throw new AgentRunConfigurationError(
      "E2B_TEMPLATE_ID is required to start a production run.",
    );
  }
  const callModel = options.callModel ?? createOpenRouterModel();
  const recoveryStore =
    options.sessionRecoveryStore ??
    new FileE2bSessionRecoveryStore(
      path.join(prepared.canonicalRepoPath, ".agent", "e2b-session.json"),
    );
  const session = options.openSession
    ? await options.openSession({
        prepared,
        recoveryStore,
        templateId,
      })
    : await openDefaultSession(prepared, recoveryStore, templateId);

  let result: ProductionLoopResult | undefined;
  let runError: unknown;
  try {
    result = await runProductionLoop({
      ...prepared,
      callModel,
      session,
      checkpointStore,
      maxModelTurns: options.maxModelTurns,
      signal: options.signal,
    });
  } catch (error) {
    runError = error;
  }

  let cleanupError: unknown;
  try {
    await session.reconcileActiveMutation();
    await session.close();
  } catch (error) {
    cleanupError = error;
  }

  if (runError && cleanupError) {
    throw new AggregateError(
      [runError, cleanupError],
      "Agent run and sandbox cleanup both failed.",
    );
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;
  return result!;
}

async function openDefaultSession(
  prepared: PreparedAgentRun,
  recoveryStore: E2bSessionRecoveryStore,
  templateId: string,
): Promise<E2bTaskSession> {
  const recovery = {
    runIdentity: prepared.runIdentity,
    store: recoveryStore,
  };
  return (await recoveryStore.load())
    ? recoverE2bTaskSession(recovery)
    : createE2bTaskSession({
        localRepoPath: prepared.canonicalRepoPath,
        taskId: `run-${prepared.runIdentity.slice(0, 24)}`,
        templateId,
        recovery,
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
    throw new AgentRunConfigurationError(
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
