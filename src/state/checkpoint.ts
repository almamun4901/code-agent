import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import {
  AgentStateV1Schema,
  type AgentStateV1,
} from "../plan/schema";

const STATE_FILE = "state.json";
const TEMP_PREFIX = ".state.json.tmp-";

export type StartupPolicy = "auto" | "required" | "fresh";

export interface CheckpointStore {
  load(): Promise<AgentStateV1 | null>;
  save(state: AgentStateV1): Promise<void>;
}

export type FileCheckpointStoreOptions = {
  beforeRename?: () => Promise<void>;
};

export class InvalidCheckpointStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidCheckpointStateError";
  }
}

export class UnsupportedCheckpointVersionError extends Error {
  constructor(version: unknown) {
    super(
      `Checkpoint version "${String(version)}" is unsupported; expected version 1. Preserve the state file and use a compatible agent version.`,
    );
    this.name = "UnsupportedCheckpointVersionError";
  }
}

export class IncompatibleCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleCheckpointError";
  }
}

export class UnsafeCheckpointPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeCheckpointPathError";
  }
}

export class CheckpointIoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CheckpointIoError";
  }
}

export class MissingCheckpointError extends Error {
  constructor(path: string) {
    super(`A checkpoint is required, but none exists at "${path}".`);
    this.name = "MissingCheckpointError";
  }
}

export class FileCheckpointStore implements CheckpointStore {
  readonly agentDirectory: string;
  readonly statePath: string;
  private readonly options: FileCheckpointStoreOptions;

  constructor(
    repoPath: string,
    options: FileCheckpointStoreOptions = {},
  ) {
    const resolvedRepo = resolve(repoPath);
    this.agentDirectory = join(resolvedRepo, ".agent");
    this.statePath = join(this.agentDirectory, STATE_FILE);
    this.options = options;
  }

  async load(): Promise<AgentStateV1 | null> {
    const exists = await this.prepareDirectory(false);
    if (!exists) return null;

    await this.removeOrphanTemps();
    await this.rejectSymlinkedStateFile();

    let serialized: string;
    try {
      serialized = await Bun.file(this.statePath).text();
    } catch (error) {
      if (isMissingError(error)) return null;
      throw new CheckpointIoError(
        `Could not read checkpoint "${this.statePath}".`,
        { cause: error },
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch (error) {
      throw new InvalidCheckpointStateError(
        `Checkpoint "${this.statePath}" is not valid JSON. Preserve it for diagnosis or explicitly start fresh.`,
        { cause: error },
      );
    }

    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      value.version !== 1
    ) {
      throw new UnsupportedCheckpointVersionError(value.version);
    }

    const parsed = AgentStateV1Schema.safeParse(value);
    if (!parsed.success) {
      throw new InvalidCheckpointStateError(
        `Checkpoint "${this.statePath}" failed validation: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
      );
    }

    return parsed.data;
  }

  async save(state: AgentStateV1): Promise<void> {
    const validated = AgentStateV1Schema.parse(state);
    await this.prepareDirectory(true);
    await this.removeOrphanTemps();

    const tempPath = join(
      this.agentDirectory,
      `${TEMP_PREFIX}${process.pid}-${crypto.randomUUID()}`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      handle = await open(
        tempPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(tempPath, 0o600);
      await this.options.beforeRename?.();
      await rename(tempPath, this.statePath);

      const directoryHandle = await open(
        this.agentDirectory,
        constants.O_RDONLY,
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
      }
      await unlink(tempPath).catch(() => {});
      if (error instanceof UnsafeCheckpointPathError) throw error;
      throw new CheckpointIoError(
        `Could not atomically save checkpoint "${this.statePath}".`,
        { cause: error },
      );
    }
  }

  private async prepareDirectory(create: boolean): Promise<boolean> {
    try {
      const stats = await lstat(this.agentDirectory);
      if (stats.isSymbolicLink()) {
        throw new UnsafeCheckpointPathError(
          `Refusing checkpoint path "${this.agentDirectory}" because .agent is a symbolic link.`,
        );
      }
      if (!stats.isDirectory()) {
        throw new UnsafeCheckpointPathError(
          `Refusing checkpoint path "${this.agentDirectory}" because .agent is not a directory.`,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof UnsafeCheckpointPathError) throw error;
      if (!isMissingError(error)) {
        throw new CheckpointIoError(
          `Could not inspect checkpoint directory "${this.agentDirectory}".`,
          { cause: error },
        );
      }
      if (!create) return false;
      try {
        await mkdir(this.agentDirectory, { recursive: false, mode: 0o700 });
        return true;
      } catch (mkdirError) {
        throw new CheckpointIoError(
          `Could not create checkpoint directory "${this.agentDirectory}".`,
          { cause: mkdirError },
        );
      }
    }
  }

  private async removeOrphanTemps(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.agentDirectory);
    } catch (error) {
      throw new CheckpointIoError(
        `Could not inspect checkpoint directory "${this.agentDirectory}".`,
        { cause: error },
      );
    }

    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(TEMP_PREFIX))
        .map(async (entry) => {
          try {
            await unlink(join(this.agentDirectory, entry));
          } catch (error) {
            if (!isMissingError(error)) {
              throw new CheckpointIoError(
                `Could not remove orphan checkpoint temporary file "${entry}".`,
                { cause: error },
              );
            }
          }
        }),
    );
  }

  private async rejectSymlinkedStateFile(): Promise<void> {
    try {
      const stats = await lstat(this.statePath);
      if (stats.isSymbolicLink()) {
        throw new UnsafeCheckpointPathError(
          `Refusing checkpoint path "${this.statePath}" because state.json is a symbolic link.`,
        );
      }
    } catch (error) {
      if (
        error instanceof UnsafeCheckpointPathError ||
        isMissingError(error)
      ) {
        if (isMissingError(error)) return;
        throw error;
      }
      throw new CheckpointIoError(
        `Could not inspect checkpoint "${this.statePath}".`,
        { cause: error },
      );
    }
  }
}

export class MemoryCheckpointStore implements CheckpointStore {
  private state: AgentStateV1 | null;

  constructor(initialState: AgentStateV1 | null = null) {
    this.state = initialState ? structuredClone(initialState) : null;
  }

  async load(): Promise<AgentStateV1 | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: AgentStateV1): Promise<void> {
    this.state = AgentStateV1Schema.parse(structuredClone(state));
  }
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
