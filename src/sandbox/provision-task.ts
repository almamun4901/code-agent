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
