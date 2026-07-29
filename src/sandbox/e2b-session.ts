import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Sandbox } from "e2b";
import { z } from "zod";
import { McpToolClient } from "../mcp/client";
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

const DEFAULT_TIMEOUT_MS = 900_000;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 3_600_000;
const REMOTE_BUNDLE_PATH = "/tmp/repository.bundle";
const REMOTE_CONFIG_PATH = "/tmp/provision-task.json";
const REMOTE_TASKS_ROOT = "/workspace/tasks";
const REMOTE_RUNTIME_ROOT = "/opt/agent";
const SERVER_COMMAND =
  "bun run /opt/agent/src/mcp/stdio-server.ts --development-root /workspace/tasks";
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
      lifecycle: { onTimeout: "kill" };
      metadata: Record<string, string>;
    },
  ): Promise<E2bSandbox>;
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
  close(): Promise<void>;
};

export class E2bTaskSessionError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "E2bTaskSessionError";
  }
}

class OwnedE2bTaskSession implements E2bTaskSession {
  readonly sandboxId: string;
  readonly serverPid: number | null;
  readonly remoteRepoPath: string;
  readonly baseSha: string;
  readonly client: McpToolClient;

  readonly #sandbox: E2bSandbox;
  #closePromise: Promise<void> | undefined;

  constructor(options: {
    sandbox: E2bSandbox;
    remoteRepoPath: string;
    baseSha: string;
    client: McpToolClient;
    serverPid: number | null;
  }) {
    this.#sandbox = options.sandbox;
    this.sandboxId = options.sandbox.sandboxId;
    this.remoteRepoPath = options.remoteRepoPath;
    this.baseSha = options.baseSha;
    this.client = options.client;
    this.serverPid = options.serverPid;
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
      command: SERVER_COMMAND,
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

    return new OwnedE2bTaskSession({
      sandbox,
      remoteRepoPath: result.remoteRepoPath,
      baseSha: bundle.baseSha,
      client,
      serverPid: transport.pid,
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

export type { JSONRPCMessage };
