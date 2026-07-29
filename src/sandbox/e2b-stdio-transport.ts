import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Commands } from "e2b";

const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;
const DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;

type OutputChunk = string | Uint8Array;

export type E2bCommandStartOptions = {
  background: true;
  stdin: true;
  timeoutMs: 0;
  cwd?: string;
  envs?: Record<string, string>;
  onStdout(data: OutputChunk): void | Promise<void>;
  onStderr(data: OutputChunk): void | Promise<void>;
};

export type E2bCommandHandle = {
  readonly pid: number;
  wait(): Promise<unknown>;
};

export type E2bCommandController = {
  run(
    command: string,
    options: E2bCommandStartOptions,
  ): Promise<E2bCommandHandle>;
  sendStdin(pid: number, data: string | Uint8Array): Promise<void>;
  kill(pid: number): Promise<boolean>;
};

export type E2bStdioTransportOptions = {
  commands: E2bCommandController;
  command: string;
  cwd?: string;
  envs?: Record<string, string>;
  maxBufferSize?: number;
  stderrLimitBytes?: number;
};

export function e2bCommandController(
  commands: Pick<Commands, "run" | "sendStdin" | "kill">,
): E2bCommandController {
  return {
    async run(command, options) {
      return commands.run(command, {
        background: true,
        stdin: true,
        timeoutMs: 0,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.envs === undefined ? {} : { envs: options.envs }),
        onStdout: (data) => options.onStdout(data),
        onStderr: (data) => options.onStderr(data),
      });
    },
    sendStdin: (pid, data) => commands.sendStdin(pid, data),
    kill: (pid) => commands.kill(pid),
  };
}

type TransportState = "idle" | "starting" | "open" | "closing" | "closed";

export class E2bStdioTransportError extends Error {
  readonly stderr: string;

  constructor(message: string, options: { cause?: unknown; stderr?: string } = {}) {
    super(message, { cause: options.cause });
    this.name = "E2bStdioTransportError";
    this.stderr = options.stderr ?? "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown E2B command failure.";
}

function boundedUtf8Tail(
  current: string,
  chunk: OutputChunk,
  limitBytes: number,
): string {
  if (limitBytes === 0) return "";
  const next = Buffer.concat([
    Buffer.from(current),
    typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
  ]);
  return next.subarray(Math.max(0, next.length - limitBytes)).toString("utf8");
}

export class E2bStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  readonly #commands: E2bCommandController;
  readonly #command: string;
  readonly #cwd: string | undefined;
  readonly #envs: Record<string, string> | undefined;
  readonly #readBuffer: ReadBuffer;
  readonly #stderrLimitBytes: number;

  #state: TransportState = "idle";
  #handle: E2bCommandHandle | undefined;
  #stderr = "";
  #sendQueue: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;
  #closeNotified = false;

  constructor(options: E2bStdioTransportOptions) {
    if (!options.command.trim()) {
      throw new E2bStdioTransportError("E2B stdio command must not be empty.");
    }

    const maxBufferSize =
      options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    const stderrLimitBytes =
      options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES;
    if (!Number.isInteger(maxBufferSize) || maxBufferSize < 1) {
      throw new E2bStdioTransportError(
        "maxBufferSize must be a positive integer.",
      );
    }
    if (!Number.isInteger(stderrLimitBytes) || stderrLimitBytes < 0) {
      throw new E2bStdioTransportError(
        "stderrLimitBytes must be a non-negative integer.",
      );
    }

    this.#commands = options.commands;
    this.#command = options.command;
    this.#cwd = options.cwd;
    this.#envs = options.envs;
    this.#readBuffer = new ReadBuffer({ maxBufferSize });
    this.#stderrLimitBytes = stderrLimitBytes;
  }

  get pid(): number | null {
    return this.#handle?.pid ?? null;
  }

  get stderr(): string {
    return this.#stderr;
  }

  async start(): Promise<void> {
    if (this.#state !== "idle") {
      throw new E2bStdioTransportError(
        `E2B stdio transport cannot start from state ${this.#state}.`,
      );
    }

    this.#state = "starting";
    try {
      const handle = await this.#commands.run(this.#command, {
        background: true,
        stdin: true,
        timeoutMs: 0,
        ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
        ...(this.#envs === undefined ? {} : { envs: this.#envs }),
        onStdout: (data) => this.#receiveStdout(data),
        onStderr: (data) => {
          this.#stderr = boundedUtf8Tail(
            this.#stderr,
            data,
            this.#stderrLimitBytes,
          );
        },
      });

      if (this.#state !== "starting") {
        await this.#commands.kill(handle.pid).catch(() => false);
        throw new E2bStdioTransportError(
          "E2B stdio transport closed while its command was starting.",
        );
      }

      this.#handle = handle;
      this.#state = "open";
      void this.#watchProcess(handle);
    } catch (error) {
      if (this.#state === "starting") {
        this.#state = "closed";
      }
      this.#readBuffer.clear();
      const normalized =
        error instanceof E2bStdioTransportError
          ? error
          : this.#transportError(
              `Failed to start E2B stdio command: ${errorMessage(error)}`,
              error,
            );
      this.#notifyError(normalized);
      this.#notifyClose();
      throw normalized;
    }
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    const handle = this.#handle;
    if (this.#state !== "open" || !handle) {
      throw new E2bStdioTransportError("E2B stdio transport is not open.");
    }

    const framed = serializeMessage(message);
    const operation = this.#sendQueue.then(() => {
      if (this.#state !== "open" || this.#handle?.pid !== handle.pid) {
        throw new E2bStdioTransportError(
          "E2B stdio transport closed before the queued message was sent.",
        );
      }
      return this.#commands.sendStdin(handle.pid, framed);
    });
    this.#sendQueue = operation.catch(() => {});

    try {
      await operation;
    } catch (error) {
      if (
        error instanceof E2bStdioTransportError &&
        this.#state !== "open"
      ) {
        throw error;
      }
      const normalized = this.#transportError(
        `Failed to write E2B stdio message: ${errorMessage(error)}`,
        error,
      );
      this.#notifyError(normalized);
      void this.close().catch(() => {});
      throw normalized;
    }
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#close();
    await this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#state === "closed") {
      this.#notifyClose();
      return;
    }

    this.#state = "closing";
    const handle = this.#handle;
    this.#handle = undefined;
    let killError: unknown;

    if (handle) {
      try {
        await this.#commands.kill(handle.pid);
      } catch (error) {
        killError = error;
      }
    }

    this.#readBuffer.clear();
    this.#state = "closed";
    this.#notifyClose();

    if (killError) {
      throw this.#transportError(
        `Failed to kill E2B stdio command: ${errorMessage(killError)}`,
        killError,
      );
    }
  }

  async #watchProcess(handle: E2bCommandHandle): Promise<void> {
    let failure: unknown;
    try {
      await handle.wait();
    } catch (error) {
      failure = error;
    }

    if (this.#state !== "open" || this.#handle?.pid !== handle.pid) {
      return;
    }

    this.#handle = undefined;
    this.#state = "closed";
    this.#readBuffer.clear();
    this.#notifyError(
      this.#transportError(
        failure
          ? `E2B stdio command exited unexpectedly: ${errorMessage(failure)}`
          : "E2B stdio command exited unexpectedly.",
        failure,
      ),
    );
    this.#notifyClose();
  }

  #receiveStdout(data: OutputChunk): void {
    if (this.#state !== "starting" && this.#state !== "open") {
      return;
    }

    try {
      this.#readBuffer.append(
        typeof data === "string" ? Buffer.from(data) : Buffer.from(data),
      );
      while (true) {
        const message = this.#readBuffer.readMessage();
        if (message === null) break;
        this.onmessage?.(message);
      }
    } catch (error) {
      const normalized = this.#transportError(
        `Invalid E2B stdio output: ${errorMessage(error)}`,
        error,
      );
      this.#notifyError(normalized);
      void this.close().catch(() => {});
    }
  }

  #transportError(message: string, cause?: unknown): E2bStdioTransportError {
    return new E2bStdioTransportError(message, {
      cause,
      stderr: this.#stderr,
    });
  }

  #notifyError(error: Error): void {
    this.onerror?.(error);
  }

  #notifyClose(): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.onclose?.();
  }
}
