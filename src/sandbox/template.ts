import { Template, defaultBuildLogger } from "e2b";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_MANIFEST_PATH } from "./runtime-manifest";

export const DEFAULT_E2B_TEMPLATE_NAME =
  "terminal-coding-agent-tools:step-6-v1";
export const E2B_RUNTIME_ROOT = "/opt/agent";
export const E2B_SHELL_WRAPPER = "/usr/local/sbin/agent-run-shell";

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
    .aptInstall([
      "ca-certificates",
      "coreutils",
      "git",
      "nodejs",
      "procps",
      "python3-minimal",
      "ripgrep",
      "sudo",
      "util-linux",
    ], {
      noInstallRecommends: true,
    })
    .setUser("root")
    .runCmd([
      "groupadd --system task",
      "useradd --create-home --shell /bin/sh agent",
      "useradd --create-home --shell /bin/sh runner",
      "usermod --append --groups task agent",
      "usermod --append --groups task runner",
    ])
    .makeDir([
      E2B_RUNTIME_ROOT,
      `${E2B_RUNTIME_ROOT}/src`,
      "/workspace",
      "/workspace/tasks",
    ])
    .copy(["package.json", "bun.lock"], E2B_RUNTIME_ROOT)
    .copy("src", `${E2B_RUNTIME_ROOT}/src`)
    .runCmd(
      `install -o root -g root -m 0555 ${E2B_RUNTIME_ROOT}/src/sandbox/runner-wrapper.sh ${E2B_SHELL_WRAPPER}`,
    )
    .runCmd(
      `printf '%s\\n' 'agent ALL=(root) NOPASSWD: ${E2B_SHELL_WRAPPER}' > /etc/sudoers.d/agent-run-shell && chmod 0440 /etc/sudoers.d/agent-run-shell`,
    )
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
    .runCmd(`chown -R root:root ${E2B_RUNTIME_ROOT}`)
    .runCmd(`chmod -R a-w ${E2B_RUNTIME_ROOT}`)
    .runCmd("chown agent:task /workspace /workspace/tasks")
    .runCmd("chmod 0750 /workspace /workspace/tasks")
    .setEnvs({
      AGENT_SHELL_WRAPPER: E2B_SHELL_WRAPPER,
      AGENT_TASK_GROUP: "task",
    })
    .setUser("agent");
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

export function templateBuildOutput(result: {
  templateId: string;
  buildId: string;
  name: string;
}) {
  return {
    templateId: result.templateId,
    templateRef: result.name,
    buildId: result.buildId,
    name: result.name,
  };
}

if (import.meta.main) {
  if (process.argv.includes("--dry-run")) {
    process.stdout.write(`${Template.toDockerfile(createAgentTemplate())}\n`);
  } else {
    const result = await buildAgentTemplate();
    process.stdout.write(`${JSON.stringify(templateBuildOutput(result))}\n`);
  }
}
