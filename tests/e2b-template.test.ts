import { describe, expect, test } from "bun:test";
import { Template } from "e2b";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_E2B_TEMPLATE_NAME,
  E2B_RUNTIME_ROOT,
  E2B_SHELL_WRAPPER,
  createAgentTemplate,
  templateBuildOutput,
} from "../src/sandbox/template";
import {
  readLiveE2bConfig,
  toolStdout,
} from "./support/live-e2b-config";
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
    expect(dockerfile).toContain("python3");
    expect(dockerfile).not.toContain("python3-minimal");
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

  test("reports and requires a tagged runnable template reference", () => {
    expect(
      templateBuildOutput({
        templateId: "template-id",
        buildId: "build-id",
        name: "terminal-coding-agent-tools:step-6-v1",
      }),
    ).toEqual({
      templateId: "template-id",
      templateRef: "terminal-coding-agent-tools:step-6-v1",
      buildId: "build-id",
      name: "terminal-coding-agent-tools:step-6-v1",
    });

    expect(() =>
      readLiveE2bConfig({
        RUN_LIVE_E2B_TEST: "1",
        E2B_API_KEY: "configured",
        E2B_TEMPLATE_ID: "template-id",
      }),
    ).toThrow("bare templateId defaults to the unrelated :default tag");
    expect(
      readLiveE2bConfig({
        RUN_LIVE_E2B_TEST: "1",
        E2B_API_KEY: "configured",
        E2B_TEMPLATE_ID:
          "terminal-coding-agent-tools:step-6-v1",
      }),
    ).toEqual({
      enabled: true,
      templateRef: "terminal-coding-agent-tools:step-6-v1",
    });
  });

  test("converts millisecond tool timeouts to GNU timeout seconds", async () => {
    const wrapper = await readFile(
      new URL("../src/sandbox/runner-wrapper.sh", import.meta.url),
      "utf8",
    );

    expect(wrapper).toContain(
      "timeout_duration=$(printf '%d.%03ds'",
    );
    expect(wrapper).toContain(
      'timeout --signal=TERM --kill-after=1s "$timeout_duration"',
    );
    expect(wrapper).not.toContain('"${timeout_ms}ms"');
  });

  test("separates shell stdout from diagnostic stderr", () => {
    expect(
      toolStdout(
        [
          "STDOUT",
          "safe output",
          "",
          "STDERR",
          'Traceback source: print("NETWORK_REACHED")',
        ].join("\n"),
      ),
    ).toBe("safe output");
    expect(
      toolStdout('STDERR\nTraceback source: print("NETWORK_REACHED")'),
    ).toBe("");
  });
});
