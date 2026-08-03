import { runCli } from "../../src/cli";
import type { ModelTurn } from "../../src/model/contracts";
import { startAgentRun } from "../../src/runtime/agent-runner";
import {
  MemoryProductionCheckpointStore,
  type ProductionCheckpointStore,
} from "../../src/runtime/checkpoint";
import type {
  ModelToolRequest,
  ToolResult,
} from "../../src/tools/contracts";

const phase = process.env.CANCELLATION_PHASE ?? "read";
const lifecycle: string[] = [];

process.exitCode = await runCli(process.argv.slice(2), {
  startRun(options) {
    const backing = new MemoryProductionCheckpointStore();
    let saves = 0;
    const checkpointStore: ProductionCheckpointStore = {
      load: () => backing.load(),
      async save(state) {
        saves += 1;
        if (phase === "checkpoint" && saves === 3) {
          ready();
          await Bun.sleep(100);
        }
        await backing.save(state);
      },
    };
    let modelTurns = 0;
    return startAgentRun({
      ...options,
      templateId: "template:test",
      approvalMode: "auto",
      checkpointStore,
      callModel: async (_request, modelOptions) => {
        if (phase === "model") {
          ready();
          await waitForAbort(modelOptions?.signal);
        }
        modelTurns += 1;
        if (modelTurns === 1) return proposalTurn();
        if (modelTurns > 2) {
          throw new Error("Cancellation did not stop the next model turn.");
        }
        return firstTurn(phase);
      },
      openSession: async () =>
        ({
          async call(
            request: ModelToolRequest,
            callOptions: { signal?: AbortSignal } = {},
          ): Promise<ToolResult> {
            if (phase === "policy") {
              ready();
              await waitForAbort(callOptions.signal);
            }
            if (phase === "read" || phase === "mutation") {
              ready();
              await waitForAbort(callOptions.signal);
            }
            return {
              success: true,
              output: "ok",
              truncated: false,
              originalTokenCount: 1,
              codec: "test",
            };
          },
          async reconcileActiveMutation() {
            lifecycle.push("reconcile");
            return null;
          },
          async close() {
            lifecycle.push("close");
          },
        }) as never,
      sessionEnd() {
        lifecycle.push("sessionEnd");
      },
    });
  },
});

const lifecyclePath = process.env.LIFECYCLE_FILE;
if (lifecyclePath) {
  await Bun.write(lifecyclePath, `${lifecycle.join(",")}\n`);
}

function firstTurn(cancellationPhase: string): ModelTurn {
  const action = cancellationPhase === "mutation"
    ? {
        type: "tool_use" as const,
        id: crypto.randomUUID(),
        name: "edit_file",
        input: {
          path: "README.md",
          mode: "apply",
          oldText: "old",
          newText: "new",
        },
      }
    : {
        type: "tool_use" as const,
        id: crypto.randomUUID(),
        name: "read_file",
        input: { path: "README.md" },
      };
  return {
    content: [
      {
        type: "tool_use",
        id: crypto.randomUUID(),
        name: "rewrite_plan",
        input: {
          plan: [{
            id: "cancel",
            description: "Exercise cancellation",
            status: "in_progress",
          }],
        },
      },
      action,
    ],
    stopReason: "tool_use",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function proposalTurn(): ModelTurn {
  return {
    content: [{
      type: "tool_use",
      id: crypto.randomUUID(),
      name: "propose_plan",
      input: {
        approach: "Exercise cancellation safely.",
        productDirection: "Preserve the requested product behavior.",
        visualDirection: "not_applicable",
        technologyChoices: [],
        includedScope: ["Cancellation lifecycle"],
        excludedScope: ["Unrelated work"],
        acceptanceCriteria: [{ id: "cancel", criterion: "Cancellation reaches terminal cleanup.", verification: "Observe lifecycle output." }],
        assumptions: [],
        unresolvedQuestions: [],
        executionPlan: [{ id: "cancel", description: "Exercise cancellation" }],
      },
    }],
    stopReason: "tool_use",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (signal?.aborted) {
    throw new DOMException("cancelled", "AbortError");
  }
  return new Promise<never>((_, reject) => {
    signal?.addEventListener(
      "abort",
      () => reject(new DOMException("cancelled", "AbortError")),
      { once: true },
    );
  });
}

function ready(): void {
  process.stderr.write("PHASE_READY\n");
}
