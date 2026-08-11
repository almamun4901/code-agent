import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CallModel,
  ModelTurn,
} from "../src/model/contracts";
import type { E2bTaskSession } from "../src/sandbox/e2b-session";
import { MemoryE2bSessionRecoveryStore } from "../src/sandbox/session-recovery";
import { MemoryResultDeliveryStore } from "../src/sandbox/result-delivery";
import type {
  McpToolCallOptions,
} from "../src/mcp/client";
import {
  AgentRunConfigurationError,
  prepareAgentRun,
  runHeadlessAgent,
  startAgentRun,
  type HeadlessAgentRunOptions,
  type SessionEndContext,
} from "../src/runtime/agent-runner";
import type { AgentEvent } from "../src/runtime/events";
import {
  FileProductionCheckpointStore,
  MemoryProductionCheckpointStore,
  ProductionCheckpointError,
  type ProductionCheckpointStore,
} from "../src/runtime/checkpoint";
import {
  runProductionLoop,
  type ProductionLoopOptions,
} from "../src/runtime/production-loop";
import type { ProductionAgentState } from "../src/runtime/schema";
import { createLegacyExecutionApprovalState } from "./support/approval";
import type {
  ModelToolRequest,
  ToolResult,
} from "../src/tools/contracts";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "./support/temp-repo";

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

async function repository(): Promise<TemporaryRepository> {
  const repo = await createTemporaryRepository();
  repositories.push(repo);
  return repo;
}

describe("production agent loop", () => {
  test("runs model → plan → MCP tool → checkpoint to completion", async () => {
    const repo = await repository();
    const prepared = await prepareAgentRun(
      repo.worktreePath,
      "Update the greeting",
    );
    const store = new MemoryProductionCheckpointStore(initialState(prepared));
    const session = new FakeSession();
    const callModel = queuedModel([
      turn(
        plan([
          ["inspect", "Inspect the greeting", "in_progress"],
          ["change", "Update the greeting", "pending"],
        ]),
        action("read-1", "read_file", { path: "src/example.ts" }),
      ),
      turn(
        plan([
          ["inspect", "Inspect the greeting", "completed"],
          ["change", "Update the greeting", "in_progress"],
        ]),
        action("edit-1", "edit_file", {
          path: "src/example.ts",
          mode: "apply",
          oldText: "Hello",
          newText: "Hello, agent",
        }),
      ),
      turn(
        plan([
          ["inspect", "Inspect the greeting", "completed"],
          ["change", "Update the greeting", "completed"],
        ]),
      ),
    ]);

    const result = await runProductionLoop({
      ...prepared,
      callModel,
      session,
      checkpointStore: store,
    });

    expect(result).toMatchObject({
      status: "completed",
      modelTurns: 3,
      acceptedTurns: 3,
      toolCalls: 2,
      planRewrites: 3,
      inputTokens: 30,
      outputTokens: 15,
    });
    expect(session.calls.map((call) => call.request.name)).toEqual([
      "read_file",
      "edit_file",
    ]);
    expect((await store.load())?.lifecycle).toBe("completed");
    expect((await store.load())?.pendingTurn).toBeNull();

    const completedSession = new FakeSession();
    await expect(
      runProductionLoop({
        ...prepared,
        callModel: queuedModel([]),
        session: completedSession,
        checkpointStore: store,
      }),
    ).resolves.toEqual(result);
    expect(completedSession.calls).toHaveLength(0);
  });

  test("resumes a pending mutation with its durable operation ID", async () => {
    const repo = await repository();
    const prepared = await prepareAgentRun(repo.worktreePath, "Edit safely");
    const store = new MemoryProductionCheckpointStore(initialState(prepared));
    const abort = new AbortController();
    const firstSession = new FakeSession();
    firstSession.callImpl = async (_request, options) => {
      abort.abort();
      throw new DOMException("cancelled", "AbortError");
    };
    const model = queuedModel([
      turn(
        plan([["change", "Edit safely", "in_progress"]]),
        action("edit-1", "edit_file", {
          path: "src/example.ts",
          mode: "apply",
          oldText: "Hello",
          newText: "Safe",
        }),
      ),
    ]);
    const firstOptions: ProductionLoopOptions = {
      ...prepared,
      callModel: model,
      session: firstSession,
      checkpointStore: store,
      signal: abort.signal,
    };

    await expect(runProductionLoop(firstOptions)).rejects.toThrow();
    const pending = (await store.load())?.pendingTurn;
    expect(pending?.action?.operationId).toMatch(/^[0-9a-f-]{36}$/);

    const resumedSession = new FakeSession();
    const finishModel = queuedModel([
      turn(plan([["change", "Edit safely", "completed"]])),
    ]);
    await expect(
      runProductionLoop({
        ...prepared,
        callModel: finishModel,
        session: resumedSession,
        checkpointStore: store,
      }),
    ).resolves.toMatchObject({ status: "completed", toolCalls: 1 });
    expect(resumedSession.calls[0]?.options.operationId).toBe(
      pending?.action?.operationId,
    );
  });

  test("rejects a pending checkpoint that disagrees with model content", async () => {
    const repo = await repository();
    const prepared = await prepareAgentRun(
      repo.worktreePath,
      "Reject altered intent",
    );
    const store = new MemoryProductionCheckpointStore(initialState(prepared));
    const abort = new AbortController();
    const interrupted = new FakeSession();
    interrupted.callImpl = async () => {
      abort.abort();
      throw new DOMException("cancelled", "AbortError");
    };
    await expect(
      runProductionLoop({
        ...prepared,
        callModel: queuedModel([
          turn(
            plan([["inspect", "Reject altered intent", "in_progress"]]),
            action("read-original", "read_file", {
              path: "README.md",
            }),
          ),
        ]),
        session: interrupted,
        checkpointStore: store,
        signal: abort.signal,
      }),
    ).rejects.toThrow();

    const altered = await store.load();
    if (!altered?.pendingTurn?.action) {
      throw new Error("Expected a pending action.");
    }
    altered.pendingTurn.action.request = {
      name: "read_file",
      input: { path: "package.json" },
    };
    const alteredStore = new MemoryProductionCheckpointStore(altered);
    const resumed = new FakeSession();

    await expect(
      runProductionLoop({
        ...prepared,
        callModel: queuedModel([]),
        session: resumed,
        checkpointStore: alteredStore,
      }),
    ).rejects.toThrow("pending turn does not match");
    expect(resumed.calls).toHaveLength(0);
  });

  test("accepts a sequential plan then action handshake", async () => {
    const repo = await repository();
    const prepared = await prepareAgentRun(
      repo.worktreePath,
      "Inspect sequentially",
    );
    const store = new MemoryProductionCheckpointStore(initialState(prepared));
    const session = new FakeSession();

    const result = await runProductionLoop({
      ...prepared,
      callModel: queuedModel([
        turn(plan([["inspect", "Inspect sequentially", "in_progress"]])),
        {
          content: [
            action("read-sequential", "read_file", {
              path: "README.md",
            }),
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        turn(plan([["inspect", "Inspect sequentially", "completed"]])),
      ]),
      session,
      checkpointStore: store,
    });

    expect(result).toMatchObject({
      status: "completed",
      modelTurns: 3,
      acceptedTurns: 3,
      toolCalls: 1,
      planRewrites: 2,
    });
    expect(session.calls[0]?.request.name).toBe("read_file");
  });

  test("supports provider-native action chains and bounded replanning", async () => {
    const repo = await repository();
    const prepared = await prepareAgentRun(
      repo.worktreePath,
      "Inspect and verify",
    );
    const session = new FakeSession();

    const result = await runProductionLoop({
      ...prepared,
      callModel: queuedModel([
        turn(
          plan([
            ["setup", "Understand the task", "completed"],
            ["inspect", "Inspect the file", "in_progress"],
            ["verify", "Verify repository state", "pending"],
          ]),
        ),
        {
          content: [
            action("read-chain", "read_file", { path: "README.md" }),
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        {
          content: [
            action("git-chain", "git", { subcommand: "status" }),
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        turn(
          plan([
            ["setup", "Understand the task", "completed"],
            ["inspect", "Inspect the file", "completed"],
            ["verify", "Verify repository state", "in_progress"],
          ]),
        ),
        turn(
          plan([
            ["final", "Record verified completion", "in_progress"],
          ]),
        ),
        {
          content: [
            action("final-status", "git", { subcommand: "status" }),
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        turn(
          plan([
            ["final", "Record verified completion", "completed"],
          ]),
        ),
      ]),
      session,
      checkpointStore: new MemoryProductionCheckpointStore(initialState(prepared)),
    });

    expect(result).toMatchObject({
      status: "completed",
      modelTurns: 7,
      toolCalls: 3,
      planRewrites: 4,
    });
    expect(session.calls.map((call) => call.request.name)).toEqual([
      "read_file",
      "git",
      "git",
    ]);
  });

  test("rejects two malformed turns and persists the terminal failure", async () => {
    const repo = await repository();
    const prepared = await prepareAgentRun(repo.worktreePath, "Fail closed");
    const store = new MemoryProductionCheckpointStore(initialState(prepared));
    const badTurn: ModelTurn = {
      content: [{ type: "text", text: "No tools" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };

    await expect(
      runProductionLoop({
        ...prepared,
        callModel: queuedModel([badTurn, badTurn]),
        session: new FakeSession(),
        checkpointStore: store,
      }),
    ).rejects.toThrow("Expected tool_use");
    expect(await store.load()).toMatchObject({
      lifecycle: "failed",
      consecutiveInvalidAttempts: 1,
      counters: { modelTurns: 2, protocolRetries: 1 },
    });
  });
});

describe("host-side production runner", () => {
  test("validates the canonical repository and task before external activity", async () => {
    const repo = await repository();
    await expect(
      prepareAgentRun(repo.worktreePath, "  "),
    ).rejects.toBeInstanceOf(AgentRunConfigurationError);
    await expect(
      prepareAgentRun(repo.worktreePath, "x".repeat(32 * 1024 + 1)),
    ).rejects.toThrow("must not exceed");
    await expect(
      prepareAgentRun("relative/repo", "task"),
    ).rejects.toThrow("absolute");
    await expect(
      prepareAgentRun(path.join(repo.worktreePath, "src"), "task"),
    ).rejects.toThrow("root");
  });

  test("fails a checkpoint identity mismatch without model or sandbox calls", async () => {
    const repo = await repository();
    const other = await prepareAgentRun(repo.worktreePath, "another task");
    const store = new MemoryProductionCheckpointStore(
      initialState(other),
    );
    let modelCalls = 0;
    let sessionCalls = 0;

    await expect(
      runHeadlessAgent({
        repoPath: repo.worktreePath,
        task: "requested task",
        templateId: "template:test",
        approvalMode: "auto",
        checkpointStore: store,
        callModel: async () => {
          modelCalls += 1;
          throw new Error("must not run");
        },
        openSession: async () => {
          sessionCalls += 1;
          return new FakeSession() as unknown as E2bTaskSession;
        },
      }),
    ).rejects.toThrow("another repository or task");
    expect(modelCalls).toBe(0);
    expect(sessionCalls).toBe(0);
  });

  test("rejects an unknown model provider before opening a sandbox", async () => {
    const repo = await repository();
    let sessionCalls = 0;
    await expect(
      runHeadlessAgent({
        repoPath: repo.worktreePath,
        task: "Validate provider",
      templateId: "template:test",
      approvalMode: "auto",
      checkpointStore: new MemoryProductionCheckpointStore(),
        modelProvider: "unknown" as "anthropic",
        openSession: async () => {
          sessionCalls += 1;
          return new FakeSession() as unknown as E2bTaskSession;
        },
      }),
    ).rejects.toThrow('must be "anthropic" or "openrouter"');
    expect(sessionCalls).toBe(0);
  });

  test("reconciles mutations before closing the sandbox", async () => {
    const repo = await repository();
    const session = new FakeSession();
    const checkpointStore = new MemoryProductionCheckpointStore();
    const result = await runHeadlessAgent({
      repoPath: repo.worktreePath,
      task: "Inspect one file",
      templateId: "template:test",
      approvalMode: "auto",
      checkpointStore,
      sessionRecoveryStore: new MemoryE2bSessionRecoveryStore(),
      callModel: queuedModel([
        turn(
          plan([["inspect", "Inspect one file", "in_progress"]]),
          action("read", "read_file", { path: "README.md" }),
        ),
        turn(plan([["inspect", "Inspect one file", "completed"]])),
      ]),
      openSession: async () =>
        session as unknown as E2bTaskSession,
    });

    expect(result.status).toBe("completed");
    expect(result).toMatchObject({ delivery: { version: 2 }, completion: { version: 1, resultTree: "b".repeat(40) } });
    expect(await checkpointStore.load()).toMatchObject({ lifecycle: "completed", legacyCompletionStatus: "verified", completion: { resultTree: "b".repeat(40) } });
    expect(session.lifecycle).toEqual(["reconcile", "deliver", "close"]);
  });

  test("resumes a completed checkpoint from its durable delivery receipt without reopening E2B", async () => {
    const repo = await repository();
    const prepared = await prepareAgentRun(repo.worktreePath, "Deliver once");
    const checkpointStore = new MemoryProductionCheckpointStore(initialState(prepared));
    await runProductionLoop({
      ...prepared,
      callModel: queuedModel([
        turn(
          plan([["inspect", "Inspect", "in_progress"]]),
          action("read", "read_file", { path: "README.md" }),
        ),
        turn(plan([["inspect", "Inspect", "completed"]])),
      ]),
      session: new FakeSession(),
      checkpointStore,
    });
    const resultDeliveryStore = new MemoryResultDeliveryStore();
    const resultSha = await git(prepared.canonicalRepoPath, "rev-parse", "HEAD");
    const resultTreeSha = await git(prepared.canonicalRepoPath, "rev-parse", "HEAD^{tree}");
    const branch = `result/${prepared.runIdentity.slice(0, 12)}`;
    await git(prepared.canonicalRepoPath, "branch", branch, resultSha);
    await resultDeliveryStore.save({
      version: 2,
      status: "completed",
      runIdentity: prepared.runIdentity,
      canonicalRepoPath: prepared.canonicalRepoPath,
      baseSha: resultSha,
      resultSha,
      baseTreeSha: resultTreeSha,
      resultTreeSha,
      branch,
      bundleSha256: "c".repeat(64),
      bundleBytes: 1,
      changedFiles: ["README.md"],
      diffSummary: { filesChanged: 1, insertions: 0, deletions: 0, binaryFiles: 0 },
      deliveredAt: new Date(0).toISOString(),
    });
    let opened = false;

    const resumed = await runHeadlessAgent({
      repoPath: repo.worktreePath,
      task: "Deliver once",
      approvalMode: "auto",
      checkpointStore,
      resultDeliveryStore,
      sessionRecoveryStore: new MemoryE2bSessionRecoveryStore(),
      callModel: async () => {
        throw new Error("completed run must not call the model");
      },
      openSession: async () => {
        opened = true;
        return new FakeSession() as unknown as E2bTaskSession;
      },
    });

    expect(opened).toBe(false);
    expect(resumed.delivery).toMatchObject({
      branch: `result/${prepared.runIdentity.slice(0, 12)}`,
      changedFiles: ["README.md"],
    });
  });

  test("resumes finalization from a completed delivery without another model call", async () => {
    const repo = await repository();
    const prepared = await prepareAgentRun(repo.worktreePath, "Resume finalization");
    const checkpointStore = new MemoryProductionCheckpointStore();
    const session = new FakeSession(repo.worktreePath);
    const resultSha = await git(repo.worktreePath, "rev-parse", "HEAD");
    const resultTreeSha = await git(repo.worktreePath, "rev-parse", "HEAD^{tree}");
    session.callImpl = async (request) => ({
      success: true, output: "ok", truncated: false, originalTokenCount: 1, codec: "test",
      ...(request.name === "run_shell" ? { metadata: { ...verificationMetadata("focused-test"), gitCommitBefore: resultSha, gitCommitAfter: resultSha, gitTreeBefore: resultTreeSha, gitTreeAfter: resultTreeSha } } : {}),
    });
    await expect(runProductionLoop({
      ...prepared,
      approvalMode: "auto",
      checkpointStore,
      session,
      callModel: queuedModel([
        turn(plan([["finish", "Finish", "in_progress"]]), action("read", "read_file", { path: "README.md" })),
        turn(plan([["finish", "Finish", "completed"]])),
      ]),
    })).resolves.toMatchObject({ status: "finalizing" });

    const branch = `result/${prepared.runIdentity.slice(0, 12)}`;
    await git(repo.worktreePath, "branch", branch, resultSha);
    const resultDeliveryStore = new MemoryResultDeliveryStore();
    await resultDeliveryStore.save({
      version: 2, status: "completed", runIdentity: prepared.runIdentity, canonicalRepoPath: repo.worktreePath,
      baseSha: resultSha, resultSha, baseTreeSha: resultTreeSha, resultTreeSha, branch,
      bundleSha256: "c".repeat(64), bundleBytes: 1, changedFiles: [],
      diffSummary: { filesChanged: 0, insertions: 0, deletions: 0, binaryFiles: 0 }, deliveredAt: new Date(0).toISOString(),
    });
    let modelCalls = 0;
    const resumed = await runHeadlessAgent({
      repoPath: repo.worktreePath,
      task: prepared.task,
      approvalMode: "auto",
      checkpointStore,
      resultDeliveryStore,
      sessionRecoveryStore: new MemoryE2bSessionRecoveryStore(),
      callModel: async () => { modelCalls += 1; throw new Error("must not call model"); },
      openSession: async () => { throw new Error("must not open sandbox"); },
    });
    expect(modelCalls).toBe(0);
    expect(resumed).toMatchObject({ status: "completed", completion: { resultCommit: resultSha, resultTree: resultTreeSha } });
  });

  test("requires an explicit approval mode before opening a fresh headless run", async () => {
    const repo = await repository();
    let opened = 0;
    await expect(runHeadlessAgent({
      repoPath: repo.worktreePath,
      task: "Require approval configuration",
      templateId: "template:test",
      checkpointStore: new MemoryProductionCheckpointStore(),
      callModel: queuedModel([]),
      openSession: async () => {
        opened += 1;
        return new FakeSession() as unknown as E2bTaskSession;
      },
    } as unknown as HeadlessAgentRunOptions)).rejects.toThrow("explicit approval mode");
    expect(opened).toBe(0);
  });

  test("accepts one controller decision for the current proposal digest", async () => {
    const repo = await repository();
    const session = new FakeSession();
    let releaseApproval!: (digest: string) => void;
    const approvalRequested = new Promise<string>((resolve) => { releaseApproval = resolve; });
    const controller = startAgentRun({
      repoPath: repo.worktreePath,
      task: "Approve once",
      templateId: "template:test",
      approvalMode: "interactive",
      checkpointStore: new MemoryProductionCheckpointStore(),
      callModel: queuedModel([
        turn(plan([["inspect", "Inspect once", "in_progress"]]), action("read", "read_file", { path: "README.md" })),
        turn(plan([["inspect", "Inspect once", "completed"]])),
      ]),
      openSession: async () => session as unknown as E2bTaskSession,
      eventSink(event) {
        if (event.type === "approval_requested") releaseApproval(event.proposalDigest);
      },
    });
    const digest = await approvalRequested;
    expect(controller.submitApproval("0".repeat(64), { kind: "approve" })).toBe(false);
    expect(controller.submitApproval(digest, { kind: "approve" })).toBe(true);
    expect(controller.submitApproval(digest, { kind: "cancel" })).toBe(false);
    await expect(controller.result).resolves.toMatchObject({ status: "completed" });
  });

  test("coordinates repeated cancellation through one cleanup result", async () => {
    const repo = await repository();
    const session = new FakeSession();
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    session.callImpl = async (_request, options) => {
      toolStarted();
      return await new Promise<ToolResult>((_, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
    };
    const lifecycle: string[] = [];
    const observed: AgentEvent[] = [];
    const controller = startAgentRun({
      repoPath: repo.worktreePath,
      task: "Cancel safely",
      templateId: "template:test",
      approvalMode: "auto",
      checkpointStore: new MemoryProductionCheckpointStore(),
      sessionRecoveryStore: new MemoryE2bSessionRecoveryStore(),
      callModel: queuedModel([
        turn(
          plan([["inspect", "Inspect safely", "in_progress"]]),
          action("read", "read_file", { path: "README.md" }),
        ),
      ]),
      openSession: async () =>
        session as unknown as E2bTaskSession,
      eventSink: (event) => observed.push(event),
      sessionEnd: async (context) => {
        lifecycle.push(`sessionEnd:${context.reason}`);
      },
    });

    await started;
    const firstStop = controller.stop("sigint");
    const secondStop = controller.stop("ui");
    expect(firstStop).toBe(secondStop);
    const result = await firstStop;

    expect(result).toMatchObject({
      status: "cancelled",
      reason: "cancelled",
      cleanup: "succeeded",
      exitCode: 130,
    });
    expect(session.lifecycle).toEqual(["reconcile", "close"]);
    expect(lifecycle).toEqual(["sessionEnd:cancelled"]);
    expect(
      observed.filter((event) => event.type === "shutdown_started"),
    ).toHaveLength(1);
    expect(
      observed.filter((event) => event.type === "run_finished"),
    ).toHaveLength(1);
    expect(observed.map((event) => event.type)).toContain("tool_finished");
  });

  test("cancels an active model request before sandbox cleanup", async () => {
    const repo = await repository();
    const session = new FakeSession();
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      modelStarted = resolve;
    });
    const controller = startAgentRun({
      repoPath: repo.worktreePath,
      task: "Cancel model",
      templateId: "template:test",
      approvalMode: "auto",
      checkpointStore: new MemoryProductionCheckpointStore(),
      callModel: async (_request, options) => {
        modelStarted();
        return await new Promise<ModelTurn>((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        });
      },
      openSession: async () =>
        session as unknown as E2bTaskSession,
    });

    await started;
    await expect(controller.stop("ui")).resolves.toMatchObject({
      status: "cancelled",
      exitCode: 130,
    });
    expect(session.lifecycle).toEqual(["reconcile", "close"]);
  });

  test("waits for an in-flight checkpoint commit before cancelling", async () => {
    const repo = await repository();
    const session = new FakeSession();
    const backing = new MemoryProductionCheckpointStore();
    let saveCount = 0;
    let commitStarted!: () => void;
    let releaseCommit!: () => void;
    const committing = new Promise<void>((resolve) => {
      commitStarted = resolve;
    });
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const store: ProductionCheckpointStore = {
      load: () => backing.load(),
      async save(state) {
        saveCount += 1;
        if (state.plan[0]?.description === "Inspect safely" && state.pendingTurn === null) {
          commitStarted();
          await commitRelease;
        }
        await backing.save(state);
      },
    };
    const controller = startAgentRun({
      repoPath: repo.worktreePath,
      task: "Cancel checkpoint",
      templateId: "template:test",
      approvalMode: "auto",
      checkpointStore: store,
      callModel: queuedModel([
        turn(
          plan([["inspect", "Inspect safely", "in_progress"]]),
          action("read", "read_file", { path: "README.md" }),
        ),
      ]),
      openSession: async () =>
        session as unknown as E2bTaskSession,
    });

    await committing;
    const stopping = controller.stop("sigint");
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCommit();
    await expect(stopping).resolves.toMatchObject({
      status: "cancelled",
      exitCode: 130,
    });
    expect((await backing.load())?.plan[0]?.description).toBe(
      "Inspect safely",
    );
    expect(session.lifecycle).toEqual(["reconcile", "close"]);
  });

  test("runs SessionEnd after cleanup and maps successful completion", async () => {
    const repo = await repository();
    const session = new FakeSession();
    const lifecycle = session.lifecycle;
    const controller = startAgentRun({
      repoPath: repo.worktreePath,
      task: "Finish safely",
      templateId: "template:test",
      approvalMode: "auto",
      checkpointStore: new MemoryProductionCheckpointStore(),
      callModel: queuedModel([
        turn(
          plan([["inspect", "Inspect safely", "in_progress"]]),
          action("read", "read_file", { path: "README.md" }),
        ),
        turn(plan([["inspect", "Inspect safely", "completed"]])),
      ]),
      openSession: async () =>
        session as unknown as E2bTaskSession,
      sessionEnd: () => {
        lifecycle.push("sessionEnd");
      },
    });

    await expect(controller.result).resolves.toMatchObject({
      status: "completed",
      cleanup: "succeeded",
      exitCode: 0,
    });
    expect(lifecycle).toEqual([
      "reconcile",
      "deliver",
      "close",
      "sessionEnd",
    ]);
  });

  test("keeps the sandbox alive when durable result delivery fails", async () => {
    const repo = await repository();
    const session = new FakeSession();
    const checkpointStore = new MemoryProductionCheckpointStore();
    session.deliverImpl = async () => {
      throw new Error("delivery interrupted");
    };

    await expect(runHeadlessAgent({
      repoPath: repo.worktreePath,
      task: "Preserve an undelivered result",
      templateId: "template:test",
      approvalMode: "auto",
      checkpointStore,
      sessionRecoveryStore: new MemoryE2bSessionRecoveryStore(),
      callModel: queuedModel([
        turn(
          plan([["finish", "Finish the work", "in_progress"]]),
          action("read", "read_file", { path: "README.md" }),
        ),
        turn(plan([["finish", "Finish the work", "completed"]])),
      ]),
      openSession: async () => session as unknown as E2bTaskSession,
    })).rejects.toThrow("delivery interrupted");

    expect(session.lifecycle).toEqual(["reconcile", "deliver", "preserve"]);
    expect(await checkpointStore.load()).toMatchObject({ lifecycle: "finalizing", completion: null });
  });

  test("fails cleanup when SessionEnd exceeds its bound", async () => {
    const repo = await repository();
    const session = new FakeSession();
    const controller = startAgentRun({
      repoPath: repo.worktreePath,
      task: "Bound lifecycle hook",
      templateId: "template:test",
      approvalMode: "auto",
      checkpointStore: new MemoryProductionCheckpointStore(),
      callModel: queuedModel([
        turn(plan([["done", "Finish", "in_progress"]]), action(
          "read",
          "read_file",
          { path: "README.md" },
        )),
        turn(plan([["done", "Finish", "completed"]])),
      ]),
      openSession: async () =>
        session as unknown as E2bTaskSession,
      sessionEnd: () => new Promise(() => {}),
      sessionEndTimeoutMs: 10,
    });

    await expect(controller.result).resolves.toMatchObject({
      status: "completed",
      cleanup: "failed",
      exitCode: 1,
      error: { message: "SessionEnd handler timed out." },
    });
  });

  test("keeps run reason separate from cleanup failure and still closes", async () => {
    const repo = await repository();
    const session = new FakeSession();
    session.reconcileImpl = async () => {
      throw new Error("reconcile failed");
    };
    let endContext: SessionEndContext | undefined;
    const observed: AgentEvent[] = [];
    const controller = startAgentRun({
      repoPath: repo.worktreePath,
      task: "Finish with cleanup failure",
      templateId: "template:test",
      approvalMode: "auto",
      checkpointStore: new MemoryProductionCheckpointStore(),
      callModel: queuedModel([
        turn(
          plan([["inspect", "Inspect", "in_progress"]]),
          action("read", "read_file", { path: "README.md" }),
        ),
        turn(plan([["inspect", "Inspect", "completed"]])),
      ]),
      openSession: async () =>
        session as unknown as E2bTaskSession,
      eventSink: (event) => observed.push(event),
      sessionEnd(context) {
        endContext = context;
      },
    });

    await expect(controller.result).resolves.toMatchObject({
      status: "completed",
      reason: "completed",
      cleanup: "failed",
      exitCode: 1,
    });
    expect(session.lifecycle).toEqual(["reconcile", "close"]);
    expect(endContext).toMatchObject({
      reason: "completed",
      cleanup: "failed",
    });
    expect(observed.find((event) => event.type === "run_finished"))
      .toMatchObject({ reason: "completed", cleanup: "failed" });
  });

  test("aggregates reconciliation and close failures before SessionEnd", async () => {
    const repo = await repository();
    const session = new FakeSession();
    session.reconcileImpl = async () => {
      throw new Error("reconcile failed");
    };
    session.closeImpl = async () => {
      throw new Error("close failed");
    };
    let endCalls = 0;
    const controller = startAgentRun({
      repoPath: repo.worktreePath,
      task: "Aggregate cleanup",
      templateId: "template:test",
      approvalMode: "auto",
      checkpointStore: new MemoryProductionCheckpointStore(),
      callModel: queuedModel([
        turn(
          plan([["inspect", "Inspect", "in_progress"]]),
          action("read", "read_file", { path: "README.md" }),
        ),
        turn(plan([["inspect", "Inspect", "completed"]])),
      ]),
      openSession: async () =>
        session as unknown as E2bTaskSession,
      sessionEnd(context) {
        endCalls += 1;
        expect(context).toMatchObject({
          reason: "completed",
          cleanup: "failed",
          error: { code: "AGGREGATE_ERROR" },
        });
      },
    });

    await expect(controller.result).resolves.toMatchObject({
      status: "completed",
      cleanup: "failed",
      exitCode: 1,
      error: { code: "AGGREGATE_ERROR" },
    });
    expect(session.lifecycle).toEqual(["reconcile", "close"]);
    expect(endCalls).toBe(1);
  });

  test("reports a shutdown timeout only after cleanup reaches terminal state", async () => {
    const repo = await repository();
    const session = new FakeSession();
    let reconciliationStarted!: () => void;
    let releaseReconciliation!: () => void;
    const started = new Promise<void>((resolve) => {
      reconciliationStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    session.reconcileImpl = async () => {
      reconciliationStarted();
      await released;
      return null;
    };
    const controller = startAgentRun({
      repoPath: repo.worktreePath,
      task: "Await cleanup",
      templateId: "template:test",
      approvalMode: "auto",
      checkpointStore: new MemoryProductionCheckpointStore(),
      callModel: queuedModel([
        turn(
          plan([["inspect", "Inspect", "in_progress"]]),
          action("read", "read_file", { path: "README.md" }),
        ),
        turn(plan([["inspect", "Inspect", "completed"]])),
      ]),
      openSession: async () =>
        session as unknown as E2bTaskSession,
      shutdownTimeoutMs: 5,
    });

    await started;
    let settled = false;
    void controller.result.then(() => {
      settled = true;
    });
    await Bun.sleep(10);
    expect(settled).toBe(false);
    releaseReconciliation();
    await expect(controller.result).resolves.toMatchObject({
      status: "completed",
      cleanup: "failed",
      exitCode: 1,
      error: { code: "SHUTDOWN_TIMEOUT" },
    });
    expect(session.lifecycle).toEqual(["reconcile", "deliver", "close"]);
  });

  test("keeps prompt text and hostile error names out of observation events", async () => {
    const repo = await repository();
    const secretTask = "SECRET_TASK_TEXT";
    const error = new Error(`provider echoed ${secretTask}`);
    error.name = "BAD\u001B[2J";
    const observed: AgentEvent[] = [];
    const controller = startAgentRun({
      repoPath: repo.worktreePath,
      task: secretTask,
      templateId: "template:test",
      approvalMode: "auto",
      checkpointStore: new MemoryProductionCheckpointStore(),
      callModel: async () => {
        throw error;
      },
      openSession: async () =>
        new FakeSession() as unknown as E2bTaskSession,
      eventSink: (event) => observed.push(event),
    });

    const result = await controller.result;
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "RUNTIME_ERROR" },
    });
    expect(JSON.stringify(result)).not.toContain(secretTask);
    expect(JSON.stringify(observed)).not.toContain(secretTask);
    expect(JSON.stringify(observed)).not.toContain("\u001B");
    expect(observed.find((event) => event.type === "run_finished"))
      .toMatchObject({
        error: {
          code: "RUNTIME_ERROR",
          message: "Run failed. See stderr for diagnostics.",
        },
      });
  });

  test("uses exit code 2 for invalid usage without external activity", async () => {
    let opened = 0;
    const controller = startAgentRun({
      repoPath: "relative",
      task: "task",
      templateId: "template:test",
      approvalMode: "auto",
      openSession: async () => {
        opened += 1;
        return new FakeSession() as unknown as E2bTaskSession;
      },
    });

    await expect(controller.result).resolves.toMatchObject({
      status: "failed",
      exitCode: 2,
    });
    expect(opened).toBe(0);
  });

  test("uses exit code 2 for an existing non-repository directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "not-a-repo-"));
    temporaryRoots.push(root);
    const controller = startAgentRun({
      repoPath: root,
      task: "task",
      templateId: "template:test",
      approvalMode: "auto",
    });
    await expect(controller.result).resolves.toMatchObject({
      status: "failed",
      exitCode: 2,
    });
  });
});

describe("production checkpoint", () => {
  test("writes mode-safe state and fails closed on corruption", async () => {
    const repo = await repository();
    const prepared = await prepareAgentRun(repo.worktreePath, "Persist");
    const store = new FileProductionCheckpointStore(repo.worktreePath);
    await store.save(initialState(prepared));
    expect(await store.load()).toMatchObject({
      version: 4,
      task: "Persist",
    });
    await writeFile(store.statePath, '{"version":1}\n');
    await expect(store.load()).rejects.toBeInstanceOf(
      ProductionCheckpointError,
    );
  });

  test("rejects a symlinked checkpoint directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-state-"));
    temporaryRoots.push(root);
    const repo = await repository();
    await Bun.spawn(["ln", "-s", root, path.join(repo.worktreePath, ".agent")])
      .exited;
    const store = new FileProductionCheckpointStore(repo.worktreePath);
    await expect(store.load()).rejects.toThrow("unsafe checkpoint");
  });
});

class FakeSession {
  constructor(readonly canonicalRepoPath = "/test/repository") {}
  calls: Array<{
    request: ModelToolRequest;
    options: McpToolCallOptions;
  }> = [];
  lifecycle: string[] = [];
  callImpl:
    | ((
        request: ModelToolRequest,
        options: McpToolCallOptions,
      ) => Promise<ToolResult>)
    | undefined;
  reconcileImpl: (() => Promise<null>) | undefined;
  deliverImpl: (() => Promise<never>) | undefined;
  closeImpl: (() => Promise<void>) | undefined;

  async call(
    request: ModelToolRequest,
    options: McpToolCallOptions = {},
  ): Promise<ToolResult> {
    this.calls.push({ request, options });
    if (this.callImpl) return this.callImpl(request, options);
    return {
      success: true,
      output: "ok",
      truncated: false,
      originalTokenCount: 1,
      codec: "test",
      ...(request.name === "run_shell" && request.input.verificationRequirementId ? { metadata: verificationMetadata(request.input.verificationRequirementId) } : {}),
    };
  }

  async reconcileActiveMutation(): Promise<null> {
    this.lifecycle.push("reconcile");
    if (this.reconcileImpl) return this.reconcileImpl();
    return null;
  }

  async deliverResult(runIdentity: string) {
    this.lifecycle.push("deliver");
    if (this.deliverImpl) return this.deliverImpl();
    return {
      version: 2 as const,
      runIdentity,
      canonicalRepoPath: this.canonicalRepoPath,
      baseSha: "a".repeat(40),
      resultSha: "b".repeat(40),
      baseTreeSha: "d".repeat(40),
      resultTreeSha: "b".repeat(40),
      branch: `result/${runIdentity.slice(0, 12)}`,
      bundleSha256: "c".repeat(64),
      bundleBytes: 1,
      changedFiles: [],
      diffSummary: { filesChanged: 0, insertions: 0, deletions: 0, binaryFiles: 0 },
      deliveredAt: new Date(0).toISOString(),
    };
  }

  async preserveForRecovery(): Promise<void> {
    this.lifecycle.push("preserve");
  }

  async close(): Promise<void> {
    this.lifecycle.push("close");
    await this.closeImpl?.();
  }
}

function queuedModel(turns: ModelTurn[]): CallModel {
  let index = 0;
  let discoveryProposed = false;
  let pendingCompletion: ModelTurn | undefined;
  let verificationInjected = false;
  return async (request) => {
    if (!discoveryProposed && request.tools.some((tool) => tool.name === "propose_plan")) {
      discoveryProposed = true;
      const firstRewrite = turns.flatMap((turn) => turn.content).find(
        (block) => block.type === "tool_use" && block.name === "rewrite_plan",
      );
      const input = firstRewrite?.type === "tool_use" && typeof firstRewrite.input === "object" && firstRewrite.input !== null
        ? firstRewrite.input as { plan?: Array<{ id: string; description: string }> }
        : {};
      return {
        content: [{
          type: "tool_use",
          id: crypto.randomUUID(),
          name: "propose_plan",
          input: {
            approach: "Follow the existing runtime architecture.",
            productDirection: "Preserve the requested product behavior.",
            visualDirection: "not_applicable",
            technologyChoices: [],
            includedScope: ["Complete the requested task"],
            excludedScope: ["Unrelated changes"],
            acceptanceCriteria: [{ id: "done", criterion: "The requested task is complete.", verification: "Run the focused test.", verificationRequirementIds: ["focused-test"] }],
            verificationRequirements: [{ type: "command", id: "focused-test", label: "Run focused test", workingDirectory: ".", command: "bun test", timeoutMs: 30_000 }],
            assumptions: [],
            unresolvedQuestions: [],
            executionPlan: (input.plan ?? [{ id: "work", description: "Complete the task" }]).map(({ id, description }) => ({ id, description })),
          },
        }],
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    if (pendingCompletion) {
      const completion = pendingCompletion;
      pendingCompletion = undefined;
      return completion;
    }
    const next = turns[index++];
    if (!next) throw new Error("Unexpected model call.");
    const completes = next.content.some((block) => block.type === "tool_use" && block.name === "rewrite_plan" && typeof block.input === "object" && block.input !== null && "plan" in block.input && Array.isArray(block.input.plan) && block.input.plan.every((item) => typeof item === "object" && item !== null && "status" in item && item.status === "completed"));
    if (completes && discoveryProposed && !verificationInjected) {
      verificationInjected = true;
      pendingCompletion = next;
      return {
        content: [{ type: "tool_use", id: crypto.randomUUID(), name: "run_shell", input: { cwd: ".", command: "bun test", timeoutMs: 30_000, verificationRequirementId: "focused-test" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return next;
  };
}

function verificationMetadata(requirementId: string) {
  return { exitCode: 0, timedOut: false, verificationRequirementId: requirementId, gitCommitBefore: "a".repeat(40), gitTreeBefore: "b".repeat(40), gitCleanBefore: true, gitCommitAfter: "a".repeat(40), gitTreeAfter: "b".repeat(40), gitCleanAfter: true };
}

function turn(
  planCall: ReturnType<typeof plan>,
  repositoryAction?: ReturnType<typeof action>,
): ModelTurn {
  return {
    content: [planCall, ...(repositoryAction ? [repositoryAction] : [])],
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function plan(
  tasks: Array<
    [id: string, description: string, status: "pending" | "in_progress" | "completed"]
  >,
) {
  return {
    type: "tool_use" as const,
    id: crypto.randomUUID(),
    name: "rewrite_plan",
    input: {
      plan: tasks.map(([id, description, status]) => ({
        id,
        description,
        status,
      })),
    },
  };
}

function action(name: string, tool: string, input: unknown) {
  return {
    type: "tool_use" as const,
    id: name,
    name: tool,
    input,
  };
}

function initialState(
  prepared: {
    canonicalRepoPath: string;
    task: string;
    runIdentity: string;
  },
): ProductionAgentState {
  return {
    version: 4,
    approval: createLegacyExecutionApprovalState(),
    ...prepared,
    promptStatus: "accepted",
    appendedPromptContext: "",
    lifecycle: "running",
    plan: [],
    transcript: [{ role: "user", content: `Complete the following repository task:\n${prepared.task}\n\nFirst create a concrete plan, then perform one safe action per turn.` }],
    lastToolSucceeded: null,
    pendingTurn: null,
    pendingModelCall: null,
    limits: {
      maxModelCalls: 50,
      compactAtTokens: 150_000,
      maxContextTokens: 200_000,
      maxProjectedCostMicroUsd: 5_000_000,
      compactAtCheckpointBytes: 1_572_864,
      maxCheckpointBytes: 2 * 1024 * 1024,
    },
    pricing: {
      catalogVersion: 1,
      identity: { provider: "injected", model: "claude-haiku-4-5" },
      inputRateMicroUsdPerMillion: 1_000_000,
      outputRateMicroUsdPerMillion: 5_000_000,
    },
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
    auditCursor: { sequence: 0, digest: "0".repeat(64) }, verificationEvidence: [], completion: null, legacyCompletionStatus: null,
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr}`);
  return stdout.trim();
}
