import path from "node:path";
import { render, type Instance } from "ink";
import {
  startAgentRun,
  type AgentRunController,
  type AgentRunResult,
  type ControlledAgentRunOptions,
} from "./runtime/agent-runner";
import type { AgentEvent } from "./runtime/events";
import { AgentApp } from "./tui/app";
import {
  initialTuiState,
  reduceAgentEvent,
  type TuiState,
} from "./tui/state";
import { formatStaticEvent } from "./tui/static-output";

type OutputStream = {
  isTTY?: boolean;
  write(chunk: string): unknown;
};

export type CliDependencies = {
  stdout?: OutputStream;
  stderr?: OutputStream;
  startRun?: (
    options: ControlledAgentRunOptions,
  ) => AgentRunController;
  installSigint?: (handler: () => void) => () => void;
};

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<0 | 1 | 2 | 130> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    stderr.write(`${parsed.message}\n`);
    stderr.write('Usage: agent run <repo> "<task>" [--auto-approve]\n');
    return 2;
  }

  let state: TuiState = initialTuiState;
  let ink: Instance | undefined;
  const isTty = stdout.isTTY === true;
  if (!isTty && !parsed.autoApprove) {
    stderr.write("Non-interactive runs require explicit --auto-approve.\n");
    stderr.write('Usage: agent run <repo> "<task>" [--auto-approve]\n');
    return 2;
  }
  let controller: AgentRunController | undefined;
  const submitApproval = (
    proposalDigest: string,
    decision: Parameters<AgentRunController["submitApproval"]>[1],
  ) => {
    controller?.submitApproval(proposalDigest, decision);
  };
  if (isTty) {
    ink = render(<AgentApp state={state} onApprovalDecision={submitApproval} />, {
      stdout: stdout as NodeJS.WriteStream,
      stderr: stderr as NodeJS.WriteStream,
      exitOnCtrlC: false,
      maxFps: 30,
      patchConsole: false,
    });
  } else {
    stdout.write("Initializing…\n");
  }

  const observe = (event: AgentEvent) => {
    if (isTty) {
      state = reduceAgentEvent(state, event);
      ink?.rerender(<AgentApp state={state} onApprovalDecision={submitApproval} />);
      return;
    }
    for (const line of formatStaticEvent(event)) {
      stdout.write(`${line}\n`);
    }
  };

  try {
    controller = (dependencies.startRun ?? startAgentRun)({
      repoPath: path.resolve(parsed.repo),
      task: parsed.task,
      approvalMode: parsed.autoApprove ? "auto" : "interactive",
      eventSink: observe,
    });
  } catch (error) {
    ink?.unmount();
    stderr.write(`Runtime startup failed: ${errorMessage(error)}\n`);
    return 1;
  }

  const activeController = controller;
  const removeSigint = (
    dependencies.installSigint ?? installProcessSigint
  )(() => {
    void activeController.stop("sigint");
  });

  let result: AgentRunResult;
  try {
    result = await activeController.result;
    await Promise.resolve();
    if (isTty) {
      await ink?.waitUntilRenderFlush();
    }
  } finally {
    removeSigint();
    ink?.unmount();
  }

  if (result.status === "failed" && result.error) {
    stderr.write(`${result.error.code}: ${result.error.message}\n`);
  }
  const delivery = result.productionResult?.delivery;
  if (delivery) {
    stdout.write(
      `Result delivered to local branch ${delivery.branch} (${delivery.resultSha.slice(0, 12)})\n`,
    );
  }
  return result.exitCode;
}

type ParsedArguments =
  | { ok: true; repo: string; task: string; autoApprove: boolean }
  | { ok: false; message: string };

function parseArguments(argv: string[]): ParsedArguments {
  if (argv[0] !== "run") {
    return { ok: false, message: 'Expected the "run" command.' };
  }
  const autoApprove = argv[3] === "--auto-approve";
  if ((argv.length !== 3 && !(argv.length === 4 && autoApprove)) || !argv[1]) {
    return {
      ok: false,
      message: "A repository and one task argument are required.",
    };
  }
  if (!argv[2]?.trim()) {
    return { ok: false, message: "Task must not be blank." };
  }
  return { ok: true, repo: argv[1], task: argv[2], autoApprove };
}

function installProcessSigint(handler: () => void): () => void {
  process.on("SIGINT", handler);
  return () => process.removeListener("SIGINT", handler);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}
