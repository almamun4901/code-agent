import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpResultValidationError,
  McpToolClient,
  PRE_TOOL_USE_OBSERVATIONS_META_KEY,
} from "../src/mcp/client";
import { createMcpToolServer } from "../src/mcp/server";
import { parseWorktreeBoundary } from "../src/mcp/stdio-server";
import type { ToolCall, ToolResult } from "../src/tools/contracts";
import { dispatchTool } from "../src/tools/dispatcher";
import { serializedTokenCount } from "../src/tools/token-budget";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "./support/temp-repo";

const serverPath = fileURLToPath(
  new URL("../src/mcp/stdio-server.ts", import.meta.url),
);
const repositories: TemporaryRepository[] = [];
const mcpClients: McpToolClient[] = [];
const rawClients: Client[] = [];

afterEach(async () => {
  await Promise.all(
    mcpClients.splice(0).map((client) => client.close().catch(() => {})),
  );
  await Promise.all(
    rawClients.splice(0).map((client) => client.close().catch(() => {})),
  );
  await Promise.all(repositories.splice(0).map((repo) => repo.cleanup()));
});

async function fixture(): Promise<TemporaryRepository> {
  const repo = await createTemporaryRepository();
  repositories.push(repo);
  return repo;
}

function stdioTransport(
  developmentRoot: string,
  stderr: "pipe" | "ignore" = "pipe",
): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [
      serverPath,
      "--worktree-root",
      path.join(developmentRoot, "worktree"),
      "--allowed-parent",
      developmentRoot,
    ],
    cwd: path.dirname(serverPath),
    env: {
      ...getDefaultEnvironment(),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    },
    stderr,
  });
}

async function connect(
  developmentRoot: string,
): Promise<{ client: McpToolClient; transport: StdioClientTransport }> {
  const transport = stdioTransport(developmentRoot);
  const client = await McpToolClient.connect(transport);
  mcpClients.push(client);
  return { client, transport };
}

async function connectRaw(
  developmentRoot: string,
): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = stdioTransport(developmentRoot);
  const client = new Client({ name: "step-4-test", version: "0.1.0" });
  await client.connect(transport);
  rawClients.push(client);
  return { client, transport };
}

function canonical(result: ToolResult): ToolResult {
  return JSON.parse(JSON.stringify(result)) as ToolResult;
}

const expectedDiscovery = {
  read_file: {
    properties: ["endLine", "path", "startLine"],
    required: ["path"],
    annotations: [true, false, true, false],
  },
  edit_file: {
    properties: [
      "baseVersion",
      "mode",
      "newText",
      "oldText",
      "path",
      "replaceAll",
    ],
    required: ["mode", "newText", "oldText", "path"],
    annotations: [false, true, false, false],
  },
  ripgrep: {
    properties: [
      "caseSensitive",
      "fixedString",
      "glob",
      "path",
      "pattern",
    ],
    required: ["pattern"],
    annotations: [true, false, true, false],
  },
  tree_sitter_symbols: {
    properties: ["path"],
    required: ["path"],
    annotations: [true, false, true, false],
  },
  run_shell: {
    properties: ["command", "cwd", "timeoutMs", "verificationRequirementId"],
    required: ["command", "cwd"],
    annotations: [false, true, false, true],
  },
  git: {
    properties: [
      "addAll",
      "message",
      "path",
      "staged",
      "subcommand",
    ],
    required: ["subcommand"],
    annotations: [false, true, false, false],
  },
} as const;

async function expectParity(
  repo: TemporaryRepository,
  client: McpToolClient,
  call: ToolCall,
): Promise<ToolResult> {
  const direct = canonical(
    await dispatchTool(call, { worktreeRoot: repo.worktreePath }),
  );
  const transported = await client.call(call);
  expect(transported).toEqual(direct);
  return transported;
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout.trim();
}

describe("MCP stdio discovery and protocol boundary", () => {
  test("discovers exactly the six typed tools with object schemas and annotations", async () => {
    const repo = await fixture();
    const { client } = await connect(repo.root);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "edit_file",
      "git",
      "read_file",
      "ripgrep",
      "run_shell",
      "tree_sitter_symbols",
    ]);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(6);
    for (const tool of tools) {
      const expected =
        expectedDiscovery[tool.name as keyof typeof expectedDiscovery];
      const schema = tool.inputSchema as {
        additionalProperties?: boolean;
        oneOf?: Array<{
          additionalProperties?: boolean;
          properties?: { subcommand?: { const?: string } };
        }>;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(tool.description?.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
        [...expected.properties].sort(),
      );
      expect([...(schema.required ?? [])].sort()).toEqual(
        [...expected.required].sort(),
      );
      expect([
        tool.annotations?.readOnlyHint,
        tool.annotations?.destructiveHint,
        tool.annotations?.idempotentHint,
        tool.annotations?.openWorldHint,
      ]).toEqual([...expected.annotations]);
    }

    const git = tools.find((tool) => tool.name === "git");
    const gitSchema = git?.inputSchema as {
      oneOf?: Array<{
        additionalProperties?: boolean;
        properties?: { subcommand?: { const?: string } };
      }>;
    };
    expect(gitSchema.oneOf).toHaveLength(3);
    expect(
      gitSchema.oneOf
        ?.map((branch) => branch.properties?.subcommand?.const)
        .sort(),
    ).toEqual(["commit", "diff", "status"]);
    expect(
      gitSchema.oneOf?.every(
        (branch) => branch.additionalProperties === false,
      ),
    ).toBe(true);
  });

  test("normalizes SDK protocol errors and keeps the connection alive", async () => {
    const repo = await fixture();
    const { client: rawClient } = await connectRaw(repo.root);

    const unknown = await rawClient.callTool({
      name: "unknown",
      arguments: { repoPath: repo.worktreePath },
    });
    const malformed = await rawClient.callTool({
      name: "read_file",
      arguments: {},
    });

    expect(unknown.isError).toBe(true);
    expect(malformed.isError).toBe(true);
    expect((await rawClient.listTools()).tools).toHaveLength(6);

    const { client } = await connect(repo.root);
    await expect(client.call({
      name: "read_file",
      input: {},
    } as never)).rejects.toBeInstanceOf(McpResultValidationError);
    expect((await client.listTools()).tools).toHaveLength(6);
  });
});

describe("direct versus MCP behavior parity", () => {
  test("matches read, search, symbol, shell, and git results", async () => {
    const repo = await fixture();
    const { client } = await connect(repo.root);

    await expectParity(repo, client, {
      name: "read_file",
      input: {
        path: "src/sample.ts",
        startLine: 1,
        endLine: 4,
      },
    });
    await expectParity(repo, client, {
      name: "ripgrep",
      input: {
        pattern: "Greeter",
        path: "src",
        fixedString: true,
      },
    });
    await expectParity(repo, client, {
      name: "ripgrep",
      input: {
        pattern: "not-present",
        path: "src",
        fixedString: true,
      },
    });
    await expectParity(repo, client, {
      name: "tree_sitter_symbols",
      input: { path: "src/sample.ts" },
    });
    await expectParity(repo, client, {
      name: "run_shell",
      input: {
        cwd: ".",
        command: "printf 'out'; printf 'err' >&2; exit 7",
      },
    });
    await expectParity(repo, client, {
      name: "git",
      input: { subcommand: "status" },
    });

    await repo.write(
      "src/sample.ts",
      `${await readFile(path.join(repo.worktreePath, "src/sample.ts"), "utf8")}// changed\n`,
    );
    const dirtyStatus = await expectParity(repo, client, {
      name: "git",
      input: { subcommand: "status" },
    });
    expect(dirtyStatus.metadata?.clean).toBe(false);
    await expectParity(repo, client, {
      name: "git",
      input: {
        subcommand: "diff",
        path: "src/sample.ts",
      },
    });
  });

  test("matches edit preview and apply against independent identical fixtures", async () => {
    const directRepo = await fixture();
    const mcpRepo = await fixture();
    const { client } = await connect(mcpRepo.root);
    const previewInput = {
      path: "src/sample.ts",
      mode: "preview" as const,
      oldText: "Greeter",
      newText: "RenamedGreeter",
    };

    const directPreview = canonical(
      await dispatchTool(
        {
          name: "edit_file",
          input: { ...previewInput },
        },
        { worktreeRoot: directRepo.worktreePath },
      ),
    );
    const mcpPreview = await client.call({
      name: "edit_file",
      input: { ...previewInput },
    });
    expect(mcpPreview).toEqual(directPreview);

    const baseVersion = String(directPreview.metadata?.baseVersion);
    const directApply = canonical(
      await dispatchTool(
        {
          name: "edit_file",
          input: {
            ...previewInput,
            mode: "apply",
            baseVersion,
          },
        },
        { worktreeRoot: directRepo.worktreePath },
      ),
    );
    const mcpApply = await client.call({
      name: "edit_file",
      input: {
        ...previewInput,
        mode: "apply",
        baseVersion,
      },
    });

    expect(mcpApply).toEqual(directApply);
    expect(
      await readFile(path.join(mcpRepo.worktreePath, "src/sample.ts"), "utf8"),
    ).toBe(
      await readFile(path.join(directRepo.worktreePath, "src/sample.ts"), "utf8"),
    );
  });

  test("matches final bytes and Git state for direct and MCP shell mutations", async () => {
    const directRepo = await fixture();
    const mcpRepo = await fixture();
    const { client } = await connect(mcpRepo.root);
    const command = "printf 'written by shell\\n' > shell.txt";

    const direct = await dispatchTool({
      name: "run_shell",
      input: {
        cwd: ".",
        command,
      },
    }, { worktreeRoot: directRepo.worktreePath });
    const transported = await client.call({
      name: "run_shell",
      input: {
        cwd: ".",
        command,
      },
    });

    expect(direct.success).toBe(true);
    expect(transported.success).toBe(true);
    expect(
      await readFile(path.join(mcpRepo.worktreePath, "shell.txt"), "utf8"),
    ).toBe(
      await readFile(path.join(directRepo.worktreePath, "shell.txt"), "utf8"),
    );
    expect(
      await gitOutput(mcpRepo.worktreePath, "status", "--porcelain"),
    ).toBe(
      await gitOutput(directRepo.worktreePath, "status", "--porcelain"),
    );
  });

  test("matches final Git state for direct and MCP commits", async () => {
    const directRepo = await fixture();
    const mcpRepo = await fixture();
    const { client } = await connect(mcpRepo.root);
    await directRepo.write("new.txt", "new\n");
    await mcpRepo.write("new.txt", "new\n");

    const directCommit = await dispatchTool({
      name: "git",
      input: {
        subcommand: "commit",
        message: "add new file over MCP",
        addAll: true,
      },
    }, { worktreeRoot: directRepo.worktreePath });
    const mcpCommit = await client.call({
      name: "git",
      input: {
        subcommand: "commit",
        message: "add new file over MCP",
        addAll: true,
      },
    });
    expect(directCommit.success).toBe(true);
    expect(mcpCommit.success).toBe(true);

    const [directStatus, mcpStatus, directFile, mcpFile] = await Promise.all([
      gitOutput(directRepo.worktreePath, "status", "--porcelain"),
      gitOutput(mcpRepo.worktreePath, "status", "--porcelain"),
      gitOutput(directRepo.worktreePath, "show", "HEAD:new.txt"),
      gitOutput(mcpRepo.worktreePath, "show", "HEAD:new.txt"),
    ]);
    expect(mcpStatus).toBe(directStatus);
    expect(mcpFile).toBe(directFile);

  });

  test("matches dispatcher failures for every tool family", async () => {
    const repo = await fixture();
    const { client } = await connect(repo.root);
    const failures: ToolCall[] = [
      {
        name: "read_file",
        input: { path: "missing.txt" },
      },
      {
        name: "edit_file",
        input: {
          path: "src/sample.ts",
          mode: "apply",
          oldText: "Greeter",
          newText: "Changed",
          baseVersion: "stale",
        },
      },
      {
        name: "ripgrep",
        input: { pattern: "[" },
      },
      {
        name: "tree_sitter_symbols",
        input: { path: "repeat.txt" },
      },
      {
        name: "run_shell",
        input: {
          cwd: "missing",
          command: "pwd",
        },
      },
      {
        name: "git",
        input: {
          subcommand: "commit",
          message: "empty",
          addAll: false,
        },
      },
    ];

    for (const call of failures) {
      const result = await expectParity(repo, client, call);
      expect(result.success).toBe(false);
    }

    const timeout = await expectParity(repo, client, {
      name: "run_shell",
      input: {
        cwd: ".",
        command: "sleep 1",
        timeoutMs: 10,
      },
    });
    expect(timeout.metadata?.timedOut).toBe(true);
    expect(Number(timeout.metadata?.exitCode)).toBeGreaterThan(0);

    const invalidTimeout = await expectParity(repo, client, {
      name: "run_shell",
      input: {
        cwd: ".",
        command: "pwd",
        timeoutMs: 30_001,
      },
    });
    expect(invalidTimeout.metadata?.code).toBe("INVALID_TIMEOUT");
  });

  test("binds every request to the server's immutable worktree root", async () => {
    const allowed = await fixture();
    const { client } = await connect(allowed.root);
    const call: ToolCall = {
      name: "read_file",
      input: { path: "src/sample.ts" },
    };

    const direct = canonical(
      await dispatchTool(call, { worktreeRoot: allowed.worktreePath }),
    );
    const transported = await client.call(call);
    expect(transported).toEqual(direct);
    expect(transported.success).toBe(true);
    expect(transported.output).toContain("export class Greeter");
  });

  test("preserves the complete serialized token budget through MCP", async () => {
    const repo = await fixture();
    const { client } = await connect(repo.root);
    const result = await expectParity(repo, client, {
      name: "read_file",
      input: { path: "repeat.txt" },
    });

    expect(result.truncated).toBe(true);
    expect(result.output).toContain("tokens omitted");
    expect(serializedTokenCount(result)).toBeLessThanOrEqual(4_000);
  });
});

describe("MCP stdio lifecycle", () => {
  test("returns bounded PreToolUse observations outside the tool result", async () => {
    const repo = await fixture();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createMcpToolServer({
      worktreeRoot: repo.worktreePath,
      preToolUse: async () => ({ outcome: "allow" }),
    });
    await server.connect(serverTransport);
    const client = await McpToolClient.connect(clientTransport);
    mcpClients.push(client);
    const observations: Array<{ index: number; durationMs: number; outcome: string }> = [];

    const result = await client.call({
      name: "read_file",
      input: { path: "src/sample.ts" },
    }, {
      observePreToolUse(observation) {
        observations.push(observation);
      },
    });

    expect(result.success).toBe(true);
    expect(result.metadata).not.toHaveProperty("preToolUse");
    expect(observations.map(({ index, outcome }) => ({ index, outcome }))).toEqual([
      { index: 0, outcome: "allow" },
      { index: 1, outcome: "allow" },
    ]);
    expect(observations.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0)).toBe(true);
  });

  test("drops malformed PreToolUse metadata without changing a valid tool result", async () => {
    const invalidValues = [
      "not-an-array",
      [{ index: 0, durationMs: -1, outcome: "allow" }],
      [{ index: 0, durationMs: 1, outcome: "unknown" }],
      [{ index: 1, durationMs: 1, outcome: "allow" }],
      Array.from({ length: 3 }, (_, index) => ({ index, durationMs: 1, outcome: "allow" })),
    ];

    for (const invalid of invalidValues) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: "malformed-telemetry-test", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            output: "valid",
            truncated: false,
            originalTokenCount: 1,
            codec: "test",
          }),
        }],
        isError: false,
        _meta: { [PRE_TOOL_USE_OBSERVATIONS_META_KEY]: invalid },
      }));
      await server.connect(serverTransport);
      const client = await McpToolClient.connect(clientTransport);
      mcpClients.push(client);
      const observations: unknown[] = [];

      await expect(client.call({
        name: "read_file",
        input: { path: "unused" },
      }, {
        observePreToolUse(observation) {
          observations.push(observation);
        },
      })).resolves.toMatchObject({ success: true, output: "valid" });
      expect(observations).toEqual([]);
      await client.close();
      mcpClients.splice(mcpClients.indexOf(client), 1);
    }
  });

  test("serializes concurrent tool execution within one server session", async () => {
    const repo = await fixture();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    let active = 0;
    let maximumActive = 0;
    const server = createMcpToolServer({
      worktreeRoot: repo.worktreePath,
      preToolUse: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(20);
        active -= 1;
        return { outcome: "allow" };
      },
    });
    await server.connect(serverTransport);
    const client = await McpToolClient.connect(clientTransport);
    mcpClients.push(client);

    const calls = Array.from({ length: 3 }, () =>
      client.call({
        name: "read_file",
        input: { path: "src/sample.ts" },
      })
    );
    const results = await Promise.all(calls);

    expect(results.every((result) => result.success)).toBe(true);
    expect(maximumActive).toBe(1);
  });

  test("throws for malformed or contradictory server results", async () => {
    const responses = [
      {
        content: [{ type: "text" as const, text: "not JSON" }],
        isError: false,
      },
      {
        content: [{ type: "text" as const, text: "{}" }],
        isError: false,
      },
      {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            output: "failed",
            truncated: false,
            originalTokenCount: 1,
            codec: "test",
          }),
        }],
        isError: false,
      },
    ];

    for (const response of responses) {
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: "malformed-result-test", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(CallToolRequestSchema, async () => response);
      await server.connect(serverTransport);
      const client = await McpToolClient.connect(clientTransport);
      mcpClients.push(client);

      await expect(client.call({
        name: "read_file",
        input: { path: "unused" },
      })).rejects.toBeInstanceOf(McpResultValidationError);
      await client.close();
      mcpClients.splice(mcpClients.indexOf(client), 1);
    }
  });

  test("rejects invalid worktree boundaries", async () => {
    const repo = await fixture();
    await expect(
      parseWorktreeBoundary([
        "--worktree-root",
        "relative",
        "--allowed-parent",
        repo.root,
      ]),
    ).rejects.toThrow("must be absolute");
    await expect(
      parseWorktreeBoundary([
        "--worktree-root",
        "/definitely/missing/root",
        "--allowed-parent",
        repo.root,
      ]),
    ).rejects.toThrow("does not exist");
    await expect(
      parseWorktreeBoundary([
        "--worktree-root",
        import.meta.path,
        "--allowed-parent",
        repo.root,
      ]),
    ).rejects.toThrow("not a directory");
    await expect(
      parseWorktreeBoundary([
        "--worktree-root",
        repo.root,
        "--allowed-parent",
        repo.root,
      ]),
    ).rejects.toThrow("must be a child");
    await expect(
      parseWorktreeBoundary([
        "--worktree-root",
        repo.worktreePath,
        "--allowed-parent",
        repo.worktreePath,
      ]),
    ).rejects.toThrow("must be a child");
  });

  test("fails startup without a development root using stderr only", async () => {
    const child = Bun.spawn([process.execPath, serverPath], {
      cwd: path.dirname(serverPath),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Usage:");
  });

  test("coalesces concurrent closes and leaves no child process", async () => {
    const repo = await fixture();
    const { client, transport } = await connect(repo.root);
    const pid = transport.pid;
    expect(pid).not.toBeNull();

    const firstClose = client.close();
    const secondClose = client.close();
    await Promise.all([firstClose, secondClose]);
    await client.close();
    mcpClients.splice(mcpClients.indexOf(client), 1);

    expect(transport.pid).toBeNull();
    if (pid !== null) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });

  test("rejects a tool call after unexpected child death", async () => {
    const repo = await fixture();
    const { client, transport } = await connect(repo.root);
    const pid = transport.pid;
    if (pid === null) throw new Error("MCP child did not start");

    process.kill(pid, "SIGKILL");
    const outcome = await Promise.race([
      client.call({
        name: "read_file",
        input: { path: "src/sample.ts" },
      }).then(
        () => "resolved",
        () => "rejected",
      ),
      Bun.sleep(2_000).then(() => "timed-out"),
    ]);
    expect(outcome).toBe("rejected");
  });
});
