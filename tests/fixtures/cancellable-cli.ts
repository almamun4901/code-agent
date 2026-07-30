import { runCli } from "../../src/cli";
import type {
  AgentRunResult,
} from "../../src/runtime/agent-runner";

let finish!: (result: AgentRunResult) => void;
const result = new Promise<AgentRunResult>((resolve) => {
  finish = resolve;
});

process.exitCode = await runCli(process.argv.slice(2), {
  startRun(options) {
    options.eventSink?.({
      type: "run_started",
      sequence: 1,
      timestamp: new Date().toISOString(),
      runIdentity: "a".repeat(64),
    });
    options.eventSink?.({
      type: "tool_started",
      sequence: 2,
      timestamp: new Date().toISOString(),
      operationId: crypto.randomUUID(),
      toolName: "read_file",
      summary: "README.md",
    });
    return {
      result,
      stop() {
        options.eventSink?.({
          type: "shutdown_started",
          sequence: 3,
          timestamp: new Date().toISOString(),
          reason: "cancelled",
        });
        const cancelled: AgentRunResult = {
          status: "cancelled",
          reason: "cancelled",
          cleanup: "succeeded",
          exitCode: 130,
        };
        options.eventSink?.({
          type: "run_finished",
          sequence: 4,
          timestamp: new Date().toISOString(),
          reason: "cancelled",
          cleanup: "succeeded",
        });
        finish(cancelled);
        return result;
      },
    };
  },
});
