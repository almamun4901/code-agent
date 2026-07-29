import { createHash } from "node:crypto";
import { constants, type FileHandle } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import type { EditFileInput, RawToolResult } from "./contracts";
import { ToolExecutionError } from "./errors";
import {
  assertSafeCreationPath,
  assertWritableToolPath,
  openExistingNoFollow,
  openNewNoFollow,
  validateRepoPath,
} from "./path-utils";

const MISSING_VERSION = "missing";

function hash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function writeAll(
  handle: FileHandle,
  content: string,
): Promise<void> {
  const bytes = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (result.bytesWritten < 1) {
      throw new ToolExecutionError(
        "File write made no progress.",
        "FILE_WRITE_FAILED",
      );
    }
    offset += result.bytesWritten;
  }
}

async function readExisting(
  repoPath: string,
  childPath: string,
  writable: boolean,
): Promise<{ content: string | null; handle: FileHandle | null }> {
  try {
    const handle = await openExistingNoFollow(
      repoPath,
      childPath,
      writable ? constants.O_RDWR : constants.O_RDONLY,
    );
    try {
      return { content: await handle.readFile("utf8"), handle };
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch (error) {
    if (
      error instanceof ToolExecutionError &&
      error.code === "PATH_NOT_FOUND"
    ) {
      return { content: null, handle: null };
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
  assertWritableToolPath(input.path);
  const existing = await readExisting(
    repoPath,
    input.path,
    input.mode === "apply",
  );
  const current = existing.content;
  const baseVersion = current === null ? MISSING_VERSION : hash(current);

  try {
    if (current === null && input.oldText === null) {
      await assertSafeCreationPath(repoPath, input.path);
    }

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
      if (edit.created) {
        const handle = await openNewNoFollow(repoPath, input.path);
        try {
          await handle.writeFile(edit.next, "utf8");
        } finally {
          await handle.close();
        }
      } else {
        if (!existing.handle) {
          throw new ToolExecutionError(
            `Edit target disappeared: ${input.path}`,
            "STALE_EDIT",
          );
        }
        await existing.handle.truncate(0);
        await writeAll(existing.handle, edit.next);
      }
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
  } finally {
    await existing.handle?.close();
  }
}
