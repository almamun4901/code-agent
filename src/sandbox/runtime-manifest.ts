import { readFile } from "node:fs/promises";
import path from "node:path";

export const TOOL_RUNTIME_VERSION = "mutation-recovery-v1";
export const RUNTIME_MANIFEST_PATH = "/opt/agent/runtime-manifest.json";

export type RuntimeManifest = {
  runtimeVersion: string;
  packageVersion: string;
  lockSha256: string;
};

function sha256(content: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

export async function createRuntimeManifest(
  projectRoot: string,
): Promise<RuntimeManifest> {
  const [lockfile, packageText] = await Promise.all([
    readFile(path.join(projectRoot, "bun.lock")),
    readFile(path.join(projectRoot, "package.json"), "utf8"),
  ]);
  const packageValue: unknown = JSON.parse(packageText);
  const packageVersion =
    typeof packageValue === "object" &&
    packageValue !== null &&
    "version" in packageValue &&
    typeof packageValue.version === "string"
      ? packageValue.version
      : undefined;
  if (!packageVersion) {
    throw new Error("package.json must contain a non-empty version.");
  }

  return {
    runtimeVersion: TOOL_RUNTIME_VERSION,
    packageVersion,
    lockSha256: sha256(lockfile),
  };
}

if (import.meta.main) {
  const [projectRoot, destination] = process.argv.slice(2);
  if (!projectRoot || !destination) {
    throw new Error(
      "Usage: bun run runtime-manifest.ts <project-root> <destination>",
    );
  }
  await Bun.write(
    destination,
    `${JSON.stringify(await createRuntimeManifest(projectRoot), null, 2)}\n`,
  );
}
