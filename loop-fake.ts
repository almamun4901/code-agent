type TaskId = "inspect" | "edit" | "verify";
type TaskStatus = "pending" | "completed";
type LoopStatus = "running" | "completed" | "failed";
type FakeToolName = "read_file" | "edit_file" | "run_shell";

type FakeTask = {
  id: TaskId;
  description: string;
  status: TaskStatus;
  attempts: number;
};

type FakeToolCall = {
  name: FakeToolName;
  arguments: Record<string, string>;
};

type FakeToolResult = {
  success: boolean;
  message: string;
  toolCall: FakeToolCall;
};

type Observation = {
  turn: number;
  taskId: TaskId;
  success: boolean;
  message: string;
};

type LoopState = {
  turn: number;
  status: LoopStatus;
  recoveryCount: number;
  failureReason: string | null;
  observations: Observation[];
  tasks: FakeTask[];
};

/**
 * Create the complete in-memory state for a new fake-agent run.
 */
function createInitialState(): LoopState {
  return {
    turn: 0,
    status: "running",
    recoveryCount: 0,
    failureReason: null,
    observations: [],
    tasks: [
      {
        id: "inspect",
        description: "Inspect the fictional source file",
        status: "pending",
        attempts: 0,
      },
      {
        id: "edit",
        description: "Modify the fictional source file",
        status: "pending",
        attempts: 0,
      },
      {
        id: "verify",
        description: "Verify the fictional change",
        status: "pending",
        attempts: 0,
      },
    ],
  };
}

/**
 * Print the current plan and select the first unfinished task.
 */
function plan(state: LoopState): FakeTask {
  console.log("PLAN");

  for (const task of state.tasks) {
    console.log(
      `  [${task.status === "completed" ? "x" : " "}] ${task.description} ` +
        `(attempts: ${task.attempts})`,
    );
  }

  const nextTask = state.tasks.find((task) => task.status === "pending");

  if (!nextTask) {
    throw new Error("Plan requested when no pending task exists");
  }

  console.log(`  Next: ${nextTask.description}`);
  return nextTask;
}

/**
 * Build and execute a deterministic fake tool call for the selected task.
 * Nothing here reads a file, edits a file, or runs a real command.
 */
function act(state: LoopState, task: FakeTask): FakeToolResult {
  task.attempts += 1;

  let toolCall: FakeToolCall;

  switch (task.id) {
    case "inspect":
      toolCall = {
        name: "read_file",
        arguments: { path: "src/example.ts" },
      };
      break;
    case "edit":
      toolCall = {
        name: "edit_file",
        arguments: {
          path: "src/example.ts",
          oldText: 'const greeting = "Hello";',
          newText: 'const greeting = "Hello, world!";',
        },
      };
      break;
    case "verify":
      toolCall = {
        name: "run_shell",
        arguments: { command: "bun test" },
      };
      break;
  }

  console.log("ACT");
  console.log(`  Tool: ${toolCall.name}`);
  console.log(`  Arguments: ${JSON.stringify(toolCall.arguments)}`);

  if (task.id === "edit" && task.attempts === 1) {
    return {
      success: false,
      message: "Simulated transient edit conflict",
      toolCall,
    };
  }

  const successMessages: Record<TaskId, string> = {
    inspect: "Fake file contents returned",
    edit: "Fake edit applied successfully",
    verify: "Fake verification passed",
  };

  return {
    success: true,
    message: successMessages[task.id],
    toolCall,
  };
}

/**
 * Record the fake tool result and complete the task when it succeeded.
 */
function observe(
  state: LoopState,
  task: FakeTask,
  result: FakeToolResult,
): Observation {
  const observation: Observation = {
    turn: state.turn,
    taskId: task.id,
    success: result.success,
    message: result.message,
  };

  state.observations.push(observation);

  if (observation.success) {
    task.status = "completed";
  }

  console.log("OBSERVE");
  console.log(`  Result: ${observation.success ? "success" : "failure"}`);
  console.log(`  Message: ${observation.message}`);

  return observation;
}

/**
 * Record the recovery and leave the failed task pending for the next turn.
 */
function recover(
  state: LoopState,
  task: FakeTask,
  observation: Observation,
): void {
  if (observation.success) {
    throw new Error("Recovery requested for a successful observation");
  }

  state.recoveryCount += 1;
  task.status = "pending";

  console.log("RECOVER");
  console.log(`  Error: ${observation.message}`);
  console.log(`  Decision: retry "${task.description}" on the next turn`);
}

/**
 * The plan is complete only when every task is complete.
 */
function isComplete(state: LoopState): boolean {
  return state.tasks.every((task) => task.status === "completed");
}

/**
 * Print the terminal state of the fake-agent run.
 */
function printSummary(state: LoopState): void {
  const completedTasks = state.tasks.filter(
    (task) => task.status === "completed",
  ).length;

  console.log("\nSUMMARY");
  console.log(`  Status: ${state.status}`);
  console.log(`  Turns: ${state.turn}`);
  console.log(`  Tasks: ${completedTasks}/${state.tasks.length} completed`);
  console.log(`  Recoveries: ${state.recoveryCount}`);

  if (state.failureReason) {
    console.log(`  Failure: ${state.failureReason}`);
  }
}

/**
 * Coordinate PLAN -> ACT -> OBSERVE and enter RECOVER after a failed action.
 */
function runFakeLoop(): void {
  const state = createInitialState();
  const maximumTurns = 10;

  try {
    while (!isComplete(state)) {
      if (state.turn >= maximumTurns) {
        throw new Error(`Maximum turn limit of ${maximumTurns} exceeded`);
      }

      state.turn += 1;
      console.log(`\n=== TURN ${state.turn} ===`);

      const task = plan(state);
      const result = act(state, task);
      const observation = observe(state, task, result);

      if (!observation.success) {
        recover(state, task, observation);
      }
    }

    state.status = "completed";
  } catch (error) {
    state.status = "failed";
    state.failureReason =
      error instanceof Error ? error.message : "Unknown loop failure";
  }

  printSummary(state);

  if (state.status === "failed") {
    throw new Error(state.failureReason ?? "Fake loop failed");
  }
}

runFakeLoop();
