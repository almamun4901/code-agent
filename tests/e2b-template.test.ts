import { describe, expect, test } from "bun:test";
import { Template } from "e2b";
import {
  DEFAULT_E2B_TEMPLATE_NAME,
  E2B_RUNTIME_ROOT,
  E2B_SHELL_WRAPPER,
  createAgentTemplate,
} from "../src/sandbox/template";
import {
  RUNTIME_MANIFEST_PATH,
  TOOL_RUNTIME_VERSION,
  createRuntimeManifest,
} from "../src/sandbox/runtime-manifest";

describe("E2B runtime template", () => {
  test("pins the runtime and includes every required tool dependency", () => {
    const dockerfile = Template.toDockerfile(createAgentTemplate());

    expect(DEFAULT_E2B_TEMPLATE_NAME).toBe(
      "terminal-coding-agent-tools:step-6-v1",
    );
    expect(TOOL_RUNTIME_VERSION).toBe("step-6-v1");
    expect(E2B_RUNTIME_ROOT).toBe("/opt/agent");
    expect(E2B_SHELL_WRAPPER).toBe("/usr/local/sbin/agent-run-shell");
    expect(RUNTIME_MANIFEST_PATH).toBe(
      "/opt/agent/runtime-manifest.json",
    );
    expect(dockerfile).toContain("oven/bun:1.3.14");
    expect(dockerfile).toContain("ca-certificates");
    expect(dockerfile).toContain("coreutils");
    expect(dockerfile).toContain("git");
    expect(dockerfile).toContain("nodejs");
    expect(dockerfile).toContain("procps");
    expect(dockerfile).toContain("python3-minimal");
    expect(dockerfile).toContain("ripgrep");
    expect(dockerfile).toContain("sudo");
    expect(dockerfile).toContain("util-linux");
    expect(dockerfile).toContain("COPY src /opt/agent/src");
    expect(dockerfile).toContain(
      "RUN mkdir -p /opt/agent /opt/agent/src /workspace /workspace/tasks",
    );
    expect(dockerfile).toContain("useradd --create-home --shell /bin/sh agent");
    expect(dockerfile).toContain("useradd --create-home --shell /bin/sh runner");
    expect(dockerfile).toContain("install -o root -g root -m 0555");
    expect(dockerfile).toContain("/etc/sudoers.d/agent-run-shell");
    expect(dockerfile).toContain("RUN chown -R root:root /opt/agent");
    expect(dockerfile).toContain("RUN chmod -R a-w /opt/agent");
    expect(dockerfile).toContain("RUN chmod 0750 /workspace /workspace/tasks");
    expect(dockerfile.lastIndexOf("USER agent")).toBeGreaterThan(
      dockerfile.indexOf("RUN chmod -R a-w /opt/agent"),
    );
    expect(dockerfile).toContain(
      "bun install --frozen-lockfile --production",
    );
    expect(dockerfile).toContain("runtime-manifest.ts");
    expect(dockerfile).not.toContain(".env");
  });

  test("creates a deterministic non-secret runtime manifest", async () => {
    const first = await createRuntimeManifest(
      new URL("..", import.meta.url).pathname,
    );
    const second = await createRuntimeManifest(
      new URL("..", import.meta.url).pathname,
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      runtimeVersion: "step-6-v1",
      packageVersion: "0.1.0",
    });
    expect(first.lockSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain("API_KEY");
  });
});
