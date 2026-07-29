import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class RepositoryBundleError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "RepositoryBundleError";
  }
}

type GitResult = {
  stdout: string;
  stderr: string;
};

async function git(
  repositoryPath: string,
  args: string[],
): Promise<GitResult> {
  const process = Bun.spawn(["git", ...args], {
    cwd: repositoryPath,
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
    throw new RepositoryBundleError(
      `git ${args[0] ?? "command"} failed: ${stderr.trim() || "No diagnostic output."}`,
    );
  }
  return { stdout, stderr };
}

export type RepositoryBundle = {
  repositoryPath: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  bundlePath: string;
  cleanup(): Promise<void>;
};

export async function createRepositoryBundle(
  localRepoPath: string,
  baseRef = "HEAD",
): Promise<RepositoryBundle> {
  if (!path.isAbsolute(localRepoPath)) {
    throw new RepositoryBundleError(
      "localRepoPath must be an absolute path.",
    );
  }
  if (!baseRef.trim() || baseRef.startsWith("-")) {
    throw new RepositoryBundleError(
      "baseRef must be a non-empty Git revision and must not start with '-'.",
    );
  }

  let repositoryPath: string;
  try {
    const info = await stat(localRepoPath);
    if (!info.isDirectory()) {
      throw new RepositoryBundleError(
        "localRepoPath must identify a directory.",
      );
    }
    repositoryPath = await realpath(localRepoPath);
  } catch (error) {
    if (error instanceof RepositoryBundleError) throw error;
    throw new RepositoryBundleError(
      `Repository path does not exist: ${localRepoPath}`,
      { cause: error },
    );
  }

  const topLevel = (
    await git(repositoryPath, ["rev-parse", "--show-toplevel"])
  ).stdout.trim();
  if ((await realpath(topLevel)) !== repositoryPath) {
    throw new RepositoryBundleError(
      "localRepoPath must be the root of its Git repository.",
    );
  }

  let branch: string;
  try {
    branch = (
      await git(repositoryPath, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ])
    ).stdout.trim();
  } catch (error) {
    throw new RepositoryBundleError(
      "Repository HEAD must be attached to a branch.",
      { cause: error },
    );
  }

  const status = (
    await git(repositoryPath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ])
  ).stdout;
  if (status.trim()) {
    throw new RepositoryBundleError(
      "Repository must be clean, including untracked files, before bundling.",
    );
  }

  let baseSha: string;
  try {
    baseSha = (
      await git(repositoryPath, [
        "rev-parse",
        "--verify",
        `${baseRef}^{commit}`,
      ])
    ).stdout.trim();
  } catch (error) {
    throw new RepositoryBundleError(`Unknown baseRef: ${baseRef}`, {
      cause: error,
    });
  }

  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "coding-agent-e2b-bundle-"),
  );
  const bundlePath = path.join(temporaryRoot, "repository.bundle");
  let cleaned = false;

  try {
    await git(repositoryPath, [
      "bundle",
      "create",
      bundlePath,
      baseRef,
    ]);
    await git(repositoryPath, ["bundle", "verify", bundlePath]);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    repositoryPath,
    branch,
    baseRef,
    baseSha,
    bundlePath,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}
