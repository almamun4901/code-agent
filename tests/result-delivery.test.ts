import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FileResultDeliveryStore,
  MemoryResultDeliveryStore,
  ResultDeliveryError,
  deliverResult,
  type ResultDeliveryArtifact,
  type ResultDeliveryState,
} from "../src/sandbox/result-delivery";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "./support/temp-repo";

const repositories: TemporaryRepository[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repo) => repo.cleanup()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<TemporaryRepository> {
  const repo = await createTemporaryRepository();
  repositories.push(repo);
  return repo;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr}`);
  return stdout.trim();
}

async function artifact(
  repository: TemporaryRepository,
  changedPath = "delivered.txt",
): Promise<ResultDeliveryArtifact> {
  const root = await mkdtemp(path.join(os.tmpdir(), "result-source-"));
  roots.push(root);
  const clone = path.join(root, "clone");
  const bundlePath = path.join(root, "result.bundle");
  await git(root, "clone", repository.worktreePath, clone);
  await git(clone, "config", "user.email", "delivery@example.invalid");
  await git(clone, "config", "user.name", "Delivery Test");
  const baseSha = await git(clone, "rev-parse", "HEAD");
  await mkdir(path.dirname(path.join(clone, changedPath)), { recursive: true });
  await writeFile(path.join(clone, changedPath), "survives cleanup\n");
  await git(clone, "add", "-A");
  await git(clone, "commit", "-m", "test: create delivered result");
  const resultSha = await git(clone, "rev-parse", "HEAD");
  await git(clone, "bundle", "create", bundlePath, "HEAD");
  return {
    baseSha,
    resultSha,
    bundle: new Uint8Array(await readFile(bundlePath)),
  };
}

function options(
  repository: TemporaryRepository,
  result: ResultDeliveryArtifact,
  store = new MemoryResultDeliveryStore(),
) {
  return {
    canonicalRepoPath: repository.worktreePath,
    runIdentity: "a".repeat(64),
    artifact: result,
    store,
  };
}

describe("transactional result delivery", () => {
  test("imports a validated result into a new branch without switching or changing the worktree", async () => {
    const repository = await fixture();
    const result = await artifact(repository);
    const originalBranch = await git(repository.worktreePath, "branch", "--show-current");
    const originalHead = await git(repository.worktreePath, "rev-parse", "HEAD");
    const delivery = options(repository, result);

    const receipt = await deliverResult(delivery);

    expect(receipt).toMatchObject({
      baseSha: originalHead,
      resultSha: result.resultSha,
      branch: "result/aaaaaaaaaaaa",
      changedFiles: ["delivered.txt"],
    });
    expect(await git(repository.worktreePath, "branch", "--show-current"))
      .toBe(originalBranch);
    expect(await git(repository.worktreePath, "rev-parse", "HEAD"))
      .toBe(originalHead);
    expect(await git(
      repository.worktreePath,
      "rev-parse",
      "refs/heads/result/aaaaaaaaaaaa",
    )).toBe(result.resultSha);
    expect(await git(repository.worktreePath, "status", "--porcelain=v1"))
      .toBe("");

    await expect(deliverResult(delivery)).resolves.toEqual(receipt);
  });

  test("refuses a dirty host before importing any branch", async () => {
    const repository = await fixture();
    const result = await artifact(repository);
    const delivery = options(repository, result);
    await writeFile(path.join(repository.worktreePath, "host-change.txt"), "dirty\n");

    await expect(deliverResult(delivery)).rejects.toThrow("became dirty");
    expect(delivery.store.state?.status).toBe("exported");
    await expect(
      git(repository.worktreePath, "rev-parse", "refs/heads/result/aaaaaaaaaaaa"),
    ).rejects.toThrow();
  });

  test("rejects corrupt bundles and protected result paths", async () => {
    const repository = await fixture();
    const valid = await artifact(repository);
    const corrupt = { ...valid, bundle: new Uint8Array([1, 2, 3]) };
    await expect(deliverResult(options(repository, corrupt)))
      .rejects.toBeInstanceOf(ResultDeliveryError);

    const protectedArtifact = await artifact(repository, ".agent/payload.txt");
    await expect(
      deliverResult(options(repository, protectedArtifact)),
    ).rejects.toThrow("forbidden changed path");
  });

  for (const transition of [
    "exported",
    "validated",
    "imported",
    "completed",
  ] as const) {
    test(`resumes idempotently after interruption at ${transition}`, async () => {
      const repository = await fixture();
      const result = await artifact(repository);
      const delivery = options(repository, result);
      let interrupted = false;

      await expect(deliverResult({
        ...delivery,
        beforeTransition(status) {
          if (!interrupted && status === transition) {
            interrupted = true;
            throw new Error(`interrupt ${status}`);
          }
        },
      })).rejects.toThrow(`interrupt ${transition}`);

      const receipt = await deliverResult(delivery);
      expect(receipt.resultSha).toBe(result.resultSha);
      expect(await git(
        repository.worktreePath,
        "rev-parse",
        "refs/heads/result/aaaaaaaaaaaa",
      )).toBe(result.resultSha);
    });
  }

  test("persists state and the staged bundle with owner-only permissions", async () => {
    const repository = await fixture();
    const result = await artifact(repository);
    const store = new FileResultDeliveryStore(repository.worktreePath);
    await store.writeBundle(result.bundle);
    await store.save({
      version: 1,
      status: "exported",
      runIdentity: "b".repeat(64),
      canonicalRepoPath: repository.worktreePath,
      baseSha: result.baseSha,
      resultSha: result.resultSha,
      branch: "result/bbbbbbbbbbbb",
      bundleSha256: "c".repeat(64),
      bundleBytes: result.bundle.byteLength,
      changedFiles: [],
      deliveredAt: null,
    } satisfies ResultDeliveryState);

    expect((await stat(store.statePath)).mode & 0o777).toBe(0o600);
    expect((await stat(store.bundlePath)).mode & 0o777).toBe(0o600);
    expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
  });
});
