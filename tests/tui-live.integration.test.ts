import { expect, test } from "bun:test";
import type { ModelTurn } from "../src/model/contracts";
import {
  runHeadlessAgent,
  startAgentRun,
  type AgentRunController,
} from "../src/runtime/agent-runner";
import type { AgentEvent } from "../src/runtime/events";
import { MemoryProductionCheckpointStore } from "../src/runtime/checkpoint";
import { createE2bTaskSession } from "../src/sandbox/e2b-session";
import { MemoryE2bSessionRecoveryStore } from "../src/sandbox/session-recovery";
import { MemoryResultDeliveryStore } from "../src/sandbox/result-delivery";
import { readLiveE2bConfig } from "./support/live-e2b-config";
import { createTemporaryRepository } from "./support/temp-repo";

const liveConfig = readLiveE2bConfig();
const liveTest = liveConfig.enabled ? test : test.skip;

liveTest(
  "cancels a real E2B mutation and releases the sandbox exactly once",
  async () => {
    const repository = await createTemporaryRepository();
    const recoveryStore = new MemoryE2bSessionRecoveryStore();
    const events: AgentEvent[] = [];
    const lifecycle: string[] = [];
    let sandboxId = "";
    let controller: AgentRunController | undefined;
    let releaseToolStarted: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      releaseToolStarted = resolve;
    });
    const turns: ModelTurn[] = [{
      content: [{
        type: "tool_use",
        id: "proposal-live-cancel",
        name: "propose_plan",
        input: {
          approach: "Exercise cancellable mutation cleanup.",
          productDirection: "Preserve the requested product behavior.",
          visualDirection: "not_applicable",
          technologyChoices: [],
          includedScope: ["Cancellable mutation cleanup"],
          excludedScope: ["Unrelated changes"],
          acceptanceCriteria: [{ id: "cancel", criterion: "Cancellation cleans up the sandbox.", verification: "Observe the terminal lifecycle.", verificationRequirementIds: ["cancel-check"] }],
          verificationRequirements: [{ type: "command", id: "cancel-check", label: "Check cancellation", workingDirectory: ".", command: "bun test", timeoutMs: 30_000 }],
          assumptions: [],
          unresolvedQuestions: [],
          executionPlan: [{ id: "mutate", description: "Exercise cancellable mutation cleanup" }],
        },
      }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    }, {
      content: [
        {
          type: "tool_use",
          id: "plan-live-cancel",
          name: "rewrite_plan",
          input: {
            plan: [{
              id: "mutate",
              description: "Exercise cancellable mutation cleanup",
              status: "in_progress",
            }],
          },
        },
        {
          type: "tool_use",
          id: "shell-live-cancel",
          name: "run_shell",
          input: {
            cwd: ".",
            command: "sleep 5; printf 'should-not-finish\\n' > cancelled.txt",
            timeoutMs: 15_000,
          },
        },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    }];

    try {
      controller = startAgentRun({
        repoPath: repository.worktreePath,
        task: "Verify live cancellation cleanup without a model provider.",
        templateId: liveConfig.templateRef,
        approvalMode: "auto",
        checkpointStore: new MemoryProductionCheckpointStore(),
        sessionRecoveryStore: recoveryStore,
        callModel: async () => {
          const turn = turns.shift();
          if (!turn) throw new Error("Unexpected model call.");
          return turn;
        },
        openSession: async ({ prepared, templateId, signal }) => {
          const session = await createE2bTaskSession({
            localRepoPath: prepared.canonicalRepoPath,
            taskId: "tui-live-cancel",
            templateId,
            signal,
            recovery: {
              runIdentity: prepared.runIdentity,
              store: recoveryStore,
            },
          });
          sandboxId = session.sandboxId;
          return session;
        },
        eventSink(event) {
          events.push(event);
          if (event.type === "tool_started") releaseToolStarted?.();
        },
        sessionEnd(context) {
          lifecycle.push(
            `sessionEnd:${context.reason}:${context.cleanup}`,
          );
        },
      });

      const readiness = await Promise.race([
        toolStarted.then(() => ({ state: "started" as const })),
        controller.result.then((result) => ({
          state: "finished" as const,
          result,
        })),
      ]);
      if (readiness.state === "finished") {
        throw new Error(
          `Live run ended before the tool started: ${JSON.stringify(readiness.result)}`,
        );
      }
      const result = await controller.stop("ui");

      expect(result).toMatchObject({
        reason: "cancelled",
        cleanup: "succeeded",
        exitCode: 130,
      });
      expect(lifecycle).toEqual([
        "sessionEnd:cancelled:succeeded",
      ]);
      expect(
        events.filter((event) => event.type === "shutdown_started"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "run_finished"),
      ).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool_finished",
          outcome: "cancelled",
        }),
      );
      expect(await recoveryStore.load()).toBeNull();
      expect(sandboxId).not.toBe("");
      expect(await runningSandboxIds()).not.toContain(sandboxId);
    } finally {
      if (controller) await controller.stop("ui").catch(() => {});
      await repository.cleanup();
    }
  },
  360_000,
);

liveTest(
  "revises, restarts while awaiting approval, then completes in real E2B",
  async () => {
    const repository = await createTemporaryRepository();
    const checkpointStore = new MemoryProductionCheckpointStore();
    const resultDeliveryStore = new MemoryResultDeliveryStore();
    let approvals = 0;
    const proposals = [proposalTurn("First approach", "approved.txt"), proposalTurn("Revised approach", "approved.txt")];
    try {
      await expect(runHeadlessAgent({
        repoPath: repository.worktreePath,
        task: "Create approved.txt only after revised plan approval.",
        templateId: liveConfig.templateRef,
        approvalMode: "interactive",
        requestApproval: async () => {
          approvals += 1;
          if (approvals === 1) return { kind: "revise", feedback: "Use the revised approach." };
          throw new DOMException("simulate restart", "AbortError");
        },
        checkpointStore,
        sessionRecoveryStore: new MemoryE2bSessionRecoveryStore(),
        resultDeliveryStore,
        callModel: async () => {
          const turn = proposals.shift();
          if (!turn) throw new Error("Unexpected discovery call.");
          return turn;
        },
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(await checkpointStore.load()).toMatchObject({ approval: { phase: "awaiting_approval", revision: 2 } });

      const execution = [
        executionTurn("in_progress", {
          type: "tool_use" as const,
          id: "approved-shell",
          name: "run_shell",
          input: { cwd: ".", command: "printf 'approved\\n' > approved.txt", timeoutMs: 10_000 },
        }),
        commitTurn("approved.txt"),
        verificationTurn("approved.txt"),
        executionTurn("completed"),
      ];
      const result = await runHeadlessAgent({
        repoPath: repository.worktreePath,
        task: "Create approved.txt only after revised plan approval.",
        templateId: liveConfig.templateRef,
        approvalMode: "interactive",
        requestApproval: async () => ({ kind: "approve" }),
        checkpointStore,
        sessionRecoveryStore: new MemoryE2bSessionRecoveryStore(),
        resultDeliveryStore,
        callModel: async () => {
          const turn = execution.shift();
          if (!turn) throw new Error("Unexpected execution call.");
          return turn;
        },
      });
      expect(result.status).toBe("completed");
      expect(result.delivery?.changedFiles).toContain("approved.txt");
      expect((await checkpointStore.load())?.approval).toMatchObject({ phase: "executing", revision: 2 });
    } finally {
      await repository.cleanup();
    }
  },
  360_000,
);

liveTest(
  "auto-approves durably before completing a real E2B mutation",
  async () => {
    const repository = await createTemporaryRepository();
    const turns = [
      proposalTurn("Automatic approach", "auto-approved.txt"),
      executionTurn("in_progress", {
        type: "tool_use" as const,
        id: "auto-shell",
        name: "run_shell",
        input: { cwd: ".", command: "printf 'auto-approved\\n' > auto-approved.txt", timeoutMs: 10_000 },
      }),
      commitTurn("auto-approved.txt"),
      verificationTurn("auto-approved.txt"),
      executionTurn("completed"),
    ];
    try {
      const result = await runHeadlessAgent({
        repoPath: repository.worktreePath,
        task: "Create auto-approved.txt after automatic plan approval.",
        templateId: liveConfig.templateRef,
        approvalMode: "auto",
        checkpointStore: new MemoryProductionCheckpointStore(),
        sessionRecoveryStore: new MemoryE2bSessionRecoveryStore(),
        resultDeliveryStore: new MemoryResultDeliveryStore(),
        callModel: async () => {
          const turn = turns.shift();
          if (!turn) throw new Error("Unexpected model call.");
          return turn;
        },
      });
      expect(result.status).toBe("completed");
      expect(result.delivery?.changedFiles).toContain("auto-approved.txt");
    } finally {
      await repository.cleanup();
    }
  },
  360_000,
);

function proposalTurn(approach: string, artifactPath = "artifact.txt"): ModelTurn {
  return {
    content: [{
      type: "tool_use",
      id: crypto.randomUUID(),
      name: "propose_plan",
      input: {
        approach,
        productDirection: "Create only the requested approval artifact.",
        visualDirection: "not_applicable",
        technologyChoices: [],
        includedScope: ["Create the requested text artifact"],
        excludedScope: ["Unrelated repository changes"],
        acceptanceCriteria: [{ id: "artifact", criterion: "The approved artifact exists.", verification: "Inspect the delivered changed files.", verificationRequirementIds: ["artifact-check"] }],
        verificationRequirements: [{ type: "command", id: "artifact-check", label: "Check artifact", workingDirectory: ".", command: `test -f ${artifactPath}`, timeoutMs: 30_000 }],
        assumptions: [],
        unresolvedQuestions: [],
        executionPlan: [{ id: "artifact", description: "Create the approved artifact" }],
      },
    }],
    stopReason: "tool_use",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function verificationTurn(artifactPath: string): ModelTurn {
  return executionTurn("in_progress", {
    type: "tool_use",
    id: crypto.randomUUID(),
    name: "run_shell",
    input: {
      cwd: ".",
      command: `test -f ${artifactPath}`,
      timeoutMs: 30_000,
      verificationRequirementId: "artifact-check",
    },
  });
}

function commitTurn(artifactPath: string): ModelTurn {
  return executionTurn("in_progress", {
    type: "tool_use",
    id: crypto.randomUUID(),
    name: "git",
    input: {
      subcommand: "commit",
      addAll: true,
      message: `test: add ${artifactPath}`,
    },
  });
}

function executionTurn(status: "in_progress" | "completed", action?: ModelTurn["content"][number]): ModelTurn {
  return {
    content: [{
      type: "tool_use",
      id: crypto.randomUUID(),
      name: "rewrite_plan",
      input: { plan: [{ id: "artifact", description: "Create the approved artifact", status }] },
    }, ...(action ? [action] : [])],
    stopReason: "tool_use",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

async function runningSandboxIds(): Promise<string[]> {
  const { Sandbox } = await import("e2b");
  const paginator = Sandbox.list({
    query: { state: ["running", "paused"] },
  });
  const ids: string[] = [];
  while (paginator.hasNext) {
    ids.push(
      ...(await paginator.nextItems()).map((sandbox) => sandbox.sandboxId),
    );
  }
  return ids;
}
