import type { GitInput, RawToolResult } from "./contracts";
import { ToolExecutionError } from "./errors";
import { resolveRepoChild, validateRepoPath } from "./path-utils";
import { requireSuccessfulProcess, runProcess } from "./process";

async function git(repoPath: string, args: string[]) {
  return runProcess(["git", "-c", "color.ui=false", ...args], repoPath);
}

export async function gitTool(input: GitInput): Promise<RawToolResult> {
  const repoPath = await validateRepoPath(input.repoPath);

  switch (input.subcommand) {
    case "status": {
      const result = await git(repoPath, ["status", "--porcelain=v1", "--branch"]);
      requireSuccessfulProcess("git status", result);
      const lines = result.stdout.trimEnd().split("\n");
      const branchLine = lines[0] ?? "";
      const branch = branchLine.replace(/^## /, "").split("...")[0] ?? "";
      return {
        output: result.stdout.trimEnd(),
        metadata: {
          branch,
          clean: lines.slice(1).every((line) => !line),
        },
      };
    }
    case "diff": {
      const args = ["diff", "--no-ext-diff", "--no-color"];
      if (input.staged) args.push("--cached");
      if (input.path) {
        resolveRepoChild(repoPath, input.path);
        args.push("--", input.path);
      }
      const result = await git(repoPath, args);
      requireSuccessfulProcess("git diff", result);
      return {
        output: result.stdout.trimEnd(),
        metadata: { staged: input.staged ?? false, path: input.path },
      };
    }
    case "commit": {
      if (!input.message.trim()) {
        throw new ToolExecutionError(
          "Commit message must not be empty.",
          "INVALID_COMMIT_MESSAGE",
        );
      }
      if (input.addAll) {
        const add = await git(repoPath, ["add", "-A"]);
        requireSuccessfulProcess("git add", add);
      }
      const commit = await git(repoPath, ["commit", "-m", input.message]);
      requireSuccessfulProcess("git commit", commit);
      const rev = await git(repoPath, ["rev-parse", "HEAD"]);
      requireSuccessfulProcess("git rev-parse", rev);
      const sha = rev.stdout.trim();
      return {
        output: commit.stdout.trimEnd(),
        metadata: { sha, addAll: input.addAll },
      };
    }
    case "push": {
      if (!input.remote.trim() || !input.branch.trim()) {
        throw new ToolExecutionError(
          "Push requires explicit non-empty remote and branch.",
          "INVALID_PUSH_TARGET",
        );
      }
      const result = await git(repoPath, [
        "push",
        "--",
        input.remote,
        `${input.branch}:${input.branch}`,
      ]);
      requireSuccessfulProcess("git push", result);
      return {
        output: [result.stdout, result.stderr].filter(Boolean).join("\n").trimEnd(),
        metadata: { remote: input.remote, branch: input.branch },
      };
    }
  }
}
