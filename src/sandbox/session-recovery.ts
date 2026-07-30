import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { mutationRecordSchema } from "../tools/mutation-journal";

const TEMP_PREFIX = ".session-recovery.tmp-";

export const e2bSessionRecoveryStateSchema = z
  .object({
    version: z.literal(1),
    runIdentity: z.string().min(1),
    sandboxId: z.string().min(1),
    serverPid: z.number().int().positive().nullable(),
    remoteRepoPath: z.string().startsWith("/"),
    baseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    activeMutation: mutationRecordSchema.nullable(),
  })
  .strict();

export type E2bSessionRecoveryState = z.infer<
  typeof e2bSessionRecoveryStateSchema
>;

export type E2bSessionRecoveryStore = {
  load(): Promise<E2bSessionRecoveryState | null>;
  save(state: E2bSessionRecoveryState): Promise<void>;
  clear(): Promise<void>;
};

export class E2bSessionRecoveryError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "E2bSessionRecoveryError";
  }
}

export class MemoryE2bSessionRecoveryStore
  implements E2bSessionRecoveryStore
{
  #state: E2bSessionRecoveryState | null = null;

  async load(): Promise<E2bSessionRecoveryState | null> {
    return structuredClone(this.#state);
  }

  async save(state: E2bSessionRecoveryState): Promise<void> {
    this.#state = structuredClone(e2bSessionRecoveryStateSchema.parse(state));
  }

  async clear(): Promise<void> {
    this.#state = null;
  }
}

export class FileE2bSessionRecoveryStore implements E2bSessionRecoveryStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<E2bSessionRecoveryState | null> {
    let serialized: string;
    try {
      serialized = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingError(error)) return null;
      throw new E2bSessionRecoveryError(
        `Could not read E2B session recovery state "${this.path}".`,
        { cause: error },
      );
    }
    try {
      return e2bSessionRecoveryStateSchema.parse(JSON.parse(serialized));
    } catch (error) {
      throw new E2bSessionRecoveryError(
        `E2B session recovery state "${this.path}" is invalid.`,
        { cause: error },
      );
    }
  }

  async save(state: E2bSessionRecoveryState): Promise<void> {
    const validated = e2bSessionRecoveryStateSchema.parse(state);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${directory}/${TEMP_PREFIX}${process.pid}-${crypto.randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.path);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
      throw new E2bSessionRecoveryError(
        `Could not atomically save E2B session recovery state "${this.path}".`,
        { cause: error },
      );
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if (!isMissingError(error)) {
        throw new E2bSessionRecoveryError(
          `Could not clear E2B session recovery state "${this.path}".`,
          { cause: error },
        );
      }
    }
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
