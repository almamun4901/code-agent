import { Template, defaultBuildLogger } from "e2b";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_MANIFEST_PATH } from "./runtime-manifest";

export const DEFAULT_E2B_TEMPLATE_NAME =
  "terminal-coding-agent-tools:step-5-v1";
export const E2B_RUNTIME_ROOT = "/opt/agent";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export function createAgentTemplate() {
  return Template({
    fileContextPath: projectRoot,
    fileIgnorePatterns: [
      ".env",
      ".agent/**",
      ".git/**",
      "node_modules/**",
      "tests/**",
      "docs/**",
      "outputs/**",
      "eval/**",
    ],
  })
    .fromBunImage("1.3.14")
    .aptInstall(["ca-certificates", "git", "ripgrep"], {
      noInstallRecommends: true,
    })
    .setUser("root")
    .makeDir([
      E2B_RUNTIME_ROOT,
      `${E2B_RUNTIME_ROOT}/src`,
      "/workspace",
      "/workspace/tasks",
    ])
    .copy(["package.json", "bun.lock"], E2B_RUNTIME_ROOT)
    .copy("src", `${E2B_RUNTIME_ROOT}/src`)
    .setWorkdir(E2B_RUNTIME_ROOT)
    .runCmd("bun install --frozen-lockfile --production")
    .runCmd(
      `bun run src/sandbox/runtime-manifest.ts ${E2B_RUNTIME_ROOT} ${RUNTIME_MANIFEST_PATH}`,
    )
    .runCmd([
      "bun --version",
      "git --version",
      "rg --version",
      "test -f node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm",
      "test -f node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm",
    ])
    .runCmd(`chown -R user:user ${E2B_RUNTIME_ROOT} /workspace`)
    .setUser("user");
}

export async function buildAgentTemplate(
  name = process.env.E2B_TEMPLATE_NAME?.trim() ||
    DEFAULT_E2B_TEMPLATE_NAME,
) {
  return Template.build(createAgentTemplate(), name, {
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger(),
  });
}

if (import.meta.main) {
  if (process.argv.includes("--dry-run")) {
    process.stdout.write(`${Template.toDockerfile(createAgentTemplate())}\n`);
  } else {
    const result = await buildAgentTemplate();
    process.stdout.write(
      `${JSON.stringify({
        templateId: result.templateId,
        buildId: result.buildId,
        name: result.name,
      })}\n`,
    );
  }
}
