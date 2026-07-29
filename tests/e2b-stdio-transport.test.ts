import { describe, expect, test } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  E2bStdioTransport,
  E2bStdioTransportError,
  type E2bCommandHandle,
  type E2bCommandStartOptions,
  type E2bCommandController,
} from "../src/sandbox/e2b-stdio-transport";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class FakeCommands implements E2bCommandController {
  readonly processExit = deferred<unknown>();
  readonly sent: Array<string | Uint8Array> = [];
  runOptions: E2bCommandStartOptions | undefined;
  runCommand: string | undefined;
  runError: unknown;
  sendError: unknown;
  killError: unknown;
  killCalls = 0;
  sendStarted = 0;
  sendRelease: Deferred<void> | undefined;

  async run(
    command: string,
    options: E2bCommandStartOptions,
  ): Promise<E2bCommandHandle> {
    this.runCommand = command;
    this.runOptions = options;
    if (this.runError) throw this.runError;
    return {
      pid: 42,
      wait: () => this.processExit.promise,
    };
  }

  async sendStdin(_pid: number, data: string | Uint8Array): Promise<void> {
    this.sendStarted += 1;
    if (this.sendRelease) await this.sendRelease.promise;
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
  }

  async kill(): Promise<boolean> {
    this.killCalls += 1;
    if (this.killError) throw this.killError;
    this.processExit.resolve({});
    return true;
  }

  stdout(data: string | Uint8Array): void {
    this.runOptions?.onStdout(data);
  }

  stderr(data: string | Uint8Array): void {
    this.runOptions?.onStderr(data);
  }
}

function request(id: number, method = "probe"): JSONRPCMessage {
  return { jsonrpc: "2.0", id, method };
}

function transport(
  commands: FakeCommands,
  options: { maxBufferSize?: number; stderrLimitBytes?: number } = {},
): E2bStdioTransport {
  return new E2bStdioTransport({
    commands,
    command: "bun run server.ts",
    cwd: "/opt/agent",
    envs: { SAFE_VALUE: "yes" },
    ...options,
  });
}

describe("E2bStdioTransport framing", () => {
  test("starts one long-running command with stdin and separated stderr", async () => {
    const commands = new FakeCommands();
    const target = transport(commands, { stderrLimitBytes: 8 });

    await target.start();
    commands.stderr("ignored-");
    commands.stderr("diagnostic");

    expect(commands.runCommand).toBe("bun run server.ts");
    expect(commands.runOptions).toMatchObject({
      background: true,
      stdin: true,
      timeoutMs: 0,
      cwd: "/opt/agent",
      envs: { SAFE_VALUE: "yes" },
    });
    expect(target.pid).toBe(42);
    expect(Buffer.byteLength(target.stderr)).toBeLessThanOrEqual(8);
    await target.close();
  });

  test("reassembles split frames and emits multiple frames in order", async () => {
    const commands = new FakeCommands();
    const target = transport(commands);
    const received: JSONRPCMessage[] = [];
    target.onmessage = (message) => received.push(message);
    await target.start();

    const first = `${JSON.stringify(request(1, "héllo"))}\n`;
    const split = Buffer.from(first);
    commands.stdout(split.subarray(0, split.length - 2));
    expect(received).toEqual([]);
    commands.stdout(
      Buffer.concat([
        split.subarray(split.length - 2),
        Buffer.from(`${JSON.stringify(request(2))}\n${JSON.stringify(request(3))}\n`),
      ]),
    );

    expect(received).toEqual([
      request(1, "héllo"),
      request(2),
      request(3),
    ]);
    await target.close();
  });

  test("serializes concurrent writes without interleaving frames", async () => {
    const commands = new FakeCommands();
    const releaseFirst = deferred<void>();
    commands.sendRelease = releaseFirst;
    const target = transport(commands);
    await target.start();

    const first = target.send(request(1));
    const second = target.send(request(2));
    await Bun.sleep(0);
    expect(commands.sendStarted).toBe(1);
    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(commands.sendStarted).toBe(2);
    expect(commands.sent).toEqual([
      `${JSON.stringify(request(1))}\n`,
      `${JSON.stringify(request(2))}\n`,
    ]);
    await target.close();
  });

  test("fails closed for malformed and oversized output", async () => {
    for (const output of ["not-json\n", "123456789"]) {
      const commands = new FakeCommands();
      const target = transport(commands, { maxBufferSize: 8 });
      const errors: Error[] = [];
      let closes = 0;
      target.onerror = (error) => errors.push(error);
      target.onclose = () => {
        closes += 1;
      };
      await target.start();

      commands.stdout(output);
      await Bun.sleep(0);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(E2bStdioTransportError);
      expect(closes).toBe(1);
      expect(commands.killCalls).toBe(1);
    }
  });
});

describe("E2bStdioTransport lifecycle", () => {
  test("rejects invalid configuration and a second start", async () => {
    const commands = new FakeCommands();
    expect(
      () => new E2bStdioTransport({ commands, command: " " }),
    ).toThrow(E2bStdioTransportError);
    expect(
      () =>
        new E2bStdioTransport({
          commands,
          command: "server",
          maxBufferSize: 0,
        }),
    ).toThrow(E2bStdioTransportError);

    const target = transport(commands);
    await target.start();
    await expect(target.start()).rejects.toThrow("cannot start");
    await target.close();
  });

  test("normalizes startup failure and closes exactly once", async () => {
    const commands = new FakeCommands();
    commands.runError = new Error("controller unavailable");
    const target = transport(commands);
    const errors: Error[] = [];
    let closes = 0;
    target.onerror = (error) => errors.push(error);
    target.onclose = () => {
      closes += 1;
    };

    await expect(target.start()).rejects.toThrow("controller unavailable");
    await target.close();

    expect(errors).toHaveLength(1);
    expect(closes).toBe(1);
  });

  test("reports unexpected process exit and rejects later sends", async () => {
    const commands = new FakeCommands();
    const target = transport(commands);
    const errors: Error[] = [];
    let closes = 0;
    target.onerror = (error) => errors.push(error);
    target.onclose = () => {
      closes += 1;
    };
    await target.start();

    commands.processExit.reject(new Error("remote exit 137"));
    await Bun.sleep(0);

    expect(errors[0]?.message).toContain("remote exit 137");
    expect(closes).toBe(1);
    await expect(target.send(request(1))).rejects.toThrow("not open");
  });

  test("treats a successful process exit as unexpected while open", async () => {
    const commands = new FakeCommands();
    const target = transport(commands);
    const errors: Error[] = [];
    target.onerror = (error) => errors.push(error);
    await target.start();

    commands.processExit.resolve({});
    await Bun.sleep(0);

    expect(errors[0]?.message).toBe(
      "E2B stdio command exited unexpectedly.",
    );
  });

  test("normalizes send failure and kills the ambiguous process", async () => {
    const commands = new FakeCommands();
    commands.sendError = new Error("stdin disconnected");
    const target = transport(commands);
    const errors: Error[] = [];
    target.onerror = (error) => errors.push(error);
    await target.start();

    await expect(target.send(request(1))).rejects.toThrow("stdin disconnected");
    await Bun.sleep(0);

    expect(errors).toHaveLength(1);
    expect(commands.killCalls).toBe(1);
  });

  test("coalesces close, reports kill failure, and notifies once", async () => {
    const commands = new FakeCommands();
    commands.killError = new Error("kill unavailable");
    const target = transport(commands);
    let closes = 0;
    target.onclose = () => {
      closes += 1;
    };
    await target.start();

    const results = await Promise.allSettled([target.close(), target.close()]);

    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(commands.killCalls).toBe(1);
    expect(closes).toBe(1);
    await expect(target.send(request(1))).rejects.toThrow("not open");
  });

  test("does not write a queued message after close begins", async () => {
    const commands = new FakeCommands();
    const releaseFirst = deferred<void>();
    commands.sendRelease = releaseFirst;
    const target = transport(commands);
    await target.start();

    const first = target.send(request(1));
    const second = target.send(request(2));
    const secondResult = second.then(
      () => undefined,
      (error: unknown) => error,
    );
    await Bun.sleep(0);
    const closing = target.close();
    releaseFirst.resolve();

    await first;
    const secondError = await secondResult;
    expect(secondError).toBeInstanceOf(E2bStdioTransportError);
    expect((secondError as Error).message).toContain("closed before");
    await closing;
    expect(commands.sent).toHaveLength(1);
  });
});
