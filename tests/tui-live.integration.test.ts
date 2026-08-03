import { expect, test } from "bun:test";
import type { ModelTurn } from "../src/model/contracts";
import {
  startAgentRun,
  type AgentRunController,
} from "../src/runtime/agent-runner";
import type { AgentEvent } from "../src/runtime/events";
import { createE2bTaskSession } from "../src/sandbox/e2b-session";
import { MemoryE2bSessionRecoveryStore } from "../src/sandbox/session-recovery";
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
          acceptanceCriteria: [{ id: "cancel", criterion: "Cancellation cleans up the sandbox.", verification: "Observe the terminal lifecycle." }],
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
        checkpointStore: undefined,
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
