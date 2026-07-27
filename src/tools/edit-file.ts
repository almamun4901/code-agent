import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import type { EditFileInput, RawToolResult } from "./contracts";
import { ToolExecutionError } from "./errors";
import { resolveRepoChild, validateRepoPath } from "./path-utils";

const MISSING_VERSION = "missing";

function hash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function buildEdit(
  current: string | null,
  input: EditFileInput,
): { next: string; matchCount: number; created: boolean } {
  if (input.oldText === null) {
    if (current !== null) {
      throw new ToolExecutionError(
        `Creation target already exists: ${input.path}`,
        "CREATE_TARGET_EXISTS",
      );
    }
    return { next: input.newText, matchCount: 0, created: true };
  }

  if (current === null) {
    throw new ToolExecutionError(
      `Edit target does not exist: ${input.path}`,
      "EDIT_TARGET_MISSING",
    );
  }
  if (input.oldText === input.newText) {
    throw new ToolExecutionError("Edit would make no change.", "NO_OP_EDIT");
  }
  if (input.oldText.length === 0) {
    throw new ToolExecutionError(
      "oldText must be non-empty for replacement edits.",
      "INVALID_EDIT",
    );
  }

  const matchCount = current.split(input.oldText).length - 1;
  if (input.replaceAll) {
    if (matchCount === 0) {
      throw new ToolExecutionError("oldText was not found.", "NO_EDIT_MATCH");
    }
    return {
      next: current.split(input.oldText).join(input.newText),
      matchCount,
      created: false,
    };
  }

  if (matchCount !== 1) {
    throw new ToolExecutionError(
      `Expected exactly one match, found ${matchCount}.`,
      matchCount === 0 ? "NO_EDIT_MATCH" : "AMBIGUOUS_EDIT",
    );
  }

  return {
    next: current.replace(input.oldText, input.newText),
    matchCount,
    created: false,
  };
}

export async function editFileTool(input: EditFileInput): Promise<RawToolResult> {
  const repoPath = await validateRepoPath(input.repoPath);
  const filePath = resolveRepoChild(repoPath, input.path);
  const current = await readExisting(filePath);
  const baseVersion = current === null ? MISSING_VERSION : hash(current);

  if (input.mode === "apply") {
    if (!input.baseVersion) {
      throw new ToolExecutionError(
        "apply mode requires the baseVersion returned by preview.",
        "MISSING_BASE_VERSION",
      );
    }
    if (input.baseVersion !== baseVersion) {
      throw new ToolExecutionError(
        `Stale edit: expected ${input.baseVersion}, current version is ${baseVersion}.`,
        "STALE_EDIT",
      );
    }
  }

  const edit = buildEdit(current, input);
  const proposedVersion = hash(edit.next);
  const diff = createTwoFilesPatch(
    `a/${input.path}`,
    `b/${input.path}`,
    current ?? "",
    edit.next,
    baseVersion,
    proposedVersion,
  );

  if (input.mode === "apply") {
    await writeFile(filePath, edit.next, edit.created ? { flag: "wx" } : undefined);
  }

  return {
    output: diff,
    metadata: {
      path: input.path,
      mode: input.mode,
      baseVersion,
      proposedVersion,
      matchCount: edit.matchCount,
      created: edit.created,
      applied: input.mode === "apply",
    },
  };
}
