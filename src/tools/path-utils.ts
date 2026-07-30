import {
  constants,
  lstat,
  open,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { ToolExecutionError } from "./errors";

const RESERVED_PATH_SEGMENTS = new Set([
  ".agent",
  ".agents",
  ".codex",
  ".git",
]);
const RESERVED_ROOT_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
    ? error.code
    : undefined;
}

export async function validateRepoPath(repoPath: string): Promise<string> {
  if (!path.isAbsolute(repoPath) || repoPath.includes("\0")) {
    throw new ToolExecutionError(
      "Repository root must be an absolute path.",
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

  return realpath(repoPath);
}

export function relativePathSegments(
  childPath: string,
  options: { allowDot?: boolean } = {},
): string[] {
  if (
    !childPath ||
    childPath.includes("\0") ||
    path.isAbsolute(childPath) ||
    childPath.includes("\\")
  ) {
    throw new ToolExecutionError(
      `Path must be a non-empty repo-relative POSIX path: ${JSON.stringify(childPath)}`,
      "INVALID_PATH",
    );
  }
  if (childPath === "." && options.allowDot) return [];

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
  return segments;
}

export function assertWritableToolPath(childPath: string): void {
  const segments = relativePathSegments(childPath);
  const reservedSegment = segments.find((segment) =>
    RESERVED_PATH_SEGMENTS.has(segment)
  );
  if (
    reservedSegment ||
    (segments.length === 1 && RESERVED_ROOT_FILES.has(segments[0] ?? ""))
  ) {
    throw new ToolExecutionError(
      `Writes to agent or repository control paths are forbidden: ${childPath}`,
      "PROTECTED_PATH",
    );
  }
}

function assertReadableToolPath(childPath: string): void {
  const segments = relativePathSegments(childPath, { allowDot: true });
  if (segments.some((segment) => RESERVED_PATH_SEGMENTS.has(segment))) {
    throw new ToolExecutionError(
      `Access to agent or repository control paths is forbidden: ${childPath}`,
      "PROTECTED_PATH",
    );
  }
}

export function resolveRepoChild(
  repoPath: string,
  childPath: string,
  options: { allowDot?: boolean } = {},
): string {
  const segments = relativePathSegments(childPath, options);
  return path.resolve(repoPath, ...segments);
}

async function inspectComponents(
  repoPath: string,
  childPath: string,
  options: { allowDot?: boolean; allowMissingFinal?: boolean } = {},
): Promise<{ filePath: string; exists: boolean }> {
  const segments = relativePathSegments(childPath, options);
  let current = repoPath;

  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new ToolExecutionError(
          `Symbolic links are not allowed in tool paths: ${childPath}`,
          "SYMLINK_PATH",
        );
      }
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw new ToolExecutionError(
          `Path parent is not a directory: ${childPath}`,
          "INVALID_PATH",
        );
      }
    } catch (error) {
      if (
        errorCode(error) === "ENOENT" &&
        options.allowMissingFinal &&
        index === segments.length - 1
      ) {
        return { filePath: current, exists: false };
      }
      if (error instanceof ToolExecutionError) throw error;
      throw new ToolExecutionError(
        `Path does not exist: ${childPath}`,
        "PATH_NOT_FOUND",
      );
    }
  }

  return { filePath: current, exists: true };
}

export async function assertSafeExistingPath(
  repoPath: string,
  childPath: string,
  options: { allowDot?: boolean } = {},
): Promise<string> {
  assertReadableToolPath(childPath);
  const inspected = await inspectComponents(repoPath, childPath, options);
  return inspected.filePath;
}

export async function assertSafeCreationPath(
  repoPath: string,
  childPath: string,
): Promise<string> {
  const inspected = await inspectComponents(repoPath, childPath, {
    allowMissingFinal: true,
  });
  if (inspected.exists) {
    throw new ToolExecutionError(
      `Creation target already exists: ${childPath}`,
      "CREATE_TARGET_EXISTS",
    );
  }
  return inspected.filePath;
}

export async function openExistingNoFollow(
  repoPath: string,
  childPath: string,
  flags = constants.O_RDONLY,
): Promise<FileHandle> {
  const filePath = await assertSafeExistingPath(repoPath, childPath);
  try {
    return await open(filePath, flags | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new ToolExecutionError(
        `Symbolic links are not allowed in tool paths: ${childPath}`,
        "SYMLINK_PATH",
      );
    }
    throw error;
  }
}

export async function openNewNoFollow(
  repoPath: string,
  childPath: string,
): Promise<FileHandle> {
  const filePath = await assertSafeCreationPath(repoPath, childPath);
  return open(
    filePath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o660,
  );
}
