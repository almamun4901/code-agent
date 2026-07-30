import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpToolClient } from "../src/mcp/client";
import {
  E2bTaskSessionError,
  MutationRecoveryBlockedError,
  REMOTE_MUTATION_JOURNAL_PATH,
  createE2bTaskSession,
  recoverE2bTaskSession,
  type E2bSandbox,
  type E2bSandboxFactory,
} from "../src/sandbox/e2b-session";
import {
  E2bSessionRecoveryError,
  FileE2bSessionRecoveryStore,
  MemoryE2bSessionRecoveryStore,
} from "../src/sandbox/session-recovery";
import { mutationInputHash } from "../src/tools/mutation-journal";
import type { ModelToolRequest, ToolResult } from "../src/tools/contracts";
import type {
  E2bCommandStartOptions,
  E2bCommandHandle,
} from "../src/sandbox/e2b-stdio-transport";
import {
  RUNTIME_MANIFEST_PATH,
  createRuntimeManifest,
} from "../src/sandbox/runtime-manifest";
import {
  RepositoryBundleError,
  createRepositoryBundle,
} from "../src/sandbox/repository-bundle";
import {
  provisionTask,
  taskGroupForLayout,
} from "../src/sandbox/provision-task";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "./support/temp-repo";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const repositories: TemporaryRepository[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repo) => repo.cleanup()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function fixture(): Promise<TemporaryRepository> {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  return repository;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout.trim();
}

describe("repository bundle intake", () => {
  test("uses the fixed shared group for the E2B filesystem layout", () => {
    expect(
      taskGroupForLayout(
        {
          workspaceRoot: "/workspace",
          seedPath: "/workspace/seed",
          tasksRoot: "/workspace/tasks",
        },
        "",
      ),
    ).toBe("task");
  });

  test("bundles the exact clean attached revision and cleans up idempotently", async () => {
    const repository = await fixture();
    const bundle = await createRepositoryBundle(repository.worktreePath);
    const cloneRoot = await mkdtemp(path.join(os.tmpdir(), "bundle-clone-"));
    temporaryRoots.push(cloneRoot);

    expect(bundle.baseSha).toBe(
      await git(repository.worktreePath, "rev-parse", "HEAD"),
    );
    expect(bundle.branch).toBe("agent-step2");
    expect((await stat(bundle.bundlePath)).isFile()).toBe(true);
    await git(cloneRoot, "clone", bundle.bundlePath, "clone");
    expect(await git(path.join(cloneRoot, "clone"), "rev-parse", "HEAD")).toBe(
      bundle.baseSha,
    );

    await bundle.cleanup();
    await bundle.cleanup();
    await expect(stat(bundle.bundlePath)).rejects.toThrow();
  });

  test("creates a branch-backed worktree at the exact bundled SHA", async () => {
    const repository = await fixture();
    const bundle = await createRepositoryBundle(repository.worktreePath);
    const workspaceRoot = await mkdtemp(
      path.join(os.tmpdir(), "provision-task-"),
    );
    temporaryRoots.push(workspaceRoot);
    const tasksRoot = path.join(workspaceRoot, "tasks");
    const seedPath = path.join(workspaceRoot, "seed");

    const result = await provisionTask(
      {
        bundlePath: bundle.bundlePath,
        taskId: "offline-task",
        baseSha: bundle.baseSha,
      },
      { workspaceRoot, seedPath, tasksRoot },
    );

    expect(result).toEqual({
      remoteRepoPath: path.join(tasksRoot, "offline-task"),
      branch: "task/offline-task",
      baseSha: bundle.baseSha,
    });
    expect(await git(result.remoteRepoPath, "rev-parse", "HEAD")).toBe(
      bundle.baseSha,
    );
    expect(
      await git(result.remoteRepoPath, "branch", "--show-current"),
    ).toBe("task/offline-task");
    await bundle.cleanup();
  });

  test("rejects non-root, dirty, detached, and missing-ref inputs", async () => {
    const repository = await fixture();

    await expect(
      createRepositoryBundle(path.join(repository.worktreePath, "src")),
    ).rejects.toThrow("root");

    await repository.write("untracked.txt", "dirty");
    await expect(
      createRepositoryBundle(repository.worktreePath),
    ).rejects.toThrow("clean");
    await rm(path.join(repository.worktreePath, "untracked.txt"));

    await git(repository.worktreePath, "checkout", "--detach");
    await expect(
      createRepositoryBundle(repository.worktreePath),
    ).rejects.toThrow("attached");
    await git(repository.worktreePath, "switch", "agent-step2");

    await expect(
      createRepositoryBundle(repository.worktreePath, "missing-ref"),
    ).rejects.toThrow("Unknown baseRef");
    await expect(
      createRepositoryBundle("relative/repository"),
    ).rejects.toBeInstanceOf(RepositoryBundleError);
  });
});

describe("E2B session recovery store", () => {
  test("persists a strict mode-0600 lease and fails closed on corruption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "session-recovery-"));
    temporaryRoots.push(root);
    const leasePath = path.join(root, "nested", "session.json");
    const store = new FileE2bSessionRecoveryStore(leasePath);
    const state = {
      version: 1 as const,
      runIdentity: "durable-run",
      sandboxId: "sandbox-test",
      serverPid: 42,
      remoteRepoPath: "/workspace/tasks/durable-run",
      baseSha: "a".repeat(40),
      activeMutation: null,
    };

    expect(await store.load()).toBeNull();
    await store.save(state);
    expect((await stat(leasePath)).mode & 0o777).toBe(0o600);
    expect(await store.load()).toEqual(state);

    await writeFile(leasePath, '{"version":1,"unexpected":true}\n');
    await expect(store.load()).rejects.toBeInstanceOf(
      E2bSessionRecoveryError,
    );

    await store.clear();
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

class FakeSandbox implements E2bSandbox {
  readonly sandboxId = "sandbox-test";
  readonly writes = new Map<string, string | ArrayBuffer>();
  readonly commands = {
    async run(
      _command: string,
      _options: E2bCommandStartOptions,
    ): Promise<E2bCommandHandle> {
      throw new Error("Transport command should not start in session unit tests.");
    },
    async sendStdin(): Promise<void> {},
    async kill(): Promise<boolean> {
      return true;
    },
  };
  manifest = "";
  mutationJournal = "";
  baseSha = "";
  taskId = "";
  provisionExitCode = 0;
  provisionStdout: string | undefined;
  readError: unknown;
  writeError: unknown;
  runError: unknown;
  killError: unknown;
  killCalls = 0;
  runCalls = 0;

  async write(remotePath: string, data: string | ArrayBuffer): Promise<void> {
    if (this.writeError) throw this.writeError;
    this.writes.set(remotePath, data);
  }

  async readText(remotePath: string): Promise<string> {
    if (this.readError) throw this.readError;
    if (remotePath === RUNTIME_MANIFEST_PATH) return this.manifest;
    if (remotePath === REMOTE_MUTATION_JOURNAL_PATH) {
      if (!this.mutationJournal) {
        throw Object.assign(new Error("missing journal"), { code: "ENOENT" });
      }
      return this.mutationJournal;
    }
    throw new Error(`Unexpected read path: ${remotePath}`);
  }

  async run(command = "") {
    this.runCalls += 1;
    if (this.runError) throw this.runError;
    if (command === `test ! -e ${REMOTE_MUTATION_JOURNAL_PATH}`) {
      return {
        exitCode: this.mutationJournal ? 1 : 0,
        stderr: "",
        stdout: "",
      };
    }
    return {
      exitCode: this.provisionExitCode,
      stderr: this.provisionExitCode === 0 ? "" : "provision failed",
      stdout:
        this.provisionStdout ??
        JSON.stringify({
          remoteRepoPath: `/workspace/tasks/${this.taskId}`,
          branch: `task/${this.taskId}`,
          baseSha: this.baseSha,
        }),
    };
  }

  async kill(): Promise<void> {
    this.killCalls += 1;
    if (this.killError) throw this.killError;
  }
}

class FakeClient {
  tools = [
    "edit_file",
    "git",
    "read_file",
    "ripgrep",
    "run_shell",
    "tree_sitter_symbols",
  ];
  closeCalls = 0;
  closeError: unknown;
  callError: unknown;
  callErrors: unknown[] = [];
  calls: ModelToolRequest[] = [];
  callGate: Promise<void> | undefined;
  result: ToolResult = {
    success: true,
    output: "ok",
    truncated: false,
    originalTokenCount: 1,
    codec: "test",
  };

  async listTools() {
    return { tools: this.tools.map((name) => ({ name })) };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
  }

  async call(request: ModelToolRequest): Promise<ToolResult> {
    this.calls.push(request);
    await this.callGate;
    if (this.callErrors.length > 0) {
      const error = this.callErrors.shift();
      if (error) throw error;
    }
    if (this.callError) throw this.callError;
    return this.result;
  }
}

async function sessionFixture(options: {
  sandbox?: FakeSandbox;
  client?: FakeClient;
  repository?: TemporaryRepository;
  createError?: unknown;
} = {}) {
  const repository = options.repository ?? (await fixture());
  const sandbox = options.sandbox ?? new FakeSandbox();
  const client = options.client ?? new FakeClient();
  let reconcileCalls = 0;
  let reconnectCalls = 0;
  sandbox.manifest = JSON.stringify(await createRuntimeManifest(projectRoot));

  const factory: E2bSandboxFactory = {
    async create(_templateId, createOptions) {
      if (options.createError) throw options.createError;
      expect(createOptions).toMatchObject({
        secure: true,
        allowInternetAccess: false,
        lifecycle: { onTimeout: "kill" },
      });
      sandbox.baseSha = createOptions.metadata.baseSha ?? "";
      sandbox.taskId = createOptions.metadata.taskId ?? "";
      expect(createOptions.metadata.creationId).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      return sandbox;
    },
    async reconcileCreateFailure(metadata) {
      reconcileCalls += 1;
      expect(metadata.creationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(Object.keys(metadata)).toEqual(["creationId"]);
    },
    async connect(sandboxId) {
      reconnectCalls += 1;
      expect(sandboxId).toBe(sandbox.sandboxId);
      return sandbox;
    },
  };

  return {
    repository,
    sandbox,
    client,
    get reconcileCalls() {
      return reconcileCalls;
    },
    get reconnectCalls() {
      return reconnectCalls;
    },
    factory,
    create: (overrides: Partial<Parameters<typeof createE2bTaskSession>[0]> = {}) =>
      createE2bTaskSession(
        {
          localRepoPath: repository.worktreePath,
          taskId: "task-5",
          templateId: "template-test",
          ...overrides,
        },
        {
          sandboxFactory: factory,
          connectClient: async () =>
            client as unknown as McpToolClient,
        },
      ),
  };
}

describe("E2B task session", () => {
  test("uploads a bundle, provisions the exact worktree, and closes once", async () => {
    const setup = await sessionFixture();
    const session = await setup.create();

    expect(session).toMatchObject({
      sandboxId: "sandbox-test",
      serverPid: null,
      remoteRepoPath: "/workspace/tasks/task-5",
      baseSha: setup.sandbox.baseSha,
    });
    expect(setup.sandbox.writes.has("/tmp/repository.bundle")).toBe(true);
    expect(setup.sandbox.writes.has("/tmp/provision-task.json")).toBe(true);
    expect(setup.sandbox.runCalls).toBe(1);

    await Promise.all([session.close(), session.close()]);
    expect(setup.client.closeCalls).toBe(1);
    expect(setup.sandbox.killCalls).toBe(1);
  });

  test("validates task, template, timeout, and repository before sandbox creation", async () => {
    const setup = await sessionFixture();

    await expect(setup.create({ taskId: "../escape" })).rejects.toThrow(
      "taskId",
    );
    await expect(setup.create({ templateId: " " })).rejects.toThrow(
      "templateId",
    );
    await expect(setup.create({ timeoutMs: 1 })).rejects.toThrow("timeoutMs");
    await setup.repository.write("dirty.txt", "dirty");
    await expect(setup.create()).rejects.toThrow("clean");
    expect(setup.sandbox.killCalls).toBe(0);
  });

  test("fails closed for runtime and provision result mismatches", async () => {
    const badManifest = new FakeSandbox();
    badManifest.manifest = "{}";
    const manifestSetup = await sessionFixture({ sandbox: badManifest });
    badManifest.manifest = "{}";
    await expect(manifestSetup.create()).rejects.toThrow("runtime manifest");
    expect(badManifest.killCalls).toBe(1);

    const badProvision = new FakeSandbox();
    const provisionSetup = await sessionFixture({ sandbox: badProvision });
    badProvision.provisionStdout = JSON.stringify({
      remoteRepoPath: "/workspace/tasks/other",
      branch: "task/other",
      baseSha: "0".repeat(40),
    });
    await expect(provisionSetup.create()).rejects.toThrow(
      "unexpected worktree",
    );
    expect(badProvision.killCalls).toBe(1);
  });

  test("cleans the sandbox for upload, provision, and discovery failures", async () => {
    for (const failure of ["upload", "provision", "discovery"] as const) {
      const sandbox = new FakeSandbox();
      const client = new FakeClient();
      if (failure === "upload") sandbox.writeError = new Error("upload failed");
      if (failure === "provision") sandbox.runError = new Error("run failed");
      if (failure === "discovery") client.tools = ["read_file"];
      const setup = await sessionFixture({ sandbox, client });

      await expect(setup.create()).rejects.toBeInstanceOf(E2bTaskSessionError);
      expect(sandbox.killCalls).toBe(1);
      expect(client.closeCalls).toBe(failure === "discovery" ? 1 : 0);
    }
  });

  test("reconciles an ambiguous sandbox create failure without retrying", async () => {
    const setup = await sessionFixture({
      createError: new Error("truncated create response"),
    });

    await expect(setup.create()).rejects.toThrow("truncated create response");
    expect(setup.reconcileCalls).toBe(1);
    expect(setup.sandbox.killCalls).toBe(0);
  });

  test("attempts sandbox cleanup when client close fails", async () => {
    const client = new FakeClient();
    client.closeError = new Error("client close failed");
    const setup = await sessionFixture({ client });
    const session = await setup.create();

    await expect(session.close()).rejects.toBeInstanceOf(AggregateError);
    expect(setup.sandbox.killCalls).toBe(1);
  });

  test("persists a sandbox lease and recovers a completed mutation", async () => {
    const setup = await sessionFixture();
    const store = new MemoryE2bSessionRecoveryStore();
    const runIdentity = "recovery-run";
    const session = await setup.create({
      recovery: { runIdentity, store },
    });
    const request: ModelToolRequest = {
      name: "run_shell",
      input: { cwd: ".", command: "printf safe" },
    };
    const operationId = crypto.randomUUID();

    expect((await store.load())?.sandboxId).toBe("sandbox-test");
    await session.call(request, { operationId });
    const completed = (await store.load())?.activeMutation;
    expect(completed).toMatchObject({
      operationId,
      status: "completed",
    });
    setup.sandbox.mutationJournal = JSON.stringify({
      version: 1,
      active: completed,
    });

    const recovered = await recoverE2bTaskSession(
      { runIdentity, store },
      {
        sandboxFactory: setup.factory,
        connectClient: async () =>
          setup.client as unknown as McpToolClient,
      },
    );

    expect(setup.reconnectCalls).toBe(1);
    expect(recovered.recoveredMutation).toMatchObject({
      operationId,
      status: "completed",
    });
    await recovered.close();
    expect(await store.load()).toBeNull();
  });

  test("leaves an ambiguous mutation in place and refuses replay", async () => {
    const setup = await sessionFixture();
    const store = new MemoryE2bSessionRecoveryStore();
    const runIdentity = "blocked-run";
    const request: ModelToolRequest = {
      name: "run_shell",
      input: { cwd: ".", command: "printf ambiguous" },
    };
    const operationId = crypto.randomUUID();
    const activeMutation = {
      operationId,
      toolName: "run_shell" as const,
      inputHash: mutationInputHash(request),
      status: "in_flight" as const,
      startedAt: new Date().toISOString(),
      completedAt: null,
      result: null,
    };
    await store.save({
      version: 1,
      runIdentity,
      sandboxId: setup.sandbox.sandboxId,
      serverPid: null,
      remoteRepoPath: "/workspace/tasks/task-5",
      baseSha: "a".repeat(40),
      activeMutation,
    });
    setup.sandbox.mutationJournal = JSON.stringify({
      version: 1,
      active: activeMutation,
    });

    await expect(
      recoverE2bTaskSession(
        { runIdentity, store, reconcileTimeoutMs: 0 },
        {
          sandboxFactory: setup.factory,
          connectClient: async () =>
            setup.client as unknown as McpToolClient,
        },
      ),
    ).rejects.toBeInstanceOf(MutationRecoveryBlockedError);
    expect(setup.sandbox.killCalls).toBe(0);
    expect((await store.load())?.activeMutation?.status).toBe("in_flight");
  });

  test("waits for an active call before clearing the session lease", async () => {
    const client = new FakeClient();
    let releaseCall!: () => void;
    client.callGate = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const setup = await sessionFixture({ client });
    const store = new MemoryE2bSessionRecoveryStore();
    const session = await setup.create({
      recovery: { runIdentity: "close-order-run", store },
    });
    const call = session.call({
      name: "run_shell",
      input: { cwd: ".", command: "printf complete" },
    });
    await Bun.sleep(10);
    const close = session.close();
    await Bun.sleep(10);

    expect(client.closeCalls).toBe(0);
    expect(setup.sandbox.killCalls).toBe(0);
    releaseCall();
    await call;
    await close;
    expect(client.closeCalls).toBe(1);
    expect(setup.sandbox.killCalls).toBe(1);
    expect(await store.load()).toBeNull();
    await expect(
      session.call({
        name: "read_file",
        input: { path: "README.md" },
      }),
    ).rejects.toThrow("closing or closed");
  });

  test("requires terminal reconciliation before closing an ambiguous mutation", async () => {
    const client = new FakeClient();
    client.callError = new Error("transport disconnected");
    const setup = await sessionFixture({ client });
    const store = new MemoryE2bSessionRecoveryStore();
    const session = await setup.create({
      recovery: { runIdentity: "cancel-reconcile-run", store },
    });
    await expect(
      session.call({
        name: "run_shell",
        input: { cwd: ".", command: "printf maybe" },
      }),
    ).rejects.toThrow("transport disconnected");
    const active = (await store.load())?.activeMutation;
    expect(active?.status).toBe("in_flight");

    await expect(session.close()).rejects.toBeInstanceOf(
      MutationRecoveryBlockedError,
    );
    expect(setup.sandbox.killCalls).toBe(0);
    setup.sandbox.mutationJournal = JSON.stringify({
      version: 1,
      active: {
        ...active,
        status: "completed",
        completedAt: new Date().toISOString(),
        result: client.result,
      },
    });

    expect(await session.reconcileActiveMutation(0)).toMatchObject({
      operationId: active?.operationId,
      status: "completed",
    });
    await session.close();
    expect(setup.sandbox.killCalls).toBe(1);
    expect(await store.load()).toBeNull();
  });

  test("closes safely when a cancelled mutation never reached the remote queue", async () => {
    const client = new FakeClient();
    client.callErrors = [new Error("request cancelled"), undefined];
    const setup = await sessionFixture({ client });
    const store = new MemoryE2bSessionRecoveryStore();
    const session = await setup.create({
      recovery: { runIdentity: "cancel-before-remote-run", store },
    });

    await expect(
      session.call({
        name: "run_shell",
        input: { cwd: ".", command: "printf never-started" },
      }),
    ).rejects.toThrow("request cancelled");

    expect(await session.reconcileActiveMutation(0)).toMatchObject({
      status: "completed",
      result: {
        success: false,
        metadata: { code: "CANCELLED" },
      },
    });
    expect(client.calls.at(-1)).toEqual({
      name: "read_file",
      input: { path: ".git" },
    });

    await session.close();
    expect(setup.sandbox.killCalls).toBe(1);
    expect(await store.load()).toBeNull();
  });
});
