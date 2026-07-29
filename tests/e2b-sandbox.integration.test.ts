import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "e2b";
import { createE2bTaskSession } from "../src/sandbox/e2b-session";
import { createTemporaryRepository } from "./support/temp-repo";

const templateId = process.env.E2B_TEMPLATE_ID?.trim() ?? "";
const LIVE_ENABLED =
  process.env.RUN_LIVE_E2B_TEST === "1" &&
  Boolean(process.env.E2B_API_KEY?.trim()) &&
  Boolean(templateId);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function gitStatus(cwd: string): Promise<string> {
  const process = Bun.spawn(
    ["git", "status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

test.skipIf(!LIVE_ENABLED)(
  "all six tools execute in E2B and cannot observe a host sentinel",
  async () => {
    const repository = await createTemporaryRepository();
    const sentinelRoot = await mkdtemp(
      path.join(os.tmpdir(), "coding-agent-host-sentinel-"),
    );
    const sentinelPath = path.join(sentinelRoot, "host-only.txt");
    const sentinelSecret = crypto.randomUUID();
    const originalHostFile = await readFile(
      path.join(repository.worktreePath, "src/sample.ts"),
      "utf8",
    );
    const projectStatusBefore = await gitStatus(projectRoot);
    await writeFile(sentinelPath, sentinelSecret);

    let session:
      | Awaited<ReturnType<typeof createE2bTaskSession>>
      | undefined;
    try {
      session = await createE2bTaskSession({
        localRepoPath: repository.worktreePath,
        taskId: "step-5-live",
        templateId,
      });

      const tools = (await session.client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "edit_file",
        "git",
        "read_file",
        "ripgrep",
        "run_shell",
        "tree_sitter_symbols",
      ]);

      const read = await session.client.call({
        name: "read_file",
        input: {
          repoPath: session.remoteRepoPath,
          path: "src/sample.ts",
        },
      });
      expect(read).toMatchObject({ success: true });
      expect(read.output).toContain("export class Greeter");

      const preview = await session.client.call({
        name: "edit_file",
        input: {
          repoPath: session.remoteRepoPath,
          path: "src/sample.ts",
          mode: "preview",
          oldText: "return value + 1;",
          newText: "return value + 2;",
        },
      });
      expect(preview).toMatchObject({ success: true });
      const baseVersion = preview.metadata?.baseVersion;
      expect(typeof baseVersion).toBe("string");
      const applied = await session.client.call({
        name: "edit_file",
        input: {
          repoPath: session.remoteRepoPath,
          path: "src/sample.ts",
          mode: "apply",
          oldText: "return value + 1;",
          newText: "return value + 2;",
          baseVersion: String(baseVersion),
        },
      });
      expect(applied).toMatchObject({ success: true });

      const search = await session.client.call({
        name: "ripgrep",
        input: {
          repoPath: session.remoteRepoPath,
          pattern: "return value + 2",
          fixedString: true,
        },
      });
      expect(search).toMatchObject({ success: true });
      expect(search.output).toContain("src/sample.ts");

      const symbols = await session.client.call({
        name: "tree_sitter_symbols",
        input: {
          repoPath: session.remoteRepoPath,
          path: "src/sample.ts",
        },
      });
      expect(symbols).toMatchObject({ success: true });
      expect(symbols.output).toContain("Greeter");

      const shell = await session.client.call({
        name: "run_shell",
        input: {
          repoPath: session.remoteRepoPath,
          cwd: ".",
          command: [
            `if test -e ${shellQuote(sentinelPath)}; then`,
            "  printf 'HOST_VISIBLE\\n';",
            `  cat ${shellQuote(sentinelPath)};`,
            "else",
            "  printf 'HOST_UNREACHABLE\\n';",
            "fi;",
            "printf 'remote-marker\\n' > remote-marker.txt",
          ].join(" "),
        },
      });
      expect(shell).toMatchObject({
        success: true,
        metadata: { exitCode: 0 },
      });
      expect(shell.output).toContain("HOST_UNREACHABLE");
      expect(shell.output).not.toContain(sentinelSecret);

      const positiveControl = await session.client.call({
        name: "read_file",
        input: {
          repoPath: session.remoteRepoPath,
          path: "remote-marker.txt",
        },
      });
      expect(positiveControl).toMatchObject({
        success: true,
        output: "1: remote-marker\n2: ",
        metadata: { totalLines: 2 },
      });

      const absoluteRead = await session.client.call({
        name: "read_file",
        input: {
          repoPath: session.remoteRepoPath,
          path: sentinelPath,
        },
      });
      expect(absoluteRead).toMatchObject({
        success: false,
        metadata: { code: "INVALID_PATH" },
      });

      const outsideRoot = await session.client.call({
        name: "read_file",
        input: { repoPath: "/tmp", path: "repository.bundle" },
      });
      expect(outsideRoot).toMatchObject({
        success: false,
        metadata: { code: "OUTSIDE_DEVELOPMENT_ROOT" },
      });

      const dirty = await session.client.call({
        name: "git",
        input: { repoPath: session.remoteRepoPath, subcommand: "status" },
      });
      expect(dirty).toMatchObject({
        success: true,
        metadata: { clean: false },
      });
      const diff = await session.client.call({
        name: "git",
        input: { repoPath: session.remoteRepoPath, subcommand: "diff" },
      });
      expect(diff.output).toContain("return value + 2");
      const commit = await session.client.call({
        name: "git",
        input: {
          repoPath: session.remoteRepoPath,
          subcommand: "commit",
          message: "test: verify E2B isolation",
          addAll: true,
        },
      });
      expect(commit).toMatchObject({ success: true });
      expect(commit.metadata?.sha).toMatch(/^[a-f0-9]{40,64}$/);

      expect(
        await readFile(
          path.join(repository.worktreePath, "src/sample.ts"),
          "utf8",
        ),
      ).toBe(originalHostFile);
      expect(await gitStatus(projectRoot)).toBe(projectStatusBefore);

      const observer = await Sandbox.connect(session.sandboxId);
      expect(session.serverPid).not.toBeNull();
      await observer.commands.kill(session.serverPid!);
      await Bun.sleep(100);
      await expect(
        session.client.call({
          name: "read_file",
          input: {
            repoPath: session.remoteRepoPath,
            path: "src/sample.ts",
          },
        }),
      ).rejects.toThrow();

      const sandboxId = session.sandboxId;
      await session.close();
      session = undefined;
      await expect(Sandbox.connect(sandboxId)).rejects.toThrow();
    } finally {
      await session?.close().catch(() => {});
      await repository.cleanup();
      await rm(sentinelRoot, { recursive: true, force: true });
    }
  },
  240_000,
);
