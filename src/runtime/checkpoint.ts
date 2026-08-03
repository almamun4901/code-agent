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
  DEFAULT_BUDGET_LIMITS,
  LegacyProductionAgentStateSchema,
  PreApprovalProductionAgentStateSchema,
  ProductionAgentStateSchema,
  type ProductionAgentState,
} from "./schema";
import {
  createInitialApprovalState,
  createLegacyTerminalApprovalState,
} from "./approval";

const STATE_FILE = "state.json";
const TEMP_PREFIX = ".state.json.tmp-";
export const MAX_STATE_BYTES = 2 * 1024 * 1024;

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

export class ProductionCheckpointBudgetError extends ProductionCheckpointError {
  constructor() {
    super("Checkpoint exceeded its durable byte budget; a replay-safe terminal checkpoint was saved.");
    this.name = "ProductionCheckpointBudgetError";
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
      return decodeProductionCheckpoint(JSON.parse(serialized));
    } catch (error) {
      if (error instanceof ProductionCheckpointError) throw error;
      throw new ProductionCheckpointError(
        `Checkpoint "${this.statePath}" is corrupt or incompatible with the production runner.`,
        { cause: error },
      );
    }
  }

  async save(state: ProductionAgentState): Promise<void> {
    const bounded = boundedCheckpoint(ProductionAgentStateSchema.parse(state));
    const validated = bounded.state;
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
    if (bounded.usedFallback) throw new ProductionCheckpointBudgetError();
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
    const bounded = boundedCheckpoint(
      ProductionAgentStateSchema.parse(structuredClone(state)),
    );
    this.#state = bounded.state;
    if (bounded.usedFallback) throw new ProductionCheckpointBudgetError();
  }
}

export function productionCheckpointBytes(state: ProductionAgentState): number {
  return new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`).byteLength;
}

function boundedCheckpoint(state: ProductionAgentState): {
  state: ProductionAgentState;
  usedFallback: boolean;
} {
  if (productionCheckpointBytes(state) <= state.limits.maxCheckpointBytes) {
    return { state, usedFallback: false };
  }
  const first = state.transcript[0];
  const canonical = first?.role === "user" && typeof first.content === "string"
    ? first
    : { role: "user" as const, content: `Complete the following repository task:\n${state.task}` };
  const fallback: ProductionAgentState = {
    ...state,
    promptStatus: "accepted",
    lifecycle: "failed",
    transcript: [canonical, { role: "user", content: "Checkpoint transcript omitted after exceeding the durable 2 MiB budget." }],
    pendingTurn: null,
    pendingModelCall: null,
    terminalCode: "CHECKPOINT_BUDGET_EXCEEDED",
    terminalError: "Checkpoint exceeded the durable 2 MiB budget; replayable staged payloads were removed.",
    lastNotification: {
      code: "CHECKPOINT_BUDGET_EXCEEDED",
      message: "Checkpoint transcript was omitted after exceeding its durable byte budget.",
    },
  };
  const validated = ProductionAgentStateSchema.parse(fallback);
  if (productionCheckpointBytes(validated) > state.limits.maxCheckpointBytes) {
    throw new ProductionCheckpointError("Bounded terminal checkpoint still exceeds its configured byte limit.");
  }
  return { state: validated, usedFallback: true };
}

export function decodeProductionCheckpoint(value: unknown): ProductionAgentState {
  const current = ProductionAgentStateSchema.safeParse(value);
  if (current.success) return current.data;
  const preApproval = PreApprovalProductionAgentStateSchema.safeParse(value);
  if (preApproval.success) {
    const state = preApproval.data;
    if (state.lifecycle === "running" && (
      state.counters.modelCalls !== 0 ||
      state.counters.committedTurns !== 0 ||
      state.counters.toolCalls !== 0 ||
      state.plan.length !== 0 ||
      state.pendingTurn !== null ||
      state.pendingModelCall !== null
    )) {
      throw new ProductionCheckpointError(
        "APPROVAL_MIGRATION_REQUIRED: active checkpoint already contains execution history and cannot be treated as approved; start a fresh task or migrate it explicitly.",
      );
    }
    return ProductionAgentStateSchema.parse({
      ...state,
      approval: state.lifecycle === "running"
        ? createInitialApprovalState()
        : createLegacyTerminalApprovalState(),
    });
  }
  const legacy = LegacyProductionAgentStateSchema.safeParse(value);
  if (!legacy.success) throw current.error;
  if (
    legacy.data.counters.modelTurns !== 0 ||
    legacy.data.plan.length !== 0 ||
    legacy.data.pendingTurn !== null ||
    legacy.data.lifecycle !== "running"
  ) {
    throw new ProductionCheckpointError(
      "Checkpoint v2 contains model history whose pricing cannot be reconstructed; start a fresh task or migrate it explicitly.",
    );
  }
  return ProductionAgentStateSchema.parse({
    ...legacy.data,
    version: 3,
    approval: createInitialApprovalState(),
    promptStatus: "accepted",
    appendedPromptContext: "",
    pendingModelCall: null,
    limits: { ...DEFAULT_BUDGET_LIMITS },
    pricing: {
      catalogVersion: 1,
      identity: { provider: "anthropic", model: "claude-haiku-4-5" },
      inputRateMicroUsdPerMillion: 1_000_000,
      outputRateMicroUsdPerMillion: 5_000_000,
    },
    context: { lastEstimateTokens: 0, estimateSource: null, requestFingerprint: null },
    cost: { projectedMicroUsd: 0, observedMicroUsd: 0, observedAvailable: false, driftMicroUsd: 0 },
    compaction: { count: 0, lastPreTokens: 0, lastPostTokens: 0, baselineCommittedTurns: 0, baselineProtocolRetries: 0, baselineToolCalls: 0, baselinePlanRewrites: 0, baselineStopRejections: 0 },
    notificationKeys: [],
    lastNotification: null,
    counters: {
      ...legacy.data.counters,
      modelCalls: 0,
      agentCalls: 0,
      compactionCalls: 0,
      stopRejections: 0,
    },
    terminalCode: null,
  });
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
