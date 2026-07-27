import { stat } from "node:fs/promises";
import path from "node:path";
import { ToolExecutionError } from "./errors";

export async function validateRepoPath(repoPath: string): Promise<string> {
  if (!path.isAbsolute(repoPath)) {
    throw new ToolExecutionError(
      "repoPath must be an absolute path.",
      "INVALID_REPO_PATH",
    );
  }

  let info;
  try {
    info = await stat(repoPath);
  } catch {
    throw new ToolExecutionError(
      `Repository path does not exist: ${repoPath}`,
      "REPO_NOT_FOUND",
    );
  }

  if (!info.isDirectory()) {
    throw new ToolExecutionError(
      `Repository path is not a directory: ${repoPath}`,
      "INVALID_REPO_PATH",
    );
  }

  return path.resolve(repoPath);
}

export function resolveRepoChild(
  repoPath: string,
  childPath: string,
  options: { allowDot?: boolean } = {},
): string {
  if (
    !childPath ||
    path.isAbsolute(childPath) ||
    childPath.includes("\\")
  ) {
    throw new ToolExecutionError(
      `Path must be a non-empty repo-relative POSIX path: ${JSON.stringify(childPath)}`,
      "INVALID_PATH",
    );
  }

  if (childPath === "." && options.allowDot) {
    return path.resolve(repoPath);
  }

  const segments = childPath.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new ToolExecutionError(
      `Path contains an empty, current-directory, or traversal segment: ${childPath}`,
      "INVALID_PATH",
    );
  }

  return path.resolve(repoPath, ...segments);
}

export function assertInsideDevelopmentRoot(
  repoPath: string,
  developmentRoot: string | undefined,
): void {
  if (!developmentRoot) return;

  const root = path.resolve(developmentRoot);
  const repo = path.resolve(repoPath);
  const relative = path.relative(root, repo);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }

  throw new ToolExecutionError(
    `Repository path is outside the disposable development root: ${repoPath}`,
    "OUTSIDE_DEVELOPMENT_ROOT",
  );
}
