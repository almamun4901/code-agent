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
import { formatInspection, inspectRepository, type InspectionResult } from "./runtime/inspect";

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
  inspect?: (repoPath: string, operationId?: string) => Promise<InspectionResult>;
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
    stderr.write(usage());
    return 2;
  }
  if (parsed.command === "inspect") {
    try {
      const report = await (dependencies.inspect ?? inspectRepository)(path.resolve(parsed.repo), parsed.operationId);
      stdout.write(parsed.json ? `${JSON.stringify(report)}\n` : formatInspection(report));
      return 0;
    } catch (error) {
      stderr.write(`${errorMessage(error)}\n`);
      return 1;
    }
  }

  let state: TuiState = initialTuiState;
  let ink: Instance | undefined;
  const isTty = stdout.isTTY === true;
  if (!isTty && !parsed.autoApprove) {
    stderr.write("Non-interactive runs require explicit --auto-approve.\n");
    stderr.write(usage());
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
  if (!isTty) stdout.write(`agent inspect ${shellArgument(path.resolve(parsed.repo))}\n`);
  return result.exitCode;
}

type ParsedArguments =
  | { ok: true; command: "run"; repo: string; task: string; autoApprove: boolean }
  | { ok: true; command: "inspect"; repo: string; json: boolean; operationId?: string }
  | { ok: false; message: string };

function parseArguments(argv: string[]): ParsedArguments {
  if (argv[0] === "inspect") {
    if (!argv[1]) return { ok: false, message: "A repository is required." };
    let json = false;
    let operationId: string | undefined;
    for (let index = 2; index < argv.length; index += 1) {
      if (argv[index] === "--json" && !json) json = true;
      else if (argv[index] === "--operation" && !operationId && argv[index + 1] && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(argv[index + 1]!)) operationId = argv[++index];
      else return { ok: false, message: `Invalid inspect argument "${argv[index] ?? ""}".` };
    }
    return { ok: true, command: "inspect", repo: argv[1], json, ...(operationId ? { operationId } : {}) };
  }
  if (argv[0] !== "run") {
    return { ok: false, message: 'Expected the "run" or "inspect" command.' };
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
  return { ok: true, command: "run", repo: argv[1], task: argv[2], autoApprove };
}

function usage(): string {
  return 'Usage: agent run <repo> "<task>" [--auto-approve]\n       agent inspect <repo> [--json] [--operation <uuid>]\n';
}

function installProcessSigint(handler: () => void): () => void {
  process.on("SIGINT", handler);
  return () => process.removeListener("SIGINT", handler);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
