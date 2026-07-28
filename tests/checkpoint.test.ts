import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInitialPlan,
  LoopLimitError,
  MemoryCheckpointStore,
  PHASE_ONE_RUN_IDENTITY,
  PHASE_ONE_TASKS,
  runAgentLoop,
  TurnProtocolError,
  type AgentStateV1,
  type PlanTask,
} from "../src/loop";
import type {
  CallModel,
  ModelTurn,
} from "../src/model/anthropic";
import {
  AgentStateV1Schema,
  TodoItemSchema,
  TodoWriteInputSchema,
} from "../src/plan/schema";
import {
  CheckpointIoError,
  FileCheckpointStore,
  IncompatibleCheckpointError,
  InvalidCheckpointStateError,
  MissingCheckpointError,
  UnsafeCheckpointPathError,
  UnsupportedCheckpointVersionError,
} from "../src/state/checkpoint";
import { fakeReadFile } from "../src/tools/fake-read-file";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("Step 3 schemas", () => {
  test("round-trips strict TodoWrite and agent state values", () => {
    const input = { plan: createInitialPlan() };
    expect(TodoWriteInputSchema.parse(input)).toEqual(input);
    expect(AgentStateV1Schema.parse(makeInitialState())).toEqual(
      makeInitialState(),
    );
  });

  test("rejects empty fields, invalid status, and unknown fields", () => {
    expect(() =>
      TodoItemSchema.parse({
        id: "",
        description: "task",
        status: "pending",
      }),
    ).toThrow();
    const whitespaceInput = {
      plan: createInitialPlan().map((task, index) =>
        index === 0 ? { ...task, id: ` ${task.id}` } : task,
      ),
    };
    expect(TodoWriteInputSchema.parse(whitespaceInput).plan[0]?.id).toStartWith(
      " ",
    );
    expect(() =>
      TodoItemSchema.parse({
        id: "task",
        description: "task",
        status: "blocked",
      }),
    ).toThrow();
    expect(() =>
      TodoWriteInputSchema.parse({
        plan: createInitialPlan(),
        unexpected: true,
      }),
    ).toThrow();
  });
});

describe("FileCheckpointStore", () => {
  test("writes mode-0600 state atomically and loads it", async () => {
    const repo = await makeTemporaryDirectory();
    const store = new FileCheckpointStore(repo);
    const state = makeInitialState();

    await store.save(state);

    expect(await store.load()).toEqual(state);
    expect((await lstat(store.statePath)).mode & 0o777).toBe(0o600);
  });

  test("removes recognized orphan temps but preserves unknown files", async () => {
    const repo = await makeTemporaryDirectory();
    const agentDirectory = join(repo, ".agent");
    await mkdir(agentDirectory);
    await writeFile(join(agentDirectory, ".state.json.tmp-orphan"), "orphan");
    await writeFile(join(agentDirectory, "keep.txt"), "keep");
    const store = new FileCheckpointStore(repo);

    expect(await store.load()).toBeNull();
    expect(await Bun.file(join(agentDirectory, ".state.json.tmp-orphan")).exists()).toBe(
      false,
    );
    expect(await Bun.file(join(agentDirectory, "keep.txt")).text()).toBe("keep");
  });

  test("preserves the prior checkpoint when a write fails before rename", async () => {
    const repo = await makeTemporaryDirectory();
    const workingStore = new FileCheckpointStore(repo);
    const original = makeInitialState();
    await workingStore.save(original);
    const failingStore = new FileCheckpointStore(repo, {
      beforeRename: async () => {
        throw new Error("injected failure");
      },
    });

    await expect(
      failingStore.save({
        ...original,
        counters: { ...original.counters, inputTokens: 99 },
      }),
    ).rejects.toBeInstanceOf(CheckpointIoError);

    expect(await workingStore.load()).toEqual(original);
  });

  test("rejects a symlinked .agent directory", async () => {
    const repo = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    await symlink(outside, join(repo, ".agent"));

    await expect(
      new FileCheckpointStore(repo).save(makeInitialState()),
    ).rejects.toBeInstanceOf(UnsafeCheckpointPathError);
    expect(await Bun.file(join(outside, "state.json")).exists()).toBe(false);
  });

  test("rejects a symlinked state file", async () => {
    const repo = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    const agentDirectory = join(repo, ".agent");
    const outsideState = join(outside, "state.json");
    await mkdir(agentDirectory);
    await writeFile(outsideState, JSON.stringify(makeInitialState()));
    await symlink(outsideState, join(agentDirectory, "state.json"));

    await expect(
      new FileCheckpointStore(repo).load(),
    ).rejects.toBeInstanceOf(UnsafeCheckpointPathError);
  });

  test("fails closed for invalid and unsupported state without changing it", async () => {
    const repo = await makeTemporaryDirectory();
    const agentDirectory = join(repo, ".agent");
    const statePath = join(agentDirectory, "state.json");
    await mkdir(agentDirectory);
    await writeFile(statePath, "{invalid");
    const store = new FileCheckpointStore(repo);

    await expect(store.load()).rejects.toBeInstanceOf(
      InvalidCheckpointStateError,
    );
    expect(await readFile(statePath, "utf8")).toBe("{invalid");

    await writeFile(statePath, JSON.stringify({ version: 2 }));
    await expect(store.load()).rejects.toBeInstanceOf(
      UnsupportedCheckpointVersionError,
    );
    expect(await readFile(statePath, "utf8")).toBe(
      JSON.stringify({ version: 2 }),
    );
  });
});

describe("loop recovery", () => {
  test("resumes without replaying a committed read", async () => {
    const store = new MemoryCheckpointStore();
    const firstReads: string[] = [];

    await expect(
      runAgentLoop({
        callModel: queuedModel([makeTurn(0)]),
        checkpointStore: store,
        maxModelTurns: 1,
        logger: () => {},
        readFile: (path) => {
          firstReads.push(path);
          return fakeReadFile(path);
        },
      }),
    ).rejects.toBeInstanceOf(LoopLimitError);

    const resumedReads: string[] = [];
    const result = await runAgentLoop({
      callModel: queuedModel([makeTurn(1), makeTurn(2), makeTurn(3)]),
      checkpointStore: store,
      logger: () => {},
      readFile: (path) => {
        resumedReads.push(path);
        return fakeReadFile(path);
      },
    });

    expect(firstReads).toEqual(["package.json"]);
    expect(resumedReads).toEqual(["src/loop.ts", "tests/loop.test.ts"]);
    expect(result.modelTurns).toBe(4);
    expect(result.acceptedTurns).toBe(4);
    expect(result.inputTokens).toBe(40);
    expect(result.outputTokens).toBe(8);
  });

  test("preserves the invalid-response retry budget across restart", async () => {
    const store = new MemoryCheckpointStore();
    const invalid = makeRawTurn([], "end_turn");

    await expect(
      runAgentLoop({
        callModel: queuedModel([invalid]),
        checkpointStore: store,
        maxModelTurns: 1,
        logger: () => {},
      }),
    ).rejects.toBeInstanceOf(LoopLimitError);

    await expect(
      runAgentLoop({
        callModel: queuedModel([invalid]),
        checkpointStore: store,
        logger: () => {},
      }),
    ).rejects.toThrow("violated the turn protocol twice");

    let modelCalls = 0;
    await expect(
      runAgentLoop({
        callModel: async () => {
          modelCalls += 1;
          return makeTurn(0);
        },
        checkpointStore: store,
        logger: () => {},
      }),
    ).rejects.toThrow("terminal protocol failure");
    expect(modelCalls).toBe(0);
  });

  test("returns a completed checkpoint without model or tool calls", async () => {
    const store = new MemoryCheckpointStore();
    await runAgentLoop({
      callModel: queuedModel([
        makeTurn(0),
        makeTurn(1),
        makeTurn(2),
        makeTurn(3),
      ]),
      checkpointStore: store,
      logger: () => {},
    });
    let modelCalls = 0;
    let readCalls = 0;

    const result = await runAgentLoop({
      callModel: async () => {
        modelCalls += 1;
        return makeTurn(3);
      },
      checkpointStore: store,
      logger: () => {},
      readFile: () => {
        readCalls += 1;
        return { success: true, content: "unexpected" };
      },
    });

    expect(result.status).toBe("completed");
    expect(modelCalls).toBe(0);
    expect(readCalls).toBe(0);
  });

  test("rejects structurally valid but internally inconsistent state", async () => {
    const inconsistent = makeInitialState();
    inconsistent.lifecycle = "completed";
    inconsistent.plan = makePlan(3);

    await expect(
      runAgentLoop({
        callModel: queuedModel([]),
        checkpointStore: new MemoryCheckpointStore(inconsistent),
        logger: () => {},
      }),
    ).rejects.toBeInstanceOf(IncompatibleCheckpointError);
  });

  test("rejects checkpoint tool results that do not correlate by ID", async () => {
    const store = new MemoryCheckpointStore();
    await runAgentLoop({
      callModel: queuedModel([
        makeTurn(0),
        makeTurn(1),
        makeTurn(2),
        makeTurn(3),
      ]),
      checkpointStore: store,
      logger: () => {},
    });
    const corrupted = await store.load();
    if (!corrupted) throw new Error("Missing completed checkpoint");
    const finalMessage = corrupted.transcript.at(-1);
    if (
      !finalMessage ||
      finalMessage.role !== "user" ||
      !Array.isArray(finalMessage.content)
    ) {
      throw new Error("Missing final result message");
    }
    const finalResult = finalMessage.content[0];
    if (!finalResult || finalResult.type !== "tool_result") {
      throw new Error("Missing final plan result");
    }
    finalResult.toolUseId = "corrupted-id";

    await expect(
      runAgentLoop({
        callModel: queuedModel([]),
        checkpointStore: new MemoryCheckpointStore(corrupted),
        logger: () => {},
      }),
    ).rejects.toBeInstanceOf(IncompatibleCheckpointError);
  });

  test("supports required and explicit fresh startup policies", async () => {
    await expect(
      runAgentLoop({
        callModel: queuedModel([]),
        checkpointStore: new MemoryCheckpointStore(),
        startupPolicy: "required",
        logger: () => {},
      }),
    ).rejects.toBeInstanceOf(MissingCheckpointError);

    const incompatible = makeInitialState();
    incompatible.runIdentity = "other-run";
    await expect(
      runAgentLoop({
        callModel: queuedModel([]),
        checkpointStore: new MemoryCheckpointStore(incompatible),
        logger: () => {},
      }),
    ).rejects.toBeInstanceOf(IncompatibleCheckpointError);

    const result = await runAgentLoop({
      callModel: queuedModel([
        makeTurn(0),
        makeTurn(1),
        makeTurn(2),
        makeTurn(3),
      ]),
      checkpointStore: new MemoryCheckpointStore(incompatible),
      startupPolicy: "fresh",
      logger: () => {},
    });
    expect(result.status).toBe("completed");
  });
});

describe("hard-kill recovery", () => {
  test(
    "survives two SIGKILL cycles without replaying committed reads",
    async () => {
      if (process.platform === "win32") return;
      const repo = await makeTemporaryDirectory();

      await runKilledChild(repo, 1, "barrier-1");
      await runKilledChild(repo, 2, "barrier-2");
      await runChild(repo, -1, "barrier-final");

      const state = AgentStateV1Schema.parse(
        JSON.parse(await Bun.file(join(repo, ".agent", "state.json")).text()),
      );
      const reads = (await Bun.file(join(repo, "reads.log")).text())
        .trim()
        .split("\n");

      expect(state.lifecycle).toBe("completed");
      expect(state.counters.modelTurns).toBe(4);
      expect(state.counters.committedTurns).toBe(4);
      expect(state.counters.readCalls).toBe(3);
      expect(reads).toEqual([
        "package.json",
        "src/loop.ts",
        "tests/loop.test.ts",
      ]);
    },
    15_000,
  );
});

async function runKilledChild(
  repo: string,
  blockAfter: number,
  barrierName: string,
): Promise<void> {
  const barrier = join(repo, barrierName);
  const child = spawnChild(repo, blockAfter, barrier);
  await waitForFile(barrier);
  child.kill(9);
  expect(await child.exited).not.toBe(0);
}

async function runChild(
  repo: string,
  blockAfter: number,
  barrierName: string,
): Promise<void> {
  const child = spawnChild(repo, blockAfter, join(repo, barrierName));
  expect(await child.exited).toBe(0);
}

function spawnChild(repo: string, blockAfter: number, barrier: string) {
  return Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "recovery-child.ts"),
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        RECOVERY_REPO: repo,
        RECOVERY_BLOCK_AFTER: String(blockAfter),
        RECOVERY_BARRIER: barrier,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for child barrier "${path}".`);
}

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agent-step3-"));
  temporaryDirectories.push(path);
  return path;
}

function makeInitialState(): AgentStateV1 {
  return {
    version: 1,
    runIdentity: PHASE_ONE_RUN_IDENTITY,
    lifecycle: "running",
    plan: createInitialPlan(),
    transcript: [{ role: "user", content: "initial" }],
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
}

function makePlan(completedCount: number): PlanTask[] {
  return PHASE_ONE_TASKS.map((task, index) => ({
    id: task.id,
    description: task.description,
    status:
      index < completedCount
        ? "completed"
        : index === completedCount
          ? "in_progress"
          : "pending",
  }));
}

function makeTurn(completedCount: number): ModelTurn {
  const plan = makePlan(completedCount);
  const content: ModelTurn["content"] = [
    {
      type: "tool_use",
      id: `plan-${completedCount}`,
      name: "rewrite_plan",
      input: { plan },
    },
  ];
  const task = PHASE_ONE_TASKS[completedCount];
  if (task) {
    content.push({
      type: "tool_use",
      id: `read-${completedCount}`,
      name: "read_file",
      input: { path: task.path },
    });
  }
  return makeRawTurn(content);
}

function makeRawTurn(
  content: ModelTurn["content"],
  stopReason: ModelTurn["stopReason"] = "tool_use",
): ModelTurn {
  return {
    content,
    stopReason,
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}

function queuedModel(turns: ModelTurn[]): CallModel {
  let index = 0;
  return async () => {
    const turn = turns[index++];
    if (!turn) throw new Error("Fake model queue exhausted");
    return structuredClone(turn);
  };
}
