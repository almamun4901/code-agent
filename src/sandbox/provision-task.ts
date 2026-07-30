import { mkdir, readFile } from "node:fs/promises";
import { z } from "zod";

const configSchema = z
  .object({
    bundlePath: z.literal("/tmp/repository.bundle"),
    taskId: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/),
    baseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  })
  .strict();

type ProvisionConfig = z.infer<typeof configSchema>;

export type ProvisionTaskInput = {
  bundlePath: string;
  taskId: string;
  baseSha: string;
};

export type ProvisionTaskLayout = {
  workspaceRoot: string;
  seedPath: string;
  tasksRoot: string;
};

export type ProvisionResult = {
  remoteRepoPath: string;
  branch: string;
  baseSha: string;
};

async function git(cwd: string, args: string[]): Promise<string> {
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
    throw new Error(
      `git ${args[0] ?? "command"} failed: ${stderr.trim() || "No diagnostic output."}`,
    );
  }
  return stdout.trim();
}

async function runFixed(command: string, args: string[]): Promise<void> {
  const process = Bun.spawn([command, ...args], {
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
    throw new Error(
      `${command} failed: ${stderr.trim() || stdout.trim() || "No diagnostic output."}`,
    );
  }
}

async function applySandboxPermissions(
  layout: ProvisionTaskLayout,
  remoteRepoPath: string,
): Promise<void> {
  const taskGroup = taskGroupForLayout(layout);
  if (!taskGroup) return;

  await runFixed("chmod", ["-R", "go-rwx", layout.seedPath]);
  await runFixed("chgrp", ["-R", taskGroup, remoteRepoPath]);
  await runFixed("chmod", ["-R", "g+rwX,o-rwx", remoteRepoPath]);
  await runFixed("find", [
    remoteRepoPath,
    "-type",
    "d",
    "-exec",
    "chmod",
    "2770",
    "{}",
    "+",
  ]);
  await runFixed("chmod", ["3770", remoteRepoPath]);
  await runFixed("chgrp", ["agent", `${remoteRepoPath}/.git`]);
  await runFixed("chmod", ["0600", `${remoteRepoPath}/.git`]);
}

export function taskGroupForLayout(
  layout: ProvisionTaskLayout,
  configuredGroup = process.env.AGENT_TASK_GROUP?.trim(),
): string | undefined {
  if (configuredGroup) return configuredGroup;
  if (
    layout.workspaceRoot === "/workspace" &&
    layout.seedPath === "/workspace/seed" &&
    layout.tasksRoot === "/workspace/tasks"
  ) {
    return "task";
  }
  return undefined;
}

export async function provisionTask(
  config: ProvisionTaskInput,
  layout: ProvisionTaskLayout = {
    workspaceRoot: "/workspace",
    seedPath: "/workspace/seed",
    tasksRoot: "/workspace/tasks",
  },
): Promise<ProvisionResult> {
  const remoteRepoPath = `${layout.tasksRoot}/${config.taskId}`;
  const branch = `task/${config.taskId}`;

  await mkdir(layout.tasksRoot, { recursive: true });
  await git(layout.workspaceRoot, [
    "clone",
    "--no-checkout",
    config.bundlePath,
    layout.seedPath,
  ]);
  await git(layout.seedPath, [
    "worktree",
    "add",
    "-b",
    branch,
    remoteRepoPath,
    config.baseSha,
  ]);
  await git(remoteRepoPath, [
    "config",
    "user.email",
    "coding-agent@example.invalid",
  ]);
  await git(remoteRepoPath, [
    "config",
    "user.name",
    "Terminal Coding Agent",
  ]);
  await applySandboxPermissions(layout, remoteRepoPath);

  const checkedOutSha = await git(remoteRepoPath, ["rev-parse", "HEAD"]);
  if (checkedOutSha !== config.baseSha) {
    throw new Error(
      `Provisioned worktree SHA mismatch: expected ${config.baseSha}, received ${checkedOutSha}.`,
    );
  }

  return {
    remoteRepoPath,
    branch,
    baseSha: checkedOutSha,
  };
}

if (import.meta.main) {
  const [configPath] = process.argv.slice(2);
  if (!configPath) {
    throw new Error("Usage: bun run provision-task.ts <config.json>");
  }
  const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const parsed = configSchema.parse(config);
  process.stdout.write(`${JSON.stringify(await provisionTask(parsed))}\n`);
}
