import { readFile } from "node:fs/promises";
import type { RawToolResult, ReadFileInput } from "./contracts";
import { ToolExecutionError } from "./errors";
import { resolveRepoChild, validateRepoPath } from "./path-utils";

export async function readFileTool(input: ReadFileInput): Promise<RawToolResult> {
  const repoPath = await validateRepoPath(input.repoPath);
  const filePath = resolveRepoChild(repoPath, input.path);
  let bytes: Buffer;

  try {
    bytes = await readFile(filePath);
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    throw new ToolExecutionError(
      `File could not be read: ${input.path}`,
      code === "ENOENT"
        ? "FILE_NOT_FOUND"
        : code === "EACCES" || code === "EPERM"
          ? "FILE_UNREADABLE"
          : "FILE_READ_FAILED",
    );
  }

  if (bytes.includes(0)) {
    throw new ToolExecutionError(
      `Binary files are not supported: ${input.path}`,
      "BINARY_FILE",
    );
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ToolExecutionError(
      `File is not valid UTF-8: ${input.path}`,
      "INVALID_UTF8",
    );
  }

  const lines = content.split("\n");
  const start = input.startLine ?? 1;
  const end = input.endLine ?? lines.length;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    start > lines.length ||
    end > lines.length
  ) {
    throw new ToolExecutionError(
      `Invalid inclusive line range ${start}-${end} for ${lines.length} lines.`,
      "INVALID_LINE_RANGE",
    );
  }

  const output = lines
    .slice(start - 1, end)
    .map((line, index) => `${start + index}: ${line}`)
    .join("\n");

  return {
    output,
    metadata: {
      path: input.path,
      startLine: start,
      endLine: end,
      totalLines: lines.length,
    },
  };
}
