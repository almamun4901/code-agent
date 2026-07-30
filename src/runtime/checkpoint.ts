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
  ProductionAgentStateSchema,
  type ProductionAgentState,
} from "./schema";

const STATE_FILE = "state.json";
const TEMP_PREFIX = ".state.json.tmp-";
const MAX_STATE_BYTES = 2 * 1024 * 1024;

export type ProductionCheckpointStore = {
  load(): Promise<ProductionAgentState | null>;
  save(state: ProductionAgentState): Promise<void>;
};

export class ProductionCheckpointError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ProductionCheckpointError";
  }
}

export class FileProductionCheckpointStore
  implements ProductionCheckpointStore
{
  readonly agentDirectory: string;
  readonly statePath: string;

  constructor(repoPath: string) {
    this.agentDirectory = join(resolve(repoPath), ".agent");
    this.statePath = join(this.agentDirectory, STATE_FILE);
  }

  async load(): Promise<ProductionAgentState | null> {
    const exists = await this.prepareDirectory(false);
    if (!exists) return null;
    await this.removeOrphanTemps();
    await this.rejectSymlinkedStateFile();

    let serialized: string;
    try {
      serialized = await Bun.file(this.statePath)
        .slice(0, MAX_STATE_BYTES + 1)
        .text();
      if (
        new TextEncoder().encode(serialized).byteLength >
        MAX_STATE_BYTES
      ) {
        throw new ProductionCheckpointError(
          `Checkpoint exceeds the ${MAX_STATE_BYTES}-byte limit.`,
        );
      }
    } catch (error) {
      if (error instanceof ProductionCheckpointError) throw error;
      if (isMissingError(error)) return null;
      throw new ProductionCheckpointError(
        `Could not read checkpoint "${this.statePath}".`,
        { cause: error },
      );
    }

    try {
      return ProductionAgentStateSchema.parse(JSON.parse(serialized));
    } catch (error) {
      throw new ProductionCheckpointError(
        `Checkpoint "${this.statePath}" is corrupt or incompatible with the production runner.`,
        { cause: error },
      );
    }
  }

  async save(state: ProductionAgentState): Promise<void> {
    const validated = ProductionAgentStateSchema.parse(state);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    if (new TextEncoder().encode(serialized).byteLength > MAX_STATE_BYTES) {
      throw new ProductionCheckpointError(
        `Checkpoint exceeds the ${MAX_STATE_BYTES}-byte limit.`,
      );
    }
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
      await handle.writeFile(serialized);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.statePath);
      const directory = await open(this.agentDirectory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
      throw new ProductionCheckpointError(
        `Could not atomically save checkpoint "${this.statePath}".`,
        { cause: error },
      );
    }
  }

  private async prepareDirectory(create: boolean): Promise<boolean> {
    try {
      const stats = await lstat(this.agentDirectory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new ProductionCheckpointError(
          `Refusing unsafe checkpoint directory "${this.agentDirectory}".`,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof ProductionCheckpointError) throw error;
      if (!isMissingError(error)) {
        throw new ProductionCheckpointError(
          `Could not inspect checkpoint directory "${this.agentDirectory}".`,
          { cause: error },
        );
      }
      if (!create) return false;
      try {
        await mkdir(this.agentDirectory, { mode: 0o700 });
        return true;
      } catch (mkdirError) {
        throw new ProductionCheckpointError(
          `Could not create checkpoint directory "${this.agentDirectory}".`,
          { cause: mkdirError },
        );
      }
    }
  }

  private async removeOrphanTemps(): Promise<void> {
    const entries = await readdir(this.agentDirectory);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(TEMP_PREFIX))
        .map((entry) => unlink(join(this.agentDirectory, entry))),
    );
  }

  private async rejectSymlinkedStateFile(): Promise<void> {
    try {
      const stats = await lstat(this.statePath);
      if (stats.isSymbolicLink()) {
        throw new ProductionCheckpointError(
          `Refusing symlinked checkpoint "${this.statePath}".`,
        );
      }
      if (!stats.isFile() || stats.size > MAX_STATE_BYTES) {
        throw new ProductionCheckpointError(
          `Refusing checkpoint "${this.statePath}" because it is not a regular file within the ${MAX_STATE_BYTES}-byte limit.`,
        );
      }
    } catch (error) {
      if (isMissingError(error)) return;
      throw error;
    }
  }
}

export class MemoryProductionCheckpointStore
  implements ProductionCheckpointStore
{
  #state: ProductionAgentState | null;

  constructor(initial: ProductionAgentState | null = null) {
    this.#state = initial ? structuredClone(initial) : null;
  }

  async load(): Promise<ProductionAgentState | null> {
    return this.#state ? structuredClone(this.#state) : null;
  }

  async save(state: ProductionAgentState): Promise<void> {
    this.#state = ProductionAgentStateSchema.parse(structuredClone(state));
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
