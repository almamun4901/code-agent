import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "e2b";
import {
  createE2bTaskSession,
  recoverE2bTaskSession,
} from "../src/sandbox/e2b-session";
import { MemoryE2bSessionRecoveryStore } from "../src/sandbox/session-recovery";
import {
  readLiveE2bConfig,
  toolStdout,
} from "./support/live-e2b-config";
import { createTemporaryRepository } from "./support/temp-repo";

const liveConfig = readLiveE2bConfig();
const templateId = liveConfig.templateRef;
const LIVE_ENABLED = liveConfig.enabled;
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
        taskId: "step-6-live",
        templateId,
      });
      const observer = await Sandbox.connect(session.sandboxId);
      const runtimeDigestBefore = (
        await observer.commands.run("sha256sum /opt/agent/package.json")
      ).stdout;
      const gitMarkerDigestBefore = (
        await observer.commands.run(
          `sha256sum ${session.remoteRepoPath}/.git`,
        )
      ).stdout;

      const tools = (await session.client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "edit_file",
        "git",
        "read_file",
        "ripgrep",
        "run_shell",
        "tree_sitter_symbols",
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.properties).not.toHaveProperty("repoPath");
      }
      const gitSchema = tools.find((tool) => tool.name === "git")
        ?.inputSchema as {
          oneOf?: Array<{
            properties?: { subcommand?: { const?: string } };
          }>;
        };
      expect(
        gitSchema.oneOf?.map(
          (branch) => branch.properties?.subcommand?.const,
        ).sort(),
      ).toEqual(["commit", "diff", "status"]);

      const read = await session.client.call({
        name: "read_file",
        input: {
          path: "src/sample.ts",
        },
      });
      expect(read).toMatchObject({ success: true });
      expect(read.output).toContain("export class Greeter");

      const preview = await session.client.call({
        name: "edit_file",
        input: {
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
          pattern: "return value + 2",
          fixedString: true,
        },
      });
      expect(search).toMatchObject({ success: true });
      expect(search.output).toContain("src/sample.ts");

      const symbols = await session.client.call({
        name: "tree_sitter_symbols",
        input: {
          path: "src/sample.ts",
        },
      });
      expect(symbols).toMatchObject({ success: true });
      expect(symbols.output).toContain("Greeter");

      const shell = await session.client.call({
        name: "run_shell",
        input: {
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

      const identity = await session.client.call({
        name: "run_shell",
        input: { cwd: ".", command: "id -un" },
      });
      expect(identity).toMatchObject({
        success: true,
        metadata: { exitCode: 0 },
      });
      expect(identity.output).toContain("runner");

      const outsideWrite = await session.client.call({
        name: "run_shell",
        input: {
          cwd: ".",
          command:
            "printf 'escape\\n' > /workspace/tasks/outside-runner.txt",
        },
      });
      expect(Number(outsideWrite.metadata?.exitCode)).not.toBe(0);
      expect(
        (
          await observer.commands.run(
            "test ! -e /workspace/tasks/outside-runner.txt",
          )
        ).exitCode,
      ).toBe(0);

      const encodedRuntime = Buffer.from(
        "/opt/agent/package.json",
      ).toString("base64");
      const runtimeMutation = await session.client.call({
        name: "run_shell",
        input: {
          cwd: ".",
          command:
            `bun -e 'await Bun.write(Buffer.from("${encodedRuntime}","base64").toString(),"poison")'`,
        },
      });
      expect(Number(runtimeMutation.metadata?.exitCode)).not.toBe(0);

      const encodedGitMarker = Buffer.from(
        `${session.remoteRepoPath}/.git`,
      ).toString("base64");
      const gitMutation = await session.client.call({
        name: "run_shell",
        input: {
          cwd: ".",
          command:
            `bun -e 'await Bun.write(Buffer.from("${encodedGitMarker}","base64").toString(),"poison")'`,
        },
      });
      expect(Number(gitMutation.metadata?.exitCode)).not.toBe(0);

      expect(
        (
          await observer.commands.run("sha256sum /opt/agent/package.json")
        ).stdout,
      ).toBe(runtimeDigestBefore);
      expect(
        (
          await observer.commands.run(
            `sha256sum ${session.remoteRepoPath}/.git`,
          )
        ).stdout,
      ).toBe(gitMarkerDigestBefore);

      const directNetwork = await session.client.call({
        name: "run_shell",
        input: {
          cwd: ".",
          command: "curl https://example.com",
        },
      });
      expect(directNetwork).toMatchObject({
        success: false,
        metadata: { code: "SHELL_EGRESS_UTILITY" },
      });

      const encodedUrl = Buffer.from("https://example.com").toString(
        "base64",
      );
      const hexHost = Buffer.from("example.com").toString("hex");
      const networkAttempts = [
        {
          name: "bun-http",
          command:
            `bun -e 'await fetch(Buffer.from("${encodedUrl}","base64").toString()); console.log("NETWORK_"+"REACHED")'`,
        },
        {
          name: "node-http",
          command:
            `node -e 'fetch(Buffer.from("${encodedUrl}","base64").toString()).then(()=>console.log("NETWORK_"+"REACHED")).catch(()=>process.exit(2))'`,
        },
        {
          name: "python-http",
          command:
            `python3 -c 'import urllib.request; urllib.request.urlopen(bytes.fromhex("${Buffer.from("https://example.com").toString("hex")}").decode(),timeout=3); print("NETWORK_"+"REACHED")'`,
        },
        {
          name: "raw-tcp",
          command:
            `python3 -c 'import socket; socket.create_connection((bytes.fromhex("${hexHost}").decode(),443),3); print("NETWORK_"+"REACHED")'`,
        },
        {
          name: "dns",
          command:
            `python3 -c 'import socket; socket.gethostbyname(bytes.fromhex("${hexHost}").decode()); print("NETWORK_"+"REACHED")'`,
        },
      ];
      for (const attempt of networkAttempts) {
        const result = await session.client.call({
          name: "run_shell",
          input: {
            cwd: ".",
            command: attempt.command,
            timeoutMs: 6_000,
          },
        });
        expect(toolStdout(result.output)).not.toContain(
          "NETWORK_REACHED",
        );
        if (attempt.name === "python-http") {
          expect(result.output).not.toContain("ModuleNotFoundError");
        }
        expect(
          result.metadata?.timedOut === true ||
            Number(result.metadata?.exitCode) !== 0,
        ).toBe(true);
      }

      const environment = await session.client.call({
        name: "run_shell",
        input: { cwd: ".", command: "env" },
      });
      expect(environment.success).toBe(true);
      for (const forbidden of [
        "ANTHROPIC",
        "OPENAI",
        "E2B",
        "GITHUB",
        "API_KEY",
        "TOKEN",
        "GIT_CONFIG",
        "NODE_OPTIONS",
        "BUN_OPTIONS",
        "LD_PRELOAD",
        "PYTHONPATH",
      ]) {
        expect(environment.output).not.toContain(forbidden);
      }

      for (const command of [
        "sh -c 'sleep 60 &'",
        "(sh -c 'sleep 60 &' &) ; exit 0",
      ]) {
        const background = await session.client.call({
          name: "run_shell",
          input: { cwd: ".", command },
        });
        expect(background.metadata?.exitCode).toBe(0);
        const runnerProcesses = await observer.commands.run(
          [
            "if pgrep -u runner >/dev/null; then",
            "  printf 'RUNNER_PROCESS_FOUND\\n';",
            "else",
            "  printf 'NO_RUNNER_PROCESS\\n';",
            "fi",
          ].join(" "),
        );
        expect(runnerProcesses.stdout).toBe("NO_RUNNER_PROCESS\n");
      }

      await observer.commands.run(
        [
          "printf 'outside-unchanged\\n' > /tmp/safety-outside.txt",
          `ln -s /tmp/safety-outside.txt ${session.remoteRepoPath}/escape.txt`,
        ].join(" && "),
      );
      const symlinkRead = await session.client.call({
        name: "read_file",
        input: { path: "escape.txt" },
      });
      const symlinkEdit = await session.client.call({
        name: "edit_file",
        input: {
          path: "escape.txt",
          mode: "preview",
          oldText: "outside",
          newText: "changed",
        },
      });
      expect(symlinkRead.metadata?.code).toBe("SYMLINK_PATH");
      expect(symlinkEdit.metadata?.code).toBe("SYMLINK_PATH");
      expect(
        (await observer.commands.run("cat /tmp/safety-outside.txt")).stdout,
      ).toBe("outside-unchanged\n");

      const positiveControl = await session.client.call({
        name: "read_file",
        input: {
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
          path: sentinelPath,
        },
      });
      expect(absoluteRead).toMatchObject({
        success: false,
        metadata: { code: "INVALID_PATH" },
      });

      const dirty = await session.client.call({
        name: "git",
        input: { subcommand: "status" },
      });
      expect(dirty).toMatchObject({
        success: true,
        metadata: { clean: false },
      });
      const diff = await session.client.call({
        name: "git",
        input: { subcommand: "diff" },
      });
      expect(diff.output).toContain("return value + 2");
      const commit = await session.client.call({
        name: "git",
        input: {
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

      expect(session.serverPid).not.toBeNull();
      await observer.commands.kill(session.serverPid!);
      await Bun.sleep(100);
      await expect(
        session.client.call({
          name: "read_file",
          input: {
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

test.skipIf(!LIVE_ENABLED)(
  "cancelled E2B mutations reconcile before sandbox cleanup",
  async () => {
    const repository = await createTemporaryRepository();
    const store = new MemoryE2bSessionRecoveryStore();
    let session:
      | Awaited<ReturnType<typeof createE2bTaskSession>>
      | undefined;
    try {
      session = await createE2bTaskSession({
        localRepoPath: repository.worktreePath,
        taskId: "mutation-cancel-live",
        templateId,
        recovery: {
          runIdentity: "mutation-cancel-live",
          store,
        },
      });
      const controller = new AbortController();
      const operationId = crypto.randomUUID();
      const pending = session.call(
        {
          name: "run_shell",
          input: { cwd: ".", command: "sleep 30" },
        },
        { operationId, signal: controller.signal },
      );

      await Bun.sleep(250);
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(await session.reconcileActiveMutation(10_000)).toMatchObject({
        operationId,
        status: "completed",
        result: {
          success: false,
          metadata: { code: "CANCELLED" },
        },
      });

      const sandboxId = session.sandboxId;
      await session.close();
      session = undefined;
      expect(await store.load()).toBeNull();
      await expect(Sandbox.connect(sandboxId)).rejects.toThrow();
    } finally {
      await session?.reconcileActiveMutation(10_000).catch(() => {});
      await session?.close().catch(() => {});
      await repository.cleanup();
    }
  },
  120_000,
);

test.skipIf(!LIVE_ENABLED)(
  "completed E2B mutations survive host transport loss without replay",
  async () => {
    const repository = await createTemporaryRepository();
    const store = new MemoryE2bSessionRecoveryStore();
    const runIdentity = "mutation-reconnect-live";
    let original:
      | Awaited<ReturnType<typeof createE2bTaskSession>>
      | undefined;
    let recovered:
      | Awaited<ReturnType<typeof recoverE2bTaskSession>>
      | undefined;
    try {
      original = await createE2bTaskSession({
        localRepoPath: repository.worktreePath,
        taskId: "mutation-reconnect-live",
        templateId,
        recovery: { runIdentity, store },
      });
      const sandboxId = original.sandboxId;
      const operationId = crypto.randomUUID();
      await original.call(
        {
          name: "run_shell",
          input: {
            cwd: ".",
            command: "printf 'once\\n' >> recovery-marker.txt",
          },
        },
        { operationId },
      );

      await original.client.close();
      recovered = await recoverE2bTaskSession({ runIdentity, store });
      original = undefined;

      expect(recovered.sandboxId).toBe(sandboxId);
      expect(recovered.recoveredMutation).toMatchObject({
        operationId,
        status: "completed",
      });
      const marker = await recovered.call({
        name: "read_file",
        input: { path: "recovery-marker.txt" },
      });
      expect(marker).toMatchObject({
        success: true,
        output: "1: once\n2: ",
      });

      await recovered.close();
      recovered = undefined;
      expect(await store.load()).toBeNull();
      await expect(Sandbox.connect(sandboxId)).rejects.toThrow();
    } finally {
      await recovered?.close().catch(() => {});
      await original?.close().catch(() => {});
      await repository.cleanup();
    }
  },
  120_000,
);
