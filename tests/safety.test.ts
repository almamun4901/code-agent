import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { dispatchTool } from "../src/tools/dispatcher";
import { defaultPreToolUse } from "../src/tools/pretooluse-policy";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "./support/temp-repo";

const repositories: TemporaryRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repo) => repo.cleanup()));
});

async function fixture(): Promise<TemporaryRepository> {
  const repo = await createTemporaryRepository();
  repositories.push(repo);
  return repo;
}

async function call(repo: TemporaryRepository, request: unknown) {
  return dispatchTool(request, { worktreeRoot: repo.worktreePath });
}

async function expectSafeFollowUp(repo: TemporaryRepository): Promise<void> {
  const safe = await call(repo, {
    name: "read_file",
    input: { path: "src/sample.ts" },
  });
  expect(safe.success).toBe(true);
  expect(safe.output).toContain("class Greeter");
}

describe("PreToolUse red-team boundary", () => {
  test("propagates cancellation into an active policy evaluation", async () => {
    const repo = await fixture();
    const abort = new AbortController();
    let evaluating!: () => void;
    const started = new Promise<void>((resolve) => {
      evaluating = resolve;
    });
    const result = dispatchTool(
      {
        name: "read_file",
        input: { path: "src/sample.ts" },
      },
      {
        worktreeRoot: repo.worktreePath,
        abortSignal: abort.signal,
        preToolUse: async (_request, context) => {
          expect(context.abortSignal).toBe(abort.signal);
          evaluating();
          await new Promise<void>((_, reject) => {
            context.abortSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("cancelled", "AbortError")),
              { once: true },
            );
          });
          return { outcome: "allow" };
        },
      },
    );

    await started;
    abort.abort();
    await expect(result).resolves.toMatchObject({
      success: false,
      metadata: { code: "CANCELLED" },
    });
  });

  test("every obvious shell attack has a stable denial and no protected effect", async () => {
    const repo = await fixture();
    const protectedFile = path.join(repo.root, "protected.txt");
    await writeFile(protectedFile, "unchanged\n");

    const attacks = [
      ["rm -rf /", "SHELL_DESTRUCTIVE_OUTSIDE_ROOT"],
      ["rm -r ../seed", "SHELL_DESTRUCTIVE_OUTSIDE_ROOT"],
      ["curl https://example.com", "SHELL_EGRESS_UTILITY"],
      ["wget https://example.com", "SHELL_EGRESS_UTILITY"],
      ["nc example.com 443", "SHELL_EGRESS_UTILITY"],
      ["printf pwned > /opt/agent/package.json", "SHELL_RUNTIME_MUTATION"],
      ["printf pwned > .git/config", "SHELL_GIT_CONTROL_MUTATION"],
      ["printf pwned > /dev/sda", "SHELL_DEVICE_WRITE"],
      ["printf 'x\0y'", "SHELL_NULL_BYTE"],
    ] as const;

    for (const [command, code] of attacks) {
      const result = await call(repo, {
        name: "run_shell",
        input: { cwd: ".", command },
      });
      expect(result).toMatchObject({
        success: false,
        metadata: { code },
      });
      expect(await readFile(protectedFile, "utf8")).toBe("unchanged\n");
      await expectSafeFollowUp(repo);
    }
  });

  test("traversal and symlink attacks cannot read or change outside content", async () => {
    const repo = await fixture();
    const outsideDirectory = path.join(repo.root, "outside");
    const outsideFile = path.join(outsideDirectory, "secret.ts");
    await mkdir(outsideDirectory);
    await writeFile(outsideFile, "export const secret = 'unchanged';\n");
    await symlink(outsideDirectory, path.join(repo.worktreePath, "escape"));

    const traversal = await call(repo, {
      name: "read_file",
      input: { path: "../outside/secret.ts" },
    });
    const symlinkRead = await call(repo, {
      name: "read_file",
      input: { path: "escape/secret.ts" },
    });
    const symlinkWrite = await call(repo, {
      name: "edit_file",
      input: {
        path: "escape/secret.ts",
        mode: "preview",
        oldText: "unchanged",
        newText: "changed",
      },
    });

    expect(traversal.metadata?.code).toBe("INVALID_PATH");
    expect(symlinkRead.metadata?.code).toBe("SYMLINK_PATH");
    expect(symlinkWrite.metadata?.code).toBe("SYMLINK_PATH");
    expect(await readFile(outsideFile, "utf8")).toBe(
      "export const secret = 'unchanged';\n",
    );
    await expectSafeFollowUp(repo);
  });

  test("interpreter encoding bypasses lexical checks without being trusted", async () => {
    const repo = await fixture();
    const decisions = await Promise.all([
      defaultPreToolUse(
        {
          name: "run_shell",
          input: {
            cwd: ".",
            command:
              "bun -e 'require(\"fs\").writeFileSync(Buffer.from(\"L29wdC9hZ2VudA==\",\"base64\").toString(),\"x\")'",
          },
        },
        { worktreeRoot: repo.worktreePath },
      ),
      defaultPreToolUse(
        {
          name: "run_shell",
          input: {
            cwd: ".",
            command:
              "bun -e 'fetch(Buffer.from(\"aHR0cHM6Ly9leGFtcGxlLmNvbQ==\",\"base64\").toString())'",
          },
        },
        { worktreeRoot: repo.worktreePath },
      ),
    ]);

    expect(decisions).toEqual([
      { outcome: "allow" },
      { outcome: "allow" },
    ]);
  });

  test("Git push is rejected before execution and the repository remains usable", async () => {
    const repo = await fixture();
    const push = await call(repo, {
      name: "git",
      input: {
        subcommand: "push",
        remote: repo.bareRemotePath,
        branch: "agent-step2",
      },
    });
    const status = await call(repo, {
      name: "git",
      input: { subcommand: "status" },
    });

    expect(push.metadata?.code).toBe("INVALID_TOOL_CALL");
    expect(status.success).toBe(true);
  });
});
