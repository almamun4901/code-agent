import { afterEach, describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpToolClient } from "../src/mcp/client";
import { createMcpToolServer } from "../src/mcp/server";
import {
  beginMutation,
  completeMutation,
  FileMutationJournal,
  MemoryMutationJournal,
  MutationJournalError,
  mutationInputHash,
  mutationRecordSchema,
} from "../src/tools/mutation-journal";
import type { ModelToolRequest, ToolResult } from "../src/tools/contracts";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "./support/temp-repo";

const repositories: TemporaryRepository[] = [];
const directories: string[] = [];
const clients: McpToolClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(repositories.splice(0).map((repo) => repo.cleanup()));
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const mutation: ModelToolRequest = {
  name: "run_shell",
  input: {
    cwd: ".",
    command: "printf 'once\\n' >> mutation.log",
  },
};

const completedResult: ToolResult = {
  success: true,
  output: "",
  truncated: false,
  originalTokenCount: 1,
  codec: "test",
};

describe("mutation execution journal", () => {
  test("hashes semantically identical inputs independently of key order", () => {
    const first = {
      name: "run_shell" as const,
      input: { cwd: ".", command: "printf safe", timeoutMs: 1_000 },
    };
    const reordered = {
      name: "run_shell" as const,
      input: { timeoutMs: 1_000, command: "printf safe", cwd: "." },
    };

    expect(mutationInputHash(first)).toBe(mutationInputHash(reordered));
  });

  test("rejects contradictory in-flight and completed records", () => {
    const base = {
      operationId: crypto.randomUUID(),
      toolName: "run_shell" as const,
      inputHash: "a".repeat(64),
      startedAt: new Date().toISOString(),
    };
    expect(
      mutationRecordSchema.safeParse({
        ...base,
        status: "in_flight",
        completedAt: new Date().toISOString(),
        result: completedResult,
      }).success,
    ).toBe(false);
    expect(
      mutationRecordSchema.safeParse({
        ...base,
        status: "completed",
        completedAt: null,
        result: null,
      }).success,
    ).toBe(false);
  });

  test("records in-flight before completion and returns the terminal replay", async () => {
    const journal = new MemoryMutationJournal();
    const operationId = crypto.randomUUID();

    expect(await beginMutation(journal, operationId, mutation)).toBeNull();
    const inFlight = await beginMutation(journal, operationId, mutation);
    expect(inFlight).toMatchObject({
      operationId,
      status: "in_flight",
      result: null,
    });

    await expect(
      beginMutation(journal, crypto.randomUUID(), mutation),
    ).rejects.toBeInstanceOf(MutationJournalError);

    await completeMutation(journal, operationId, completedResult);
    const completed = await beginMutation(journal, operationId, mutation);
    expect(completed).toMatchObject({
      operationId,
      status: "completed",
      result: completedResult,
    });
  });

  test("persists a strict mode-0600 journal and fails closed on corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mutation-journal-"));
    directories.push(directory);
    const path = join(directory, "journal.json");
    const journal = new FileMutationJournal(path);
    const operationId = crypto.randomUUID();

    await beginMutation(journal, operationId, mutation);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await journal.load()).active?.operationId).toBe(operationId);

    await chmod(path, 0o600);
    await writeFile(path, '{"version":1,"active":{"bad":true}}\n');
    await expect(journal.load()).rejects.toBeInstanceOf(MutationJournalError);
  });

  test("returns a completed mutation without executing it twice", async () => {
    const repo = await createTemporaryRepository();
    repositories.push(repo);
    const journal = new MemoryMutationJournal();
    const server = createMcpToolServer(
      { worktreeRoot: repo.worktreePath },
      { mutationJournal: journal },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = await McpToolClient.connect(clientTransport);
    clients.push(client);
    const operationId = crypto.randomUUID();

    const first = await client.call(mutation, { operationId });
    const replay = await client.call(mutation, { operationId });

    expect(replay).toEqual(first);
    expect(
      await readFile(join(repo.worktreePath, "mutation.log"), "utf8"),
    ).toBe("once\n");
  });

  test("cancels an in-flight shell mutation and journals its terminal result", async () => {
    const repo = await createTemporaryRepository();
    repositories.push(repo);
    const journal = new MemoryMutationJournal();
    const server = createMcpToolServer(
      { worktreeRoot: repo.worktreePath },
      { mutationJournal: journal },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = await McpToolClient.connect(clientTransport);
    clients.push(client);
    const controller = new AbortController();
    const operationId = crypto.randomUUID();
    const pending = client.call(
      {
        name: "run_shell",
        input: { cwd: ".", command: "sleep 5" },
      },
      { operationId, signal: controller.signal },
    );

    await Bun.sleep(25);
    controller.abort();
    await expect(pending).rejects.toThrow();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await journal.load()).active?.status === "completed") break;
      await Bun.sleep(25);
    }
    expect((await journal.load()).active).toMatchObject({
      operationId,
      status: "completed",
      result: {
        success: false,
        metadata: { code: "CANCELLED" },
      },
    });
  });

  test("serializes journal transitions with concurrent mutating requests", async () => {
    const repo = await createTemporaryRepository();
    repositories.push(repo);
    const journal = new MemoryMutationJournal();
    const server = createMcpToolServer(
      { worktreeRoot: repo.worktreePath },
      { mutationJournal: journal },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = await McpToolClient.connect(clientTransport);
    clients.push(client);

    const [first, second] = await Promise.all([
      client.call(
        {
          name: "run_shell",
          input: {
            cwd: ".",
            command: "sleep 0.05; printf 'first\\n' >> ordered.log",
          },
        },
        { operationId: crypto.randomUUID() },
      ),
      client.call(
        {
          name: "run_shell",
          input: {
            cwd: ".",
            command: "printf 'second\\n' >> ordered.log",
          },
        },
        { operationId: crypto.randomUUID() },
      ),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(
      await readFile(join(repo.worktreePath, "ordered.log"), "utf8"),
    ).toBe("first\nsecond\n");
  });
});
