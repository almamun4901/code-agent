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
} from "../src/mcp/client";
import { parseDevelopmentRoot } from "../src/mcp/stdio-server";
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
    args: [serverPath, "--development-root", developmentRoot],
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
    properties: ["endLine", "path", "repoPath", "startLine"],
    required: ["path", "repoPath"],
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
      "repoPath",
    ],
    required: ["mode", "newText", "oldText", "path", "repoPath"],
    annotations: [false, true, false, false],
  },
  ripgrep: {
    properties: [
      "caseSensitive",
      "fixedString",
      "glob",
      "path",
      "pattern",
      "repoPath",
    ],
    required: ["pattern", "repoPath"],
    annotations: [true, false, true, false],
  },
  tree_sitter_symbols: {
    properties: ["path", "repoPath"],
    required: ["path", "repoPath"],
    annotations: [true, false, true, false],
  },
  run_shell: {
    properties: ["command", "cwd", "repoPath", "timeoutMs"],
    required: ["command", "cwd", "repoPath"],
    annotations: [false, true, false, true],
  },
  git: {
    properties: [
      "addAll",
      "branch",
      "message",
      "path",
      "remote",
      "repoPath",
      "staged",
      "subcommand",
    ],
    required: ["repoPath", "subcommand"],
    annotations: [false, true, false, true],
  },
} as const;

async function expectParity(
  repo: TemporaryRepository,
  client: McpToolClient,
  call: ToolCall,
): Promise<ToolResult> {
  const direct = canonical(
    await dispatchTool(call, { developmentRoot: repo.root }),
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
    expect(gitSchema.oneOf).toHaveLength(4);
    expect(
      gitSchema.oneOf
        ?.map((branch) => branch.properties?.subcommand?.const)
        .sort(),
    ).toEqual(["commit", "diff", "push", "status"]);
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
      arguments: { path: "src/sample.ts" },
    });

    expect(unknown.isError).toBe(true);
    expect(malformed.isError).toBe(true);
    expect((await rawClient.listTools()).tools).toHaveLength(6);

    const { client } = await connect(repo.root);
    await expect(client.call({
      name: "read_file",
      input: { path: "src/sample.ts" },
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
        repoPath: repo.worktreePath,
        path: "src/sample.ts",
        startLine: 1,
        endLine: 4,
      },
    });
    await expectParity(repo, client, {
      name: "ripgrep",
      input: {
        repoPath: repo.worktreePath,
        pattern: "Greeter",
        path: "src",
        fixedString: true,
      },
    });
    await expectParity(repo, client, {
      name: "ripgrep",
      input: {
        repoPath: repo.worktreePath,
        pattern: "not-present",
        path: "src",
        fixedString: true,
      },
    });
    await expectParity(repo, client, {
      name: "tree_sitter_symbols",
      input: { repoPath: repo.worktreePath, path: "src/sample.ts" },
    });
    await expectParity(repo, client, {
      name: "run_shell",
      input: {
        repoPath: repo.worktreePath,
        cwd: ".",
        command: "printf 'out'; printf 'err' >&2; exit 7",
      },
    });
    await expectParity(repo, client, {
      name: "git",
      input: { repoPath: repo.worktreePath, subcommand: "status" },
    });

    await repo.write(
      "src/sample.ts",
      `${await readFile(path.join(repo.worktreePath, "src/sample.ts"), "utf8")}// changed\n`,
    );
    const dirtyStatus = await expectParity(repo, client, {
      name: "git",
      input: { repoPath: repo.worktreePath, subcommand: "status" },
    });
    expect(dirtyStatus.metadata?.clean).toBe(false);
    await expectParity(repo, client, {
      name: "git",
      input: {
        repoPath: repo.worktreePath,
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
          input: { repoPath: directRepo.worktreePath, ...previewInput },
        },
        { developmentRoot: directRepo.root },
      ),
    );
    const mcpPreview = await client.call({
      name: "edit_file",
      input: { repoPath: mcpRepo.worktreePath, ...previewInput },
    });
    expect(mcpPreview).toEqual(directPreview);

    const baseVersion = String(directPreview.metadata?.baseVersion);
    const directApply = canonical(
      await dispatchTool(
        {
          name: "edit_file",
          input: {
            repoPath: directRepo.worktreePath,
            ...previewInput,
            mode: "apply",
            baseVersion,
          },
        },
        { developmentRoot: directRepo.root },
      ),
    );
    const mcpApply = await client.call({
      name: "edit_file",
      input: {
        repoPath: mcpRepo.worktreePath,
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
        repoPath: directRepo.worktreePath,
        cwd: ".",
        command,
      },
    }, { developmentRoot: directRepo.root });
    const transported = await client.call({
      name: "run_shell",
      input: {
        repoPath: mcpRepo.worktreePath,
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

  test("matches final Git state for direct and MCP commit/push mutations", async () => {
    const directRepo = await fixture();
    const mcpRepo = await fixture();
    const { client } = await connect(mcpRepo.root);
    await directRepo.write("new.txt", "new\n");
    await mcpRepo.write("new.txt", "new\n");

    const directCommit = await dispatchTool({
      name: "git",
      input: {
        repoPath: directRepo.worktreePath,
        subcommand: "commit",
        message: "add new file over MCP",
        addAll: true,
      },
    }, { developmentRoot: directRepo.root });
    const mcpCommit = await client.call({
      name: "git",
      input: {
        repoPath: mcpRepo.worktreePath,
        subcommand: "commit",
        message: "add new file over MCP",
        addAll: true,
      },
    });
    const directPush = await dispatchTool({
      name: "git",
      input: {
        repoPath: directRepo.worktreePath,
        subcommand: "push",
        remote: directRepo.bareRemotePath,
        branch: "agent-step2",
      },
    }, { developmentRoot: directRepo.root });
    const mcpPush = await client.call({
      name: "git",
      input: {
        repoPath: mcpRepo.worktreePath,
        subcommand: "push",
        remote: mcpRepo.bareRemotePath,
        branch: "agent-step2",
      },
    });

    expect(directCommit.success).toBe(true);
    expect(mcpCommit.success).toBe(true);
    expect(directPush.success).toBe(true);
    expect(mcpPush.success).toBe(true);

    const [directStatus, mcpStatus, directFile, mcpFile] = await Promise.all([
      gitOutput(directRepo.worktreePath, "status", "--porcelain"),
      gitOutput(mcpRepo.worktreePath, "status", "--porcelain"),
      gitOutput(directRepo.worktreePath, "show", "HEAD:new.txt"),
      gitOutput(mcpRepo.worktreePath, "show", "HEAD:new.txt"),
    ]);
    expect(mcpStatus).toBe(directStatus);
    expect(mcpFile).toBe(directFile);

    for (const repo of [directRepo, mcpRepo]) {
      const [head, remoteHead] = await Promise.all([
        gitOutput(repo.worktreePath, "rev-parse", "HEAD"),
        gitOutput(
          repo.worktreePath,
          "--git-dir",
          repo.bareRemotePath,
          "rev-parse",
          "refs/heads/agent-step2",
        ),
      ]);
      expect(remoteHead).toBe(head);
    }
  });

  test("matches dispatcher failures for every tool family", async () => {
    const repo = await fixture();
    const { client } = await connect(repo.root);
    const failures: ToolCall[] = [
      {
        name: "read_file",
        input: { repoPath: repo.worktreePath, path: "missing.txt" },
      },
      {
        name: "edit_file",
        input: {
          repoPath: repo.worktreePath,
          path: "src/sample.ts",
          mode: "apply",
          oldText: "Greeter",
          newText: "Changed",
          baseVersion: "stale",
        },
      },
      {
        name: "ripgrep",
        input: { repoPath: repo.worktreePath, pattern: "[" },
      },
      {
        name: "tree_sitter_symbols",
        input: { repoPath: repo.worktreePath, path: "repeat.txt" },
      },
      {
        name: "run_shell",
        input: {
          repoPath: repo.worktreePath,
          cwd: "missing",
          command: "pwd",
        },
      },
      {
        name: "git",
        input: {
          repoPath: repo.worktreePath,
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
        repoPath: repo.worktreePath,
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
        repoPath: repo.worktreePath,
        cwd: ".",
        command: "pwd",
        timeoutMs: 30_001,
      },
    });
    expect(invalidTimeout.metadata?.code).toBe("INVALID_TIMEOUT");
  });

  test("matches outside-root rejection without weakening containment", async () => {
    const allowed = await fixture();
    const outside = await fixture();
    const { client } = await connect(allowed.root);
    const call: ToolCall = {
      name: "read_file",
      input: { repoPath: outside.worktreePath, path: "src/sample.ts" },
    };

    const direct = canonical(
      await dispatchTool(call, { developmentRoot: allowed.root }),
    );
    const transported = await client.call(call);
    expect(transported).toEqual(direct);
    expect(transported.metadata?.code).toBe("OUTSIDE_DEVELOPMENT_ROOT");
  });

  test("preserves the complete serialized token budget through MCP", async () => {
    const repo = await fixture();
    const { client } = await connect(repo.root);
    const result = await expectParity(repo, client, {
      name: "read_file",
      input: { repoPath: repo.worktreePath, path: "repeat.txt" },
    });

    expect(result.truncated).toBe(true);
    expect(result.output).toContain("tokens omitted");
    expect(serializedTokenCount(result)).toBeLessThanOrEqual(4_000);
  });
});

describe("MCP stdio lifecycle", () => {
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
        input: { repoPath: "/unused", path: "unused" },
      })).rejects.toBeInstanceOf(McpResultValidationError);
      await client.close();
      mcpClients.splice(mcpClients.indexOf(client), 1);
    }
  });

  test("rejects relative, missing, and non-directory development roots", async () => {
    await expect(
      parseDevelopmentRoot(["--development-root", "relative"]),
    ).rejects.toThrow("must be absolute");
    await expect(
      parseDevelopmentRoot(["--development-root", "/definitely/missing/root"]),
    ).rejects.toThrow("does not exist");
    await expect(
      parseDevelopmentRoot(["--development-root", import.meta.path]),
    ).rejects.toThrow("not a directory");
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
        input: { repoPath: repo.worktreePath, path: "src/sample.ts" },
      }).then(
        () => "resolved",
        () => "rejected",
      ),
      Bun.sleep(2_000).then(() => "timed-out"),
    ]);
    expect(outcome).toBe("rejected");
  });
});
