import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Sandbox } from "e2b";
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
import type {
  E2bSessionRecoveryState,
  E2bSessionRecoveryStore,
} from "./session-recovery";

const DEFAULT_TIMEOUT_MS = 900_000;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 3_600_000;
const REMOTE_BUNDLE_PATH = "/tmp/repository.bundle";
const REMOTE_CONFIG_PATH = "/tmp/provision-task.json";
const REMOTE_TASKS_ROOT = "/workspace/tasks";
const REMOTE_RUNTIME_ROOT = "/opt/agent";
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

export type E2bTaskSessionOptions = {
  localRepoPath: string;
  taskId: string;
  templateId: string;
  baseRef?: string;
  timeoutMs?: number;
  recovery?: {
    runIdentity: string;
    store: E2bSessionRecoveryStore;
  };
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
    async run(command, options = {}) {
      return sandbox.commands.run(command, options);
    },
    kill: () => sandbox.kill(),
  };
}

export const defaultE2bSandboxFactory: E2bSandboxFactory = {
  async create(templateId, options) {
    return sandboxAdapter(await Sandbox.create(templateId, options));
  },
  async connect(sandboxId) {
    return sandboxAdapter(await Sandbox.connect(sandboxId));
  },
  async reconcileCreateFailure(metadata) {
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
    options?: McpToolCallOptions,
  ): Promise<ToolResult>;
  close(): Promise<void>;
};

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
  #closePromise: Promise<void> | undefined;
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
  }) {
    this.#sandbox = options.sandbox;
    this.sandboxId = options.sandbox.sandboxId;
    this.remoteRepoPath = options.remoteRepoPath;
    this.baseSha = options.baseSha;
    this.client = options.client;
    this.serverPid = options.serverPid;
    this.recoveredMutation = options.recoveredMutation ?? null;
    this.#recovery = options.recovery;
  }

  async call(
    request: ModelToolRequest,
    options: McpToolCallOptions = {},
  ): Promise<ToolResult> {
    const operation = async () => this.#call(request, options);
    const previous = this.#callTail;
    let release!: () => void;
    this.#callTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#close();
    await this.#closePromise;
  }

  async #close(): Promise<void> {
    const errors: unknown[] = [];
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
    options: McpToolCallOptions,
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
    const result = await this.client.call(request, {
      ...options,
      operationId,
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
      });
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

    const bundleBytes = await readFile(bundle.bundlePath);
    await sandbox.write(
      REMOTE_BUNDLE_PATH,
      new Uint8Array(bundleBytes).buffer,
    );
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
    const discovered = (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
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
  },
  dependencies: {
    sandboxFactory?: E2bSandboxFactory;
    connectClient?: (
      transport: E2bStdioTransport,
    ) => Promise<McpToolClient>;
  } = {},
): Promise<E2bTaskSession> {
  const state = await options.store.load();
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
    let remoteState;
    try {
      remoteState = mutationJournalStateSchema.parse(
        JSON.parse(
          await sandbox.readText(REMOTE_MUTATION_JOURNAL_PATH),
        ),
      );
    } catch (error) {
      throw new MutationRecoveryBlockedError(
        `Mutation ${state.activeMutation.operationId} has no trustworthy sandbox journal result.`,
        {
          sandboxId: state.sandboxId,
          operationId: state.activeMutation.operationId,
          cause: error,
        },
      );
    }
    const remote = remoteState.active;
    if (
      !remote ||
      remote.operationId !== state.activeMutation.operationId ||
      remote.toolName !== state.activeMutation.toolName ||
      remote.inputHash !== state.activeMutation.inputHash
    ) {
      throw new MutationRecoveryBlockedError(
        `Mutation ${state.activeMutation.operationId} does not match the sandbox journal.`,
        {
          sandboxId: state.sandboxId,
          operationId: state.activeMutation.operationId,
        },
      );
    }
    if (remote.status !== "completed" || !remote.result) {
      throw new MutationRecoveryBlockedError(
        `Mutation ${remote.operationId} is still in flight; refusing to replay it.`,
        {
          sandboxId: state.sandboxId,
          operationId: remote.operationId,
        },
      );
    }
    recoveredMutation = remote;
    await options.store.save({
      ...state,
      activeMutation: remote,
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

export type { JSONRPCMessage };
