import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const MAX_RESULT_BUNDLE_BYTES = 16 * 1024 * 1024;
export const MAX_RESULT_OBJECT_BYTES = 64 * 1024 * 1024;
export const MAX_RESULT_OBJECTS = 10_000;
export const MAX_RESULT_COMMITS = 200;
export const MAX_RESULT_PATHS = 2_000;

const shaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const resultPathSchema = z.string().min(1).max(4_096);

export const ResultDeliveryReceiptSchema = z.object({
  version: z.literal(2),
  runIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  canonicalRepoPath: z.string().startsWith("/"),
  baseSha: shaSchema,
  resultSha: shaSchema,
  baseTreeSha: shaSchema,
  resultTreeSha: shaSchema,
  branch: z.string().regex(/^result\/[a-f0-9]{12}$/),
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  bundleBytes: z.number().int().positive().max(MAX_RESULT_BUNDLE_BYTES),
  changedFiles: z.array(resultPathSchema).max(MAX_RESULT_PATHS),
  diffSummary: z.object({ filesChanged: z.number().int().nonnegative(), insertions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), binaryFiles: z.number().int().nonnegative() }).strict(),
  deliveredAt: z.string().datetime(),
}).strict();

export type ResultDeliveryReceipt = z.infer<
  typeof ResultDeliveryReceiptSchema
>;

const resultDeliveryStateSchema = z.object({
  version: z.literal(2),
  status: z.enum(["exported", "validated", "imported", "completed"]),
  runIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  canonicalRepoPath: z.string().startsWith("/"),
  baseSha: shaSchema,
  resultSha: shaSchema,
  baseTreeSha: shaSchema.nullable(),
  resultTreeSha: shaSchema.nullable(),
  branch: z.string().regex(/^result\/[a-f0-9]{12}$/),
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  bundleBytes: z.number().int().positive().max(MAX_RESULT_BUNDLE_BYTES),
  changedFiles: z.array(resultPathSchema).max(MAX_RESULT_PATHS),
  diffSummary: z.object({ filesChanged: z.number().int().nonnegative(), insertions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), binaryFiles: z.number().int().nonnegative() }).strict().nullable(),
  deliveredAt: z.string().datetime().nullable(),
}).strict();

export type ResultDeliveryState = z.infer<
  typeof resultDeliveryStateSchema
>;

export type ResultDeliveryArtifact = {
  baseSha: string;
  resultSha: string;
  bundle: Uint8Array;
};

export type ResultDeliveryStore = {
  load(): Promise<ResultDeliveryState | null>;
  save(state: ResultDeliveryState): Promise<void>;
  writeBundle(bytes: Uint8Array): Promise<void>;
  readBundle(): Promise<Uint8Array>;
  removeBundle(): Promise<void>;
};

export type DeliverResultOptions = {
  canonicalRepoPath: string;
  runIdentity: string;
  artifact: ResultDeliveryArtifact;
  store: ResultDeliveryStore;
  beforeTransition?: (
    status: ResultDeliveryState["status"],
  ) => void | Promise<void>;
};

export class ResultDeliveryError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ResultDeliveryError";
  }
}

export class FileResultDeliveryStore implements ResultDeliveryStore {
  readonly directory: string;
  readonly statePath: string;
  readonly bundlePath: string;

  constructor(repositoryPath: string) {
    this.directory = path.join(repositoryPath, ".agent");
    this.statePath = path.join(this.directory, "result-delivery.json");
    this.bundlePath = path.join(this.directory, "result-delivery.bundle");
  }

  async load(): Promise<ResultDeliveryState | null> {
    await this.#prepareDirectory(false);
    await this.#rejectSymlink(this.statePath);
    try {
      return resultDeliveryStateSchema.parse(
        JSON.parse(await readFile(this.statePath, "utf8")),
      );
    } catch (error) {
      if (isMissingError(error)) return null;
      throw new ResultDeliveryError(
        `Result delivery state "${this.statePath}" is invalid.`,
        { cause: error },
      );
    }
  }

  async save(state: ResultDeliveryState): Promise<void> {
    const validated = resultDeliveryStateSchema.parse(state);
    await this.#prepareDirectory(true);
    await this.#atomicWrite(
      this.statePath,
      new TextEncoder().encode(`${JSON.stringify(validated, null, 2)}\n`),
    );
  }

  async writeBundle(bytes: Uint8Array): Promise<void> {
    await this.#prepareDirectory(true);
    await this.#atomicWrite(this.bundlePath, bytes);
  }

  async readBundle(): Promise<Uint8Array> {
    await this.#prepareDirectory(false);
    await this.#rejectSymlink(this.bundlePath);
    try {
      return new Uint8Array(await readFile(this.bundlePath));
    } catch (error) {
      throw new ResultDeliveryError(
        "The staged result bundle is unavailable for recovery.",
        { cause: error },
      );
    }
  }

  async removeBundle(): Promise<void> {
    await this.#rejectSymlink(this.bundlePath);
    await unlink(this.bundlePath).catch((error) => {
      if (!isMissingError(error)) throw error;
    });
  }

  async #prepareDirectory(create: boolean): Promise<void> {
    try {
      const info = await lstat(this.directory);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ResultDeliveryError(
          "Refusing an unsafe .agent result delivery directory.",
        );
      }
    } catch (error) {
      if (!isMissingError(error)) throw error;
      if (!create) return;
      await mkdir(this.directory, { mode: 0o700 });
    }
    await chmod(this.directory, 0o700);
  }

  async #rejectSymlink(target: string): Promise<void> {
    try {
      if ((await lstat(target)).isSymbolicLink()) {
        throw new ResultDeliveryError(
          `Refusing symbolic-link delivery path "${target}".`,
        );
      }
    } catch (error) {
      if (!isMissingError(error)) throw error;
    }
  }

  async #atomicWrite(target: string, bytes: Uint8Array): Promise<void> {
    await this.#rejectSymlink(target);
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw new ResultDeliveryError(
        `Could not persist result delivery artifact "${target}".`,
        { cause: error },
      );
    }
  }
}

export class MemoryResultDeliveryStore implements ResultDeliveryStore {
  state: ResultDeliveryState | null = null;
  bundle: Uint8Array | null = null;

  async load(): Promise<ResultDeliveryState | null> {
    return this.state ? structuredClone(this.state) : null;
  }
  async save(state: ResultDeliveryState): Promise<void> {
    this.state = structuredClone(resultDeliveryStateSchema.parse(state));
  }
  async writeBundle(bytes: Uint8Array): Promise<void> {
    this.bundle = bytes.slice();
  }
  async readBundle(): Promise<Uint8Array> {
    if (!this.bundle) throw new ResultDeliveryError("Missing memory bundle.");
    return this.bundle.slice();
  }
  async removeBundle(): Promise<void> {
    this.bundle = null;
  }
}

export async function deliverResult(
  options: DeliverResultOptions,
): Promise<ResultDeliveryReceipt> {
  const branch = `result/${options.runIdentity.slice(0, 12)}`;
  let state = await options.store.load();
  if (state) {
    assertSameDelivery(state, options, branch);
    if (state.status === "completed") {
      await options.store.removeBundle();
      return receiptFromState(state);
    }
  } else {
    validateArtifactEnvelope(options.artifact);
    const bundleSha256 = await sha256(options.artifact.bundle);
    await options.store.writeBundle(options.artifact.bundle);
    state = {
      version: 2,
      status: "exported",
      runIdentity: options.runIdentity,
      canonicalRepoPath: options.canonicalRepoPath,
      baseSha: options.artifact.baseSha,
      resultSha: options.artifact.resultSha,
      baseTreeSha: null,
      resultTreeSha: null,
      branch,
      bundleSha256,
      bundleBytes: options.artifact.bundle.byteLength,
      changedFiles: [],
      diffSummary: null,
      deliveredAt: null,
    };
    await options.beforeTransition?.("exported");
    await options.store.save(state);
  }

  const bundle = await options.store.readBundle();
  if (
    bundle.byteLength !== state.bundleBytes ||
    await sha256(bundle) !== state.bundleSha256
  ) {
    throw new ResultDeliveryError(
      "The staged result bundle does not match its durable receipt.",
    );
  }

  if (state.status === "exported") {
    await assertHostReady(state.canonicalRepoPath, state.baseSha);
    const validation = await validateBundle(state, bundle);
    state = { ...state, status: "validated", ...validation };
    await options.beforeTransition?.("validated");
    await options.store.save(state);
  }

  if (state.status === "validated") {
    await assertHostReady(state.canonicalRepoPath, state.baseSha);
    await importBundle(state, bundle);
    state = { ...state, status: "imported" };
    await options.beforeTransition?.("imported");
    await options.store.save(state);
  }

  if (state.status === "imported") {
    await assertImportedRef(state);
    state = {
      ...state,
      status: "completed",
      deliveredAt: new Date().toISOString(),
    };
    await options.beforeTransition?.("completed");
    await options.store.save(state);
    await options.store.removeBundle();
  }

  return receiptFromState(state);
}

export async function loadCompletedResultDelivery(
  store: ResultDeliveryStore,
): Promise<ResultDeliveryReceipt | null> {
  const state = await store.load();
  if (state?.status !== "completed") return null;
  await assertImportedRef(state);
  return receiptFromState(state);
}

export async function revalidateResultDeliveryReceipt(receiptInput: ResultDeliveryReceipt): Promise<void> {
  const receipt = ResultDeliveryReceiptSchema.parse(receiptInput);
  const ref = await readRef(receipt.canonicalRepoPath, receipt.branch);
  if (ref !== receipt.resultSha) throw new ResultDeliveryError("Delivered branch no longer matches its receipt.");
  const baseTree = (await git(receipt.canonicalRepoPath, ["rev-parse", `${receipt.baseSha}^{tree}`])).stdout.trim();
  const resultTree = (await git(receipt.canonicalRepoPath, ["rev-parse", `${receipt.resultSha}^{tree}`])).stdout.trim();
  if (baseTree !== receipt.baseTreeSha || resultTree !== receipt.resultTreeSha) {
    throw new ResultDeliveryError("Delivered Git trees do not match the receipt.");
  }
  const changed = (await git(receipt.canonicalRepoPath, ["diff", "--name-only", "-z", receipt.baseSha, receipt.resultSha])).stdout.split("\0").filter(Boolean);
  const diffSummary = await gitDiffSummary(receipt.canonicalRepoPath, receipt.baseSha, receipt.resultSha, changed.length);
  if (JSON.stringify(changed) !== JSON.stringify(receipt.changedFiles) || JSON.stringify(diffSummary) !== JSON.stringify(receipt.diffSummary)) {
    throw new ResultDeliveryError("Delivered diff summary does not match the receipt.");
  }
}

function validateArtifactEnvelope(artifact: ResultDeliveryArtifact): void {
  if (!shaSchema.safeParse(artifact.baseSha).success) {
    throw new ResultDeliveryError("Result base SHA is invalid.");
  }
  if (!shaSchema.safeParse(artifact.resultSha).success) {
    throw new ResultDeliveryError("Result commit SHA is invalid.");
  }
  if (
    artifact.bundle.byteLength === 0 ||
    artifact.bundle.byteLength > MAX_RESULT_BUNDLE_BYTES
  ) {
    throw new ResultDeliveryError(
      `Result bundle must be between 1 and ${MAX_RESULT_BUNDLE_BYTES} bytes.`,
    );
  }
}

function assertSameDelivery(
  state: ResultDeliveryState,
  options: DeliverResultOptions,
  branch: string,
): void {
  if (
    state.runIdentity !== options.runIdentity ||
    state.canonicalRepoPath !== options.canonicalRepoPath ||
    state.baseSha !== options.artifact.baseSha ||
    state.resultSha !== options.artifact.resultSha ||
    state.branch !== branch
  ) {
    throw new ResultDeliveryError(
      "Existing result delivery state belongs to different bytes or a different run.",
    );
  }
}

async function validateBundle(
  state: ResultDeliveryState,
  bundle: Uint8Array,
): Promise<{ changedFiles: string[]; baseTreeSha: string; resultTreeSha: string; diffSummary: ResultDeliveryReceipt["diffSummary"] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-result-validate-"));
  const bare = path.join(root, "repository.git");
  const bundlePath = path.join(root, "result.bundle");
  try {
    await writeFile(bundlePath, bundle, { mode: 0o600 });
    await git(root, ["init", "--bare", bare]);
    await git(bare, [
      "fetch",
      "--no-tags",
      state.canonicalRepoPath,
      `${state.baseSha}:refs/heads/base`,
    ]);
    const heads = (await git(bare, ["bundle", "list-heads", bundlePath]))
      .stdout.trim().split("\n").filter(Boolean);
    if (
      heads.length !== 1 ||
      !heads[0]?.startsWith(`${state.resultSha} `)
    ) {
      throw new ResultDeliveryError(
        "Result bundle must expose exactly the expected task branch.",
      );
    }
    await git(bare, ["bundle", "verify", bundlePath]);
    await git(bare, [
      "fetch",
      "--no-tags",
      bundlePath,
      `${state.resultSha}:refs/heads/result`,
    ]);
    await git(bare, ["merge-base", "--is-ancestor", state.baseSha, state.resultSha]);
    const commitCount = Number.parseInt(
      (await git(bare, ["rev-list", "--count", `${state.baseSha}..${state.resultSha}`])).stdout.trim(),
      10,
    );
    if (!Number.isSafeInteger(commitCount) || commitCount > MAX_RESULT_COMMITS) {
      throw new ResultDeliveryError(
        `Result history exceeds ${MAX_RESULT_COMMITS} commits.`,
      );
    }
    const changed = await git(bare, [
      "diff",
      "--name-only",
      "-z",
      "--diff-filter=ACDMRTUXB",
      state.baseSha,
      state.resultSha,
    ]);
    const changedFiles = changed.stdout.split("\0").filter(Boolean);
    if (changedFiles.length > MAX_RESULT_PATHS) {
      throw new ResultDeliveryError(
        `Result changes more than ${MAX_RESULT_PATHS} paths.`,
      );
    }
    for (const changedPath of changedFiles) validateChangedPath(changedPath);
    await validateChangedEntryModes(bare, state);

    const objectIds = (await git(bare, [
      "rev-list",
      "--objects",
      "--no-object-names",
      `${state.baseSha}..${state.resultSha}`,
    ])).stdout.split("\n").filter(Boolean);
    if (objectIds.length > MAX_RESULT_OBJECTS) {
      throw new ResultDeliveryError(
        `Result contains more than ${MAX_RESULT_OBJECTS} Git objects.`,
      );
    }
    const sizes = await git(bare, [
      "cat-file",
      "--batch-check=%(objectsize)",
    ], `${objectIds.join("\n")}\n`);
    const totalBytes = sizes.stdout.split("\n").filter(Boolean).reduce(
      (total, value) => total + Number.parseInt(value, 10),
      0,
    );
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_RESULT_OBJECT_BYTES) {
      throw new ResultDeliveryError(
        `Result object graph exceeds ${MAX_RESULT_OBJECT_BYTES} bytes.`,
      );
    }
    const baseTreeSha = (await git(bare, ["rev-parse", `${state.baseSha}^{tree}`])).stdout.trim();
    const resultTreeSha = (await git(bare, ["rev-parse", `${state.resultSha}^{tree}`])).stdout.trim();
    const diffSummary = await gitDiffSummary(bare, state.baseSha, state.resultSha, changedFiles.length);
    return { changedFiles, baseTreeSha, resultTreeSha, diffSummary };
  } catch (error) {
    if (error instanceof ResultDeliveryError) throw error;
    throw new ResultDeliveryError("Result bundle validation failed.", { cause: error });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function gitDiffSummary(repositoryPath: string, baseSha: string, resultSha: string, filesChanged: number): Promise<ResultDeliveryReceipt["diffSummary"]> {
    const numstat = (await git(repositoryPath, ["diff", "--numstat", "-z", baseSha, resultSha])).stdout.split("\0").filter(Boolean);
    let insertions = 0;
    let deletions = 0;
    let binaryFiles = 0;
    let statEntries = 0;
    for (const entry of numstat) {
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(entry);
      if (!match) continue;
      statEntries += 1;
      if (match[1] === "-" || match[2] === "-") binaryFiles += 1;
      else {
        insertions += Number.parseInt(match[1]!, 10);
        deletions += Number.parseInt(match[2]!, 10);
      }
    }
    return { filesChanged, insertions, deletions, binaryFiles: Math.min(binaryFiles, statEntries) };
}

function validateChangedPath(changedPath: string): void {
  if (
    path.posix.isAbsolute(changedPath) ||
    changedPath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(changedPath) ||
    changedPath.split("/").some((part) => part === "" || part === "..") ||
    changedPath === ".git" ||
    changedPath.startsWith(".git/") ||
    changedPath === ".agent" ||
    changedPath.startsWith(".agent/")
  ) {
    throw new ResultDeliveryError(
      `Result contains forbidden changed path "${changedPath}".`,
    );
  }
}

async function validateChangedEntryModes(
  repositoryPath: string,
  state: ResultDeliveryState,
): Promise<void> {
  const raw = (await git(repositoryPath, [
    "diff",
    "--raw",
    "-z",
    "--no-abbrev",
    state.baseSha,
    state.resultSha,
  ])).stdout.split("\0");
  let index = 0;
  while (index < raw.length) {
    const header = raw[index++];
    if (!header) break;
    const match =
      /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])\d*$/.exec(header);
    if (!match) {
      throw new ResultDeliveryError(
        "Result contains an invalid raw Git diff entry.",
      );
    }
    const oldPath = raw[index++];
    if (oldPath === undefined) {
      throw new ResultDeliveryError("Result raw Git diff is truncated.");
    }
    const status = match[3];
    const resultPath = status === "R" || status === "C"
      ? raw[index++]
      : oldPath;
    if (resultPath === undefined) {
      throw new ResultDeliveryError("Result rename entry is truncated.");
    }
    const newMode = match[2];
    if (newMode === "120000" || newMode === "160000") {
      throw new ResultDeliveryError(
        `Result contains forbidden symbolic-link or gitlink path "${resultPath}".`,
      );
    }
  }
}

async function importBundle(
  state: ResultDeliveryState,
  bundle: Uint8Array,
): Promise<void> {
  const existing = await readRef(state.canonicalRepoPath, state.branch);
  if (existing) {
    if (existing !== state.resultSha) {
      throw new ResultDeliveryError(
        `Local branch ${state.branch} already points to different content.`,
      );
    }
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-result-import-"));
  const bundlePath = path.join(root, "result.bundle");
  try {
    await writeFile(bundlePath, bundle, { mode: 0o600 });
    await git(state.canonicalRepoPath, [
      "fetch",
      "--no-tags",
      bundlePath,
      state.resultSha,
    ]);
    await git(state.canonicalRepoPath, [
      "update-ref",
      `refs/heads/${state.branch}`,
      state.resultSha,
      "0".repeat(state.resultSha.length),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertHostReady(
  repositoryPath: string,
  baseSha: string,
): Promise<void> {
  const topLevel = (await git(repositoryPath, ["rev-parse", "--show-toplevel"]))
    .stdout.trim();
  if ((await realpath(topLevel)) !== (await realpath(repositoryPath))) {
    throw new ResultDeliveryError(
      "Result destination must remain the repository root.",
    );
  }
  const head = (await git(repositoryPath, ["rev-parse", "HEAD"])).stdout.trim();
  if (head !== baseSha) {
    throw new ResultDeliveryError(
      "Host HEAD changed during the run; refusing result delivery.",
    );
  }
  const status = (await git(repositoryPath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ])).stdout;
  if (status.trim()) {
    throw new ResultDeliveryError(
      "Host repository became dirty during the run; refusing result delivery.",
    );
  }
}

async function assertImportedRef(state: ResultDeliveryState): Promise<void> {
  const ref = await readRef(state.canonicalRepoPath, state.branch);
  if (ref !== state.resultSha) {
    throw new ResultDeliveryError(
      "Imported result branch does not match the durable delivery state.",
    );
  }
  if (!state.baseTreeSha || !state.resultTreeSha || !state.diffSummary) {
    throw new ResultDeliveryError("Completed result delivery is missing tree or diff evidence.");
  }
  const tree = (await git(state.canonicalRepoPath, ["rev-parse", `${state.resultSha}^{tree}`])).stdout.trim();
  if (tree !== state.resultTreeSha) throw new ResultDeliveryError("Imported result tree does not match the durable delivery state.");
}

async function readRef(
  repositoryPath: string,
  branch: string,
): Promise<string | null> {
  const result = await git(repositoryPath, [
    "show-ref",
    "--verify",
    "--hash",
    `refs/heads/${branch}`,
  ], undefined, true);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function receiptFromState(state: ResultDeliveryState): ResultDeliveryReceipt {
  if (state.status !== "completed" || !state.deliveredAt) {
    throw new ResultDeliveryError("Result delivery did not reach completion.");
  }
  return ResultDeliveryReceiptSchema.parse({
    version: 2,
    runIdentity: state.runIdentity,
    canonicalRepoPath: state.canonicalRepoPath,
    baseSha: state.baseSha,
    resultSha: state.resultSha,
    baseTreeSha: state.baseTreeSha,
    resultTreeSha: state.resultTreeSha,
    branch: state.branch,
    bundleSha256: state.bundleSha256,
    bundleBytes: state.bundleBytes,
    changedFiles: state.changedFiles,
    diffSummary: state.diffSummary,
    deliveredAt: state.deliveredAt,
  });
}

async function git(
  cwd: string,
  args: string[],
  stdin?: string,
  allowFailure = false,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn(
    [
      "git",
      "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgSign=false",
      "-c", "protocol.ext.allow=never",
      "-c", "core.pager=cat",
      ...args,
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: os.tmpdir(),
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (stdin !== undefined) {
    const writable = child.stdin;
    if (!writable) {
      throw new ResultDeliveryError("Git process stdin was unavailable.");
    }
    writable.write(stdin);
    writable.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (!allowFailure && exitCode !== 0) {
    throw new ResultDeliveryError(
      `git ${args[0] ?? "command"} failed: ${stderr.trim() || "No diagnostic output."}`,
    );
  }
  return { stdout, stderr, exitCode };
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(value).buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isMissingError(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT",
  );
}
