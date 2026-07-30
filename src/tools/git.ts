import type { GitInput, RawToolResult } from "./contracts";
import { ToolExecutionError } from "./errors";
import { resolveRepoChild, validateRepoPath } from "./path-utils";
import { requireSuccessfulProcess, runProcess } from "./process";

const GIT_ENVIRONMENT = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/tmp/agent-git-home",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GIT_CONFIG_NOSYSTEM: "1",
};

const HARDENED_GIT_CONFIG = [
  "-c",
  "color.ui=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "credential.helper=",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "gpg.program=/bin/false",
  "-c",
  "gpg.ssh.program=/bin/false",
  "-c",
  "core.pager=cat",
];

async function git(repoPath: string, args: string[]) {
  return runProcess(
    ["/usr/bin/git", ...HARDENED_GIT_CONFIG, ...args],
    repoPath,
    { env: GIT_ENVIRONMENT },
  );
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
  }
}
