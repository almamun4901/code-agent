import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "e2b";
import { z } from "zod";
import {
  McpToolClient,
  type McpToolCallOptions,
} from "../mcp/client";
import {
  isMutatingToolCall,
  type ModelToolRequest,
  type ToolResult,
} from "../tools/contracts";
import {
  mutationInputHash,
  mutationJournalStateSchema,
  type MutationRecord,
} from "../tools/mutation-journal";
import {
  E2bStdioTransport,
  e2bCommandController,
  type E2bCommandController,
} from "./e2b-stdio-transport";
import {
  RUNTIME_MANIFEST_PATH,
  createRuntimeManifest,
  type RuntimeManifest,
} from "./runtime-manifest";
import { createRepositoryBundle } from "./repository-bundle";
import {
  FileResultDeliveryStore,
  MAX_RESULT_BUNDLE_BYTES,
  MemoryResultDeliveryStore,
  deliverResult,
  type ResultDeliveryReceipt,
  type ResultDeliveryStore,
} from "./result-delivery";
import type {
  E2bSessionRecoveryState,
  E2bSessionRecoveryStore,
} from "./session-recovery";
import type { ViewportVerificationRequirement } from "../runtime/approval";

const DEFAULT_TIMEOUT_MS = 900_000;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_RECONCILE_TIMEOUT_MS = 35_000;
const CREATE_REQUEST_TIMEOUT_MS = 25_000;
const RECONCILE_POLL_MS = 100;
const REMOTE_BUNDLE_PATH = "/tmp/repository.bundle";
const REMOTE_CONFIG_PATH = "/tmp/provision-task.json";
const REMOTE_RESULT_BUNDLE_PATH = "/tmp/terminal-agent-result.bundle";
const REMOTE_TASKS_ROOT = "/workspace/tasks";
const REMOTE_RUNTIME_ROOT = "/opt/agent";
const REMOTE_VIEWPORT_VERIFIER = `${REMOTE_RUNTIME_ROOT}/src/sandbox/viewport-verifier.ts`;
const MAX_VIEWPORT_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_VIEWPORT_SCREENSHOT_TOTAL_BYTES = 16 * 1024 * 1024;
export const REMOTE_MUTATION_JOURNAL_PATH =
  "/tmp/terminal-agent-mutation-journal.json";
function serverCommand(worktreeRoot: string): string {
  return [
    "bun run /opt/agent/src/mcp/stdio-server.ts",
    `--worktree-root ${worktreeRoot}`,
    `--allowed-parent ${REMOTE_TASKS_ROOT}`,
    `--mutation-journal ${REMOTE_MUTATION_JOURNAL_PATH}`,
  ].join(" ");
}
const expectedTools = [
  "edit_file",
  "git",
  "read_file",
  "ripgrep",
  "run_shell",
  "tree_sitter_symbols",
];
const taskIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

const runtimeManifestSchema = z
  .object({
    runtimeVersion: z.string().min(1),
    packageVersion: z.string().min(1),
    lockSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const provisionResultSchema = z
  .object({
    remoteRepoPath: z.string().min(1),
    branch: z.string().min(1),
    baseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  })
  .strict();

const resultExportSchema = z.object({
  resultSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  bundleBytes: z.number().int().positive().max(MAX_RESULT_BUNDLE_BYTES),
}).strict();

export type E2bTaskSessionOptions = {
  localRepoPath: string;
  taskId: string;
  templateId: string;
  baseRef?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  recovery?: {
    runIdentity: string;
    store: E2bSessionRecoveryStore;
  };
  resultDeliveryStore?: ResultDeliveryStore;
};

export type SandboxCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type E2bSandbox = {
  readonly sandboxId: string;
  readonly commands: E2bCommandController;
  write(path: string, data: string | ArrayBuffer): Promise<void>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  readStream(path: string): Promise<ReadableStream<Uint8Array>>;
  remove(path: string): Promise<void>;
  run(
    command: string,
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<SandboxCommandResult>;
  kill(): Promise<void>;
};

export type E2bSandboxFactory = {
  create(
    templateId: string,
    options: {
      timeoutMs: number;
      secure: true;
      allowInternetAccess: false;
      lifecycle: { onTimeout: "kill" };
      metadata: Record<string, string>;
      requestTimeoutMs: number;
    },
  ): Promise<E2bSandbox>;
  connect?(sandboxId: string): Promise<E2bSandbox>;
  reconcileCreateFailure(metadata: Record<string, string>): Promise<void>;
};

function sandboxAdapter(sandbox: Sandbox): E2bSandbox {
  return {
    sandboxId: sandbox.sandboxId,
    commands: e2bCommandController(sandbox.commands),
    async write(remotePath, data) {
      await sandbox.files.write(remotePath, data);
    },
    readText: (remotePath) => sandbox.files.read(remotePath),
    readBytes: (remotePath) => sandbox.files.read(remotePath, { format: "bytes" }),
    readStream: (remotePath) => sandbox.files.read(remotePath, { format: "stream" }),
    remove: (remotePath) => sandbox.files.remove(remotePath),
    async run(command, options = {}) {
      return sandbox.commands.run(command, options);
    },
    kill: () => sandbox.kill(),
  };
}

export const defaultE2bSandboxFactory: E2bSandboxFactory = {
  async create(templateId, options) {
    const { Sandbox } = await import("e2b");
    return sandboxAdapter(await Sandbox.create(templateId, options));
  },
  async connect(sandboxId) {
    const { Sandbox } = await import("e2b");
    return sandboxAdapter(await Sandbox.connect(sandboxId));
  },
  async reconcileCreateFailure(metadata) {
    const { Sandbox } = await import("e2b");
    const paginator = Sandbox.list({
      query: { metadata, state: ["running", "paused"] },
    });
    const sandboxIds: string[] = [];
    while (paginator.hasNext) {
      sandboxIds.push(
        ...(await paginator.nextItems()).map((sandbox) => sandbox.sandboxId),
      );
    }
    const results = await Promise.allSettled(
      sandboxIds.map((sandboxId) => Sandbox.kill(sandboxId)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Failed to reconcile E2B sandbox creation.",
      );
    }
  },
};

export type E2bTaskSession = {
  readonly sandboxId: string;
  readonly serverPid: number | null;
  readonly remoteRepoPath: string;
  readonly baseSha: string;
  readonly client: McpToolClient;
  readonly recoveredMutation: MutationRecord | null;
  call(
    request: ModelToolRequest,
    options?: ViewportToolCallOptions,
  ): Promise<ToolResult>;
  reconcileActiveMutation(timeoutMs?: number): Promise<MutationRecord | null>;
  deliverResult(runIdentity: string): Promise<ResultDeliveryReceipt>;
  preserveForRecovery(): Promise<void>;
  close(): Promise<void>;
};

export type ViewportToolCallOptions = McpToolCallOptions & {
  viewportRequirement?: ViewportVerificationRequirement;
};

const viewportManifestSchema = z.object({
  success: z.boolean(),
  code: z.string().min(1).max(64).optional(),
  screenshots: z.array(z.object({ file: z.string().startsWith("/tmp/agent-viewport-"), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(MAX_VIEWPORT_SCREENSHOT_BYTES), width: z.number().int(), height: z.number().int(), route: z.string() }).strict()).max(12).optional(),
}).strict();

export class E2bTaskSessionError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "E2bTaskSessionError";
  }
}

export class MutationRecoveryBlockedError extends E2bTaskSessionError {
  readonly sandboxId: string;
  readonly operationId: string | null;

  constructor(
    message: string,
    options: {
      sandboxId: string;
      operationId?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "MutationRecoveryBlockedError";
    this.sandboxId = options.sandboxId;
    this.operationId = options.operationId ?? null;
  }
}

class OwnedE2bTaskSession implements E2bTaskSession {
  readonly sandboxId: string;
  readonly serverPid: number | null;
  readonly remoteRepoPath: string;
  readonly baseSha: string;
  readonly client: McpToolClient;
  readonly recoveredMutation: MutationRecord | null;

  readonly #sandbox: E2bSandbox;
  readonly #recovery:
    | {
        runIdentity: string;
        store: E2bSessionRecoveryStore;
      }
    | undefined;
  readonly #localRepoPath: string;
  readonly #taskBranch: string;
  readonly #resultDeliveryStore: ResultDeliveryStore;
  #closePromise: Promise<void> | undefined;
  #preservePromise: Promise<void> | undefined;
  #callTail: Promise<void> = Promise.resolve();

  constructor(options: {
    sandbox: E2bSandbox;
    remoteRepoPath: string;
    baseSha: string;
    client: McpToolClient;
    serverPid: number | null;
    recoveredMutation?: MutationRecord | null;
    recovery?: {
      runIdentity: string;
      store: E2bSessionRecoveryStore;
    };
    localRepoPath: string;
    taskBranch: string;
    resultDeliveryStore: ResultDeliveryStore;
  }) {
    this.#sandbox = options.sandbox;
    this.sandboxId = options.sandbox.sandboxId;
    this.remoteRepoPath = options.remoteRepoPath;
    this.baseSha = options.baseSha;
    this.client = options.client;
    this.serverPid = options.serverPid;
    this.recoveredMutation = options.recoveredMutation ?? null;
    this.#recovery = options.recovery;
    this.#localRepoPath = options.localRepoPath;
    this.#taskBranch = options.taskBranch;
    this.#resultDeliveryStore = options.resultDeliveryStore;
  }

  async call(
    request: ModelToolRequest,
    options: ViewportToolCallOptions = {},
  ): Promise<ToolResult> {
    this.#assertOpen();
    const operation = async () => this.#call(request, options);
    const previous = this.#callTail;
    let release!: () => void;
    this.#callTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.#assertOpen();
      return await operation();
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    const closePromise = (this.#closePromise ??= this.#close());
    try {
      await closePromise;
    } catch (error) {
      if (
        error instanceof MutationRecoveryBlockedError &&
        this.#closePromise === closePromise
      ) {
        this.#closePromise = undefined;
      }
      throw error;
    }
  }

  async reconcileActiveMutation(
    timeoutMs = DEFAULT_RECONCILE_TIMEOUT_MS,
  ): Promise<MutationRecord | null> {
    if (!this.#recovery) return null;
    const state = await this.#requiredRecoveryState();
    if (!state.activeMutation) return null;
    if (state.activeMutation.status === "completed") {
      return state.activeMutation;
    }
    if (state.activeMutation.toolName === "verify_viewport") {
      await this.#sandbox.run(`sudo /usr/local/sbin/agent-run-shell --cancel ${this.remoteRepoPath}`, { timeoutMs: 5_000 }).catch(() => undefined);
      const cancelled = cancelledBeforeRemoteExecution(state.activeMutation);
      await this.#recovery.store.save({ ...state, activeMutation: cancelled });
      return cancelled;
    }
    const earlierRequestsDrained = await this.#drainEarlierRequests();
    const completed = await reconcileRemoteMutation(
      this.#sandbox,
      state,
      timeoutMs,
      earlierRequestsDrained,
    );
    await this.#recovery.store.save({
      ...state,
      activeMutation: completed,
    });
    return completed;
  }

  async deliverResult(runIdentity: string): Promise<ResultDeliveryReceipt> {
    this.#assertOpen();
    if (!this.#localRepoPath) {
      throw new E2bTaskSessionError(
        "Recovered session lacks a local result delivery destination.",
      );
    }
    await this.#callTail;
    if (this.#recovery) {
      const state = await this.#requiredRecoveryState();
      if (state.runIdentity !== runIdentity) {
        throw new E2bTaskSessionError(
          "Result delivery run identity does not match the owned sandbox.",
        );
      }
      if (state.activeMutation?.status === "in_flight") {
        throw new MutationRecoveryBlockedError(
          `Mutation ${state.activeMutation.operationId} must finish before result delivery.`,
          {
            sandboxId: state.sandboxId,
            operationId: state.activeMutation.operationId,
          },
        );
      }
    }
    const artifact = await exportSandboxResult(
      this.#sandbox,
      this.remoteRepoPath,
      this.#taskBranch,
      this.baseSha,
    );
    return deliverResult({
      canonicalRepoPath: this.#localRepoPath,
      runIdentity,
      artifact,
      store: this.#resultDeliveryStore,
    });
  }

  async preserveForRecovery(): Promise<void> {
    if (this.#closePromise) {
      throw new E2bTaskSessionError(
        "E2B task session is closing or closed.",
      );
    }
    this.#preservePromise ??= (async () => {
      await this.#callTail;
      await this.client.close();
    })();
    return this.#preservePromise;
  }

  async #drainEarlierRequests(): Promise<boolean> {
    try {
      await this.client.call({
        name: "read_file",
        input: { path: ".git" },
      });
      return true;
    } catch {
      return false;
    }
  }

  async #close(): Promise<void> {
    const errors: unknown[] = [];
    await this.#callTail;
    await this.#preservePromise?.catch((error) => errors.push(error));
    if (this.#recovery) {
      const state = await this.#requiredRecoveryState();
      if (state.activeMutation?.status === "in_flight") {
        throw new MutationRecoveryBlockedError(
          `Mutation ${state.activeMutation.operationId} must reach a terminal journal result before the sandbox can close.`,
          {
            sandboxId: state.sandboxId,
            operationId: state.activeMutation.operationId,
          },
        );
      }
    }
    try {
      await this.client.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#sandbox.kill();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to close E2B task session.");
    }
    await this.#recovery?.store.clear();
  }

  async #call(
    request: ModelToolRequest,
    options: ViewportToolCallOptions,
  ): Promise<ToolResult> {
    if (!isMutatingToolCall(request) || !this.#recovery) {
      return this.client.call(request, options);
    }

    const operationId = options.operationId ?? crypto.randomUUID();
    const current = await this.#requiredRecoveryState();
    const inputHash = mutationInputHash(request);
    const existing = current.activeMutation;
    if (existing) {
      if (
        existing.operationId === operationId &&
        existing.toolName === request.name &&
        existing.inputHash === inputHash
      ) {
        if (existing.status === "completed" && existing.result) {
          return existing.result;
        }
        throw new E2bTaskSessionError(
          `Mutation ${operationId} remains in flight and requires reconciliation.`,
        );
      }
      if (existing.status === "in_flight") {
        throw new E2bTaskSessionError(
          `Mutation ${existing.operationId} remains in flight and blocks another mutation.`,
        );
      }
    }

    const startedAt = new Date().toISOString();
    const activeMutation: MutationRecord = {
      operationId,
      toolName: request.name as MutationRecord["toolName"],
      inputHash,
      status: "in_flight",
      startedAt,
      completedAt: null,
      result: null,
    };
    await this.#recovery.store.save({ ...current, activeMutation });
    const result = request.name === "verify_viewport"
      ? await this.#verifyViewport(request.input.verificationRequirementId, options.viewportRequirement, operationId, options.signal)
      : await this.client.call(request, {
          operationId,
          ...(options.observePreToolUse ? { observePreToolUse: options.observePreToolUse } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
    await this.#recovery.store.save({
      ...current,
      activeMutation: {
        ...activeMutation,
        status: "completed",
        completedAt: new Date().toISOString(),
        result,
      },
    });
    return result;
  }

  async #verifyViewport(
    requirementId: string,
    requirement: ViewportVerificationRequirement | undefined,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (!requirement || requirement.type !== "viewport" || requirement.id !== requirementId) {
      return viewportToolFailure("VIEWPORT_CONTRACT_REQUIRED");
    }
    const before = await this.#remoteGitIdentity();
    const remoteInput = `/tmp/agent-viewport-${operationId}.json`;
    const remoteOutput = `/tmp/agent-viewport-${operationId}`;
    try {
      await this.#sandbox.write(remoteInput, `${JSON.stringify({ remoteRepoPath: this.remoteRepoPath, requirement })}\n`);
      let commandResult: SandboxCommandResult;
      const viewportTimeoutMs = 35_000 + requirement.cases.length * 30_000;
      const running = this.#sandbox.run(`PLAYWRIGHT_BROWSERS_PATH=${REMOTE_RUNTIME_ROOT}/ms-playwright bun run ${REMOTE_VIEWPORT_VERIFIER} ${remoteInput} ${remoteOutput}`, { cwd: REMOTE_RUNTIME_ROOT, timeoutMs: viewportTimeoutMs });
      commandResult = signal ? await raceViewportAbort(running, signal, async () => {
        await this.#sandbox.run(`sudo /usr/local/sbin/agent-run-shell --cancel ${this.remoteRepoPath}`, { timeoutMs: 5_000 }).catch(() => undefined);
      }) : await running;
      const after = await this.#remoteGitIdentity();
      let manifest: z.infer<typeof viewportManifestSchema>;
      try { manifest = viewportManifestSchema.parse(JSON.parse(commandResult.stdout.trim())); }
      catch { return viewportToolFailure("VIEWPORT_RESULT_INVALID", before, after); }
      if (commandResult.exitCode !== 0 || !manifest.success) return viewportToolFailure(manifest.code ?? "VIEWPORT_FAILED", before, after);
      const screenshots = [];
      const targets = (manifest.screenshots ?? []).map((_, index) => `.agent/evidence/${operationId}-${index}.png`);
      let totalBytes = 0;
      const written: string[] = [];
      try {
        totalBytes = await viewportEvidenceBytes(this.#localRepoPath, targets);
        for (const [index, item] of (manifest.screenshots ?? []).entries()) {
          if (item.file !== `${remoteOutput}/case-${index}.png`) throw new E2bTaskSessionError("VIEWPORT_SCREENSHOT_INTEGRITY_FAILED");
          const bytes = await readBoundedBytes(await this.#sandbox.readStream(item.file), MAX_VIEWPORT_SCREENSHOT_BYTES);
          totalBytes += bytes.byteLength;
          if (bytes.byteLength !== item.bytes || totalBytes > MAX_VIEWPORT_SCREENSHOT_TOTAL_BYTES || await sha256(bytes) !== item.sha256) {
            throw new E2bTaskSessionError("VIEWPORT_SCREENSHOT_INTEGRITY_FAILED");
          }
          validateViewportPng(bytes, item.width, item.height);
          const relativePath = targets[index]!;
          await atomicEvidenceWrite(this.#localRepoPath, relativePath, bytes);
          written.push(path.join(this.#localRepoPath, relativePath));
          screenshots.push({ path: relativePath, sha256: item.sha256, bytes: item.bytes, width: item.width, height: item.height, route: item.route });
        }
      } catch {
        await Promise.all(written.map((target) => unlink(target).catch(() => undefined)));
        return viewportToolFailure(totalBytes > MAX_VIEWPORT_SCREENSHOT_TOTAL_BYTES ? "VIEWPORT_SCREENSHOT_BUDGET_EXCEEDED" : "VIEWPORT_SCREENSHOT_INTEGRITY_FAILED", before, after);
      }
      return {
        success: true,
        output: `Viewport verification satisfied ${screenshots.length} case${screenshots.length === 1 ? "" : "s"}.`,
        truncated: false,
        originalTokenCount: 12,
        codec: "viewport",
        metadata: {
          verificationRequirementId: requirementId,
          viewportManifest: JSON.stringify(screenshots),
          exitCode: commandResult.exitCode,
          timedOut: false,
          gitCommitBefore: before.commit,
          gitTreeBefore: before.tree,
          gitCleanBefore: before.clean,
          gitCommitAfter: after.commit,
          gitTreeAfter: after.tree,
          gitCleanAfter: after.clean,
        },
      };
    } catch (error) {
      await this.#sandbox.run(`sudo /usr/local/sbin/agent-run-shell --cancel ${this.remoteRepoPath}`, { timeoutMs: 5_000 }).catch(() => undefined);
      if (signal?.aborted) throw error;
      return viewportToolFailure("VIEWPORT_PROCESS_FAILED");
    } finally {
      await Promise.all([this.#sandbox.remove(remoteInput).catch(() => undefined), this.#sandbox.remove(remoteOutput).catch(() => undefined)]);
    }
  }

  async #remoteGitIdentity(): Promise<{ commit: string; tree: string; clean: boolean }> {
    const result = await this.#sandbox.run(`git -C ${this.remoteRepoPath} rev-parse HEAD && git -C ${this.remoteRepoPath} rev-parse 'HEAD^{tree}' && git -C ${this.remoteRepoPath} status --porcelain=v1 --untracked-files=all`, { timeoutMs: 5_000 });
    const lines = result.stdout.split("\n");
    if (result.exitCode !== 0 || !lines[0] || !lines[1]) throw new E2bTaskSessionError("Could not capture viewport Git identity.");
    return { commit: lines[0].trim(), tree: lines[1].trim(), clean: lines.slice(2).join("\n").trim().length === 0 };
  }

  async #requiredRecoveryState(): Promise<E2bSessionRecoveryState> {
    const state = await this.#recovery!.store.load();
    if (
      !state ||
      state.runIdentity !== this.#recovery!.runIdentity ||
      state.sandboxId !== this.sandboxId
    ) {
      throw new E2bTaskSessionError(
        "E2B session recovery state does not match the owned sandbox.",
      );
    }
    return state;
  }

  #assertOpen(): void {
    if (this.#closePromise || this.#preservePromise) {
      throw new E2bTaskSessionError(
        "E2B task session is closing or closed.",
      );
    }
  }
}

function validateOptions(options: E2bTaskSessionOptions): number {
  if (!options.templateId.trim()) {
    throw new E2bTaskSessionError("templateId must not be empty.");
  }
  if (!taskIdPattern.test(options.taskId)) {
    throw new E2bTaskSessionError(
      "taskId must be a lowercase path-safe slug between 1 and 64 characters.",
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new E2bTaskSessionError(
      `timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`,
    );
  }
  return timeoutMs;
}

function assertRuntimeManifest(
  actualText: string,
  expected: RuntimeManifest,
): void {
  let actualValue: unknown;
  try {
    actualValue = JSON.parse(actualText);
  } catch (error) {
    throw new E2bTaskSessionError("E2B runtime manifest is not valid JSON.", {
      cause: error,
    });
  }
  const actual = runtimeManifestSchema.safeParse(actualValue);
  if (!actual.success || JSON.stringify(actual.data) !== JSON.stringify(expected)) {
    throw new E2bTaskSessionError(
      "E2B runtime manifest does not match the host tool runtime.",
    );
  }
}

function parseProvisionResult(
  stdout: string,
  taskId: string,
  baseSha: string,
) {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new E2bTaskSessionError(
      "E2B provisioner did not return valid JSON.",
      { cause: error },
    );
  }
  const result = provisionResultSchema.safeParse(value);
  const expectedPath = `${REMOTE_TASKS_ROOT}/${taskId}`;
  if (
    !result.success ||
    result.data.remoteRepoPath !== expectedPath ||
    result.data.branch !== `task/${taskId}` ||
    result.data.baseSha !== baseSha
  ) {
    throw new E2bTaskSessionError(
      "E2B provisioner returned an unexpected worktree result.",
    );
  }
  return result.data;
}

async function cleanupPartial(
  client: McpToolClient | undefined,
  transport: E2bStdioTransport | undefined,
  sandbox: E2bSandbox | undefined,
): Promise<void> {
  await client?.close().catch(() => {});
  if (!client) {
    await transport?.close().catch(() => {});
  }
  await sandbox?.kill().catch(() => {});
}

export async function createE2bTaskSession(
  options: E2bTaskSessionOptions,
  dependencies: {
    sandboxFactory?: E2bSandboxFactory;
    connectClient?: (
      transport: E2bStdioTransport,
    ) => Promise<McpToolClient>;
  } = {},
): Promise<E2bTaskSession> {
  const timeoutMs = validateOptions(options);
  throwIfSessionAborted(options.signal);
  if (options.recovery) {
    if (!options.recovery.runIdentity.trim()) {
      throw new E2bTaskSessionError(
        "Recovery runIdentity must not be empty.",
      );
    }
    if (await options.recovery.store.load()) {
      throw new E2bTaskSessionError(
        "An E2B session recovery record already exists; recover or resolve it before creating another sandbox.",
      );
    }
  }
  const bundle = await createRepositoryBundle(
    options.localRepoPath,
    options.baseRef,
  );
  const sandboxFactory =
    dependencies.sandboxFactory ?? defaultE2bSandboxFactory;
  const connectClient =
    dependencies.connectClient ?? McpToolClient.connect;
  const agentProjectRoot = fileURLToPath(new URL("../..", import.meta.url));

  let sandbox: E2bSandbox | undefined;
  let transport: E2bStdioTransport | undefined;
  let client: McpToolClient | undefined;

  try {
    throwIfSessionAborted(options.signal);
    const expectedManifest = await createRuntimeManifest(agentProjectRoot);
    const creationMetadata = {
      taskId: options.taskId,
      baseSha: bundle.baseSha,
      creationId: crypto.randomUUID(),
    };
    try {
      sandbox = await sandboxFactory.create(options.templateId, {
        timeoutMs,
        secure: true,
        allowInternetAccess: false,
        lifecycle: { onTimeout: "kill" },
        metadata: creationMetadata,
        requestTimeoutMs: CREATE_REQUEST_TIMEOUT_MS,
      });
      throwIfSessionAborted(options.signal);
    } catch (createError) {
      try {
        await sandboxFactory.reconcileCreateFailure({
          creationId: creationMetadata.creationId,
        });
      } catch (reconcileError) {
        throw new E2bTaskSessionError(
          "E2B sandbox creation failed and reconciliation did not complete.",
          {
            cause: new AggregateError([createError, reconcileError]),
          },
        );
      }
      throw createError;
    }
    assertRuntimeManifest(
      await sandbox.readText(RUNTIME_MANIFEST_PATH),
      expectedManifest,
    );
    throwIfSessionAborted(options.signal);

    const bundleBytes = await readFile(bundle.bundlePath);
    await sandbox.write(
      REMOTE_BUNDLE_PATH,
      new Uint8Array(bundleBytes).buffer,
    );
    throwIfSessionAborted(options.signal);
    await sandbox.write(
      REMOTE_CONFIG_PATH,
      `${JSON.stringify({
        bundlePath: REMOTE_BUNDLE_PATH,
        taskId: options.taskId,
        baseSha: bundle.baseSha,
      })}\n`,
    );
    await bundle.cleanup();

    const provisioned = await sandbox.run(
      `bun run ${REMOTE_RUNTIME_ROOT}/src/sandbox/provision-task.ts ${REMOTE_CONFIG_PATH}`,
      { cwd: REMOTE_RUNTIME_ROOT, timeoutMs: 60_000 },
    );
    throwIfSessionAborted(options.signal);
    if (provisioned.exitCode !== 0) {
      throw new E2bTaskSessionError(
        `E2B task provisioning failed: ${provisioned.stderr.trim() || "No diagnostic output."}`,
      );
    }
    const result = parseProvisionResult(
      provisioned.stdout.trim(),
      options.taskId,
      bundle.baseSha,
    );

    transport = new E2bStdioTransport({
      commands: sandbox.commands,
      command: serverCommand(result.remoteRepoPath),
      cwd: REMOTE_RUNTIME_ROOT,
    });
    client = await connectClient(transport);
    throwIfSessionAborted(options.signal);
    const discovered = (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
    throwIfSessionAborted(options.signal);
    if (JSON.stringify(discovered) !== JSON.stringify(expectedTools)) {
      throw new E2bTaskSessionError(
        "E2B MCP server did not expose the exact six-tool contract.",
      );
    }

    if (options.recovery) {
      await options.recovery.store.save({
        version: 1,
        runIdentity: options.recovery.runIdentity,
        sandboxId: sandbox.sandboxId,
        serverPid: transport.pid,
        remoteRepoPath: result.remoteRepoPath,
        baseSha: bundle.baseSha,
        activeMutation: null,
      });
    }

    return new OwnedE2bTaskSession({
      sandbox,
      remoteRepoPath: result.remoteRepoPath,
      baseSha: bundle.baseSha,
      client,
      serverPid: transport.pid,
      recovery: options.recovery,
      localRepoPath: bundle.repositoryPath,
      taskBranch: result.branch,
      resultDeliveryStore:
        options.resultDeliveryStore ??
        new FileResultDeliveryStore(bundle.repositoryPath),
    });
  } catch (error) {
    await cleanupPartial(client, transport, sandbox);
    throw error instanceof E2bTaskSessionError
      ? error
      : new E2bTaskSessionError(
          error instanceof Error
            ? `Failed to create E2B task session: ${error.message}`
            : "Failed to create E2B task session.",
          { cause: error },
        );
  } finally {
    await bundle.cleanup().catch(() => {});
  }
}

export async function recoverE2bTaskSession(
  options: {
    runIdentity: string;
    store: E2bSessionRecoveryStore;
    localRepoPath?: string;
    resultDeliveryStore?: ResultDeliveryStore;
    reconcileTimeoutMs?: number;
    signal?: AbortSignal;
  },
  dependencies: {
    sandboxFactory?: E2bSandboxFactory;
    connectClient?: (
      transport: E2bStdioTransport,
    ) => Promise<McpToolClient>;
  } = {},
): Promise<E2bTaskSession> {
  throwIfSessionAborted(options.signal);
  const state = await options.store.load();
  throwIfSessionAborted(options.signal);
  if (!state) {
    throw new E2bTaskSessionError(
      "No E2B session recovery record exists.",
    );
  }
  if (state.runIdentity !== options.runIdentity) {
    throw new E2bTaskSessionError(
      "E2B session recovery run identity does not match the requested run.",
    );
  }

  const sandboxFactory =
    dependencies.sandboxFactory ?? defaultE2bSandboxFactory;
  if (!sandboxFactory.connect) {
    throw new E2bTaskSessionError(
      "The configured E2B sandbox factory cannot reconnect sessions.",
    );
  }
  const connectClient =
    dependencies.connectClient ?? McpToolClient.connect;
  let sandbox: E2bSandbox;
  try {
    sandbox = await sandboxFactory.connect(state.sandboxId);
  } catch (error) {
    throw new MutationRecoveryBlockedError(
      `Could not reconnect E2B sandbox ${state.sandboxId}; mutation state must not be replayed.`,
      {
        sandboxId: state.sandboxId,
        operationId: state.activeMutation?.operationId,
        cause: error,
      },
    );
  }

  const agentProjectRoot = fileURLToPath(new URL("../..", import.meta.url));
  try {
    assertRuntimeManifest(
      await sandbox.readText(RUNTIME_MANIFEST_PATH),
      await createRuntimeManifest(agentProjectRoot),
    );
  } catch (error) {
    throw new MutationRecoveryBlockedError(
      `Recovered E2B sandbox ${state.sandboxId} has an incompatible runtime.`,
      {
        sandboxId: state.sandboxId,
        operationId: state.activeMutation?.operationId,
        cause: error,
      },
    );
  }

  let recoveredMutation = state.activeMutation;
  if (state.activeMutation) {
    recoveredMutation = await reconcileRemoteMutation(
      sandbox,
      state,
      options.reconcileTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS,
    );
    await options.store.save({
      ...state,
      activeMutation: recoveredMutation,
    });
  }

  if (state.serverPid !== null) {
    await sandbox.commands.kill(state.serverPid).catch(() => false);
  }

  const transport = new E2bStdioTransport({
    commands: sandbox.commands,
    command: serverCommand(state.remoteRepoPath),
    cwd: REMOTE_RUNTIME_ROOT,
  });
  let client: McpToolClient | undefined;
  try {
    client = await connectClient(transport);
    const discovered = (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
    if (JSON.stringify(discovered) !== JSON.stringify(expectedTools)) {
      throw new E2bTaskSessionError(
        "Recovered E2B MCP server did not expose the exact six-tool contract.",
      );
    }
    const nextState = {
      ...state,
      serverPid: transport.pid,
      activeMutation: recoveredMutation,
    };
    await options.store.save(nextState);
    return new OwnedE2bTaskSession({
      sandbox,
      remoteRepoPath: state.remoteRepoPath,
      baseSha: state.baseSha,
      client,
      serverPid: transport.pid,
      recoveredMutation,
      recovery: options,
      localRepoPath: options.localRepoPath ?? "",
      taskBranch: `task/${pathBasename(state.remoteRepoPath)}`,
      resultDeliveryStore:
        options.resultDeliveryStore ??
        (options.localRepoPath
          ? new FileResultDeliveryStore(options.localRepoPath)
          : new MemoryResultDeliveryStore()),
    });
  } catch (error) {
    await client?.close().catch(() => {});
    if (!client) {
      await transport.close().catch(() => {});
    }
    throw error instanceof E2bTaskSessionError
      ? error
      : new E2bTaskSessionError(
          "Failed to resume the recovered E2B task session.",
          { cause: error },
        );
  }
}

function throwIfSessionAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new DOMException(
    typeof signal.reason === "string"
      ? signal.reason
      : "E2B session setup was cancelled.",
    "AbortError",
  );
}

async function exportSandboxResult(
  sandbox: E2bSandbox,
  repositoryPath: string,
  branch: string,
  baseSha: string,
) {
  if (
    !repositoryPath.startsWith(`${REMOTE_TASKS_ROOT}/`) ||
    !/^task\/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(branch) ||
    !/^[a-f0-9]{40,64}$/.test(baseSha)
  ) {
    throw new E2bTaskSessionError(
      "Sandbox result export received invalid bound Git metadata.",
    );
  }
  const hardened = [
    "-c core.hooksPath=/dev/null",
    "-c commit.gpgSign=false",
    "-c protocol.ext.allow=never",
    "-c core.pager=cat",
  ].join(" ");
  const command = [
    "set -eu",
    `repo='${repositoryPath}'`,
    `branch='${branch}'`,
    `base='${baseSha}'`,
    `bundle='${REMOTE_RESULT_BUNDLE_PATH}'`,
    `current=$(git ${hardened} -C "$repo" symbolic-ref --quiet --short HEAD)`,
    '[ "$current" = "$branch" ]',
    `if [ -n "$(git ${hardened} -C "$repo" status --porcelain=v1 --untracked-files=all)" ]; then git ${hardened} -C "$repo" add -A && git ${hardened} -C "$repo" commit -m 'chore: deliver completed task' >/dev/null; fi`,
    `test -z "$(git ${hardened} -C "$repo" status --porcelain=v1 --untracked-files=all)"`,
    `result=$(git ${hardened} -C "$repo" rev-parse HEAD)`,
    `if [ "$result" = "$base" ]; then git ${hardened} -C "$repo" commit --allow-empty -m 'chore: record completed task' >/dev/null && result=$(git ${hardened} -C "$repo" rev-parse HEAD); fi`,
    `git ${hardened} -C "$repo" merge-base --is-ancestor "$base" "$result"`,
    `rm -f "$bundle"`,
    `git ${hardened} -C "$repo" bundle create "$bundle" "$base..refs/heads/$branch"`,
    'bytes=$(stat -c %s "$bundle")',
    `test "$bytes" -le ${MAX_RESULT_BUNDLE_BYTES}`,
    `printf '{"resultSha":"%s","bundleBytes":%s}\\n' "$result" "$bytes"`,
  ].join("\n");
  const exported = await sandbox.run(command, {
    cwd: REMOTE_RUNTIME_ROOT,
    timeoutMs: 60_000,
  });
  if (exported.exitCode !== 0) {
    throw new E2bTaskSessionError(
      `Sandbox result export failed: ${exported.stderr.trim() || "No diagnostic output."}`,
    );
  }
  let metadata;
  try {
    metadata = resultExportSchema.parse(JSON.parse(exported.stdout.trim()));
  } catch (error) {
    throw new E2bTaskSessionError(
      "Sandbox result export returned invalid metadata.",
      { cause: error },
    );
  }
  const bundle = await sandbox.readBytes(REMOTE_RESULT_BUNDLE_PATH);
  if (bundle.byteLength !== metadata.bundleBytes) {
    throw new E2bTaskSessionError(
      "Sandbox result bundle size changed during export.",
    );
  }
  return { baseSha, resultSha: metadata.resultSha, bundle };
}

function pathBasename(absolutePath: string): string {
  const value = absolutePath.split("/").filter(Boolean).at(-1);
  if (!value || !taskIdPattern.test(value)) {
    throw new E2bTaskSessionError(
      "Recovered task path cannot identify its bound branch.",
    );
  }
  return value;
}

async function reconcileRemoteMutation(
  sandbox: E2bSandbox,
  state: E2bSessionRecoveryState,
  timeoutMs: number,
  earlierRequestsDrained = false,
): Promise<MutationRecord> {
  const active = state.activeMutation;
  if (!active) {
    throw new E2bTaskSessionError(
      "Mutation reconciliation requires an active host record.",
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new E2bTaskSessionError(
      "Mutation reconciliation timeout must be a non-negative integer.",
    );
  }
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let serialized: string | undefined;
    try {
      serialized = await sandbox.readText(REMOTE_MUTATION_JOURNAL_PATH);
    } catch (error) {
      if (
        earlierRequestsDrained &&
        await remoteMutationJournalIsAbsent(sandbox)
      ) {
        return cancelledBeforeRemoteExecution(active);
      }
      if (Date.now() >= deadline) {
        throw new MutationRecoveryBlockedError(
          `Mutation ${active.operationId} has no readable sandbox journal result.`,
          {
            sandboxId: state.sandboxId,
            operationId: active.operationId,
            cause: error,
          },
        );
      }
    }

    if (serialized !== undefined) {
      let remoteState;
      try {
        remoteState = mutationJournalStateSchema.parse(
          JSON.parse(serialized),
        );
      } catch (error) {
        throw new MutationRecoveryBlockedError(
          `Mutation ${active.operationId} has an invalid sandbox journal result.`,
          {
            sandboxId: state.sandboxId,
            operationId: active.operationId,
            cause: error,
          },
        );
      }
      const remote = remoteState.active;
      if (
        !remote ||
        remote.operationId !== active.operationId ||
        remote.toolName !== active.toolName ||
        remote.inputHash !== active.inputHash
      ) {
        throw new MutationRecoveryBlockedError(
          `Mutation ${active.operationId} does not match the sandbox journal.`,
          {
            sandboxId: state.sandboxId,
            operationId: active.operationId,
          },
        );
      }
      if (remote.status === "completed" && remote.result) {
        return remote;
      }
      if (Date.now() >= deadline) {
        throw new MutationRecoveryBlockedError(
          `Mutation ${remote.operationId} is still in flight; refusing to replay it.`,
          {
            sandboxId: state.sandboxId,
            operationId: remote.operationId,
          },
        );
      }
    }

    await Bun.sleep(Math.min(RECONCILE_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

async function remoteMutationJournalIsAbsent(
  sandbox: E2bSandbox,
): Promise<boolean> {
  try {
    const result = await sandbox.run(
      `test ! -e ${REMOTE_MUTATION_JOURNAL_PATH}`,
      { timeoutMs: 5_000 },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function cancelledBeforeRemoteExecution(
  active: MutationRecord,
): MutationRecord {
  return {
    ...active,
    status: "completed",
    completedAt: new Date().toISOString(),
    result: {
      success: false,
      output: "Mutation was cancelled before remote execution began.",
      truncated: false,
      originalTokenCount: 0,
      codec: "reconciliation",
      metadata: { code: "CANCELLED" },
    },
  };
}

function viewportToolFailure(
  code: string,
  before?: { commit: string; tree: string; clean: boolean },
  after?: { commit: string; tree: string; clean: boolean },
): ToolResult {
  return {
    success: false,
    output: `Viewport verification failed (${code}).`,
    truncated: false,
    originalTokenCount: 8,
    codec: "viewport",
    metadata: {
      code,
      exitCode: null,
      timedOut: code.includes("TIMEOUT"),
      ...(before ? { gitCommitBefore: before.commit, gitTreeBefore: before.tree, gitCleanBefore: before.clean } : {}),
      ...(after ? { gitCommitAfter: after.commit, gitTreeAfter: after.tree, gitCleanAfter: after.clean } : {}),
    },
  };
}

async function raceViewportAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => Promise<void>): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { void onAbort().finally(() => reject(signal.reason ?? new DOMException("Aborted", "AbortError"))); };
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export function validateViewportPng(bytes: Uint8Array, width: number, height: number): void {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 33 || !signature.every((value, index) => bytes[index] === value) || new TextDecoder().decode(bytes.slice(12, 16)) !== "IHDR") {
    throw new E2bTaskSessionError("Viewport screenshot is not a valid PNG.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(16) !== width || view.getUint32(20) !== height) throw new E2bTaskSessionError("Viewport screenshot dimensions do not match its manifest.");
  let offset = 8;
  let sawIdat = false;
  let sawIend = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    if (length > bytes.byteLength - offset - 12) throw new E2bTaskSessionError("Viewport PNG contains a truncated chunk.");
    const type = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") { sawIend = length === 0 && offset + 12 === bytes.byteLength; break; }
    offset += 12 + length;
  }
  if (!sawIdat || !sawIend) throw new E2bTaskSessionError("Viewport PNG is missing required image chunks.");
}

export async function atomicEvidenceWrite(repositoryPath: string, relativePath: string, bytes: Uint8Array): Promise<void> {
  if (!relativePath.startsWith(".agent/evidence/") || relativePath.includes("..") || relativePath.includes("\\")) throw new E2bTaskSessionError("Viewport evidence path is invalid.");
  const agentDirectory = path.join(repositoryPath, ".agent");
  const directory = path.join(agentDirectory, "evidence");
  await safeDirectory(agentDirectory);
  await safeDirectory(directory);
  const target = path.join(repositoryPath, relativePath);
  if (!target.startsWith(`${directory}${path.sep}`)) throw new E2bTaskSessionError("Viewport evidence path escaped its protected directory.");
  try { if ((await lstat(target)).isSymbolicLink()) throw new E2bTaskSessionError("Refusing symlinked viewport evidence path."); } catch (error) { if (!isMissingError(error)) throw error; }
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function viewportEvidenceBytes(repositoryPath: string, replacementPaths: string[] = []): Promise<number> {
  const directory = path.join(repositoryPath, ".agent", "evidence");
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new E2bTaskSessionError("Refusing unsafe viewport evidence directory.");
  } catch (error) {
    if (isMissingError(error)) return 0;
    throw error;
  }
  const replacements = new Set(replacementPaths.map((item) => path.resolve(repositoryPath, item)));
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (replacements.has(target)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) throw new E2bTaskSessionError("Refusing unsafe viewport evidence entry.");
    total += (await lstat(target)).size;
    if (total > MAX_VIEWPORT_SCREENSHOT_TOTAL_BYTES) throw new E2bTaskSessionError("VIEWPORT_SCREENSHOT_BUDGET_EXCEEDED");
  }
  return total;
}

export async function readBoundedBytes(stream: ReadableStream<Uint8Array>, maximumBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("VIEWPORT_SCREENSHOT_TOO_LARGE");
        throw new E2bTaskSessionError("VIEWPORT_SCREENSHOT_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return combined;
}

async function safeDirectory(directory: string): Promise<void> {
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new E2bTaskSessionError("Refusing unsafe viewport evidence directory.");
  } catch (error) {
    if (!isMissingError(error)) throw error;
    await mkdir(directory, { mode: 0o700 });
  }
  await chmod(directory, 0o700);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isMissingError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export type { JSONRPCMessage };
