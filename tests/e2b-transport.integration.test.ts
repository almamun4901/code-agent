import { afterEach, expect, test } from "bun:test";
import { Sandbox } from "e2b";
import { McpToolClient } from "../src/mcp/client";
import {
  E2bStdioTransport,
  e2bCommandController,
} from "../src/sandbox/e2b-stdio-transport";

const LIVE_ENABLED =
  process.env.RUN_LIVE_E2B_TEST === "1" &&
  Boolean(process.env.E2B_API_KEY?.trim()) &&
  Boolean(process.env.E2B_TEMPLATE_ID?.trim());
const templateId = process.env.E2B_TEMPLATE_ID?.trim() ?? "";
const sandboxes: Sandbox[] = [];
const clients: McpToolClient[] = [];

afterEach(async () => {
  await Promise.all(
    clients.splice(0).map((client) => client.close().catch(() => {})),
  );
  await Promise.all(
    sandboxes.splice(0).map((sandbox) => sandbox.kill().catch(() => {})),
  );
});

test.skipIf(!LIVE_ENABLED)(
  "E2B carries a real MCP stdio handshake and tool call",
  async () => {
    const sandbox = await Sandbox.create(templateId, {
      timeoutMs: 180_000,
      secure: true,
      allowInternetAccess: false,
      lifecycle: { onTimeout: "kill" },
    });
    sandboxes.push(sandbox);

    await sandbox.commands.run(
      [
        "mkdir -p /workspace/tasks/probe",
        "git -C /workspace/tasks/probe init -b main",
        "git -C /workspace/tasks/probe config user.email probe@example.invalid",
        "git -C /workspace/tasks/probe config user.name Probe",
        "printf 'sandbox-only\\n' > /workspace/tasks/probe/probe.txt",
        "git -C /workspace/tasks/probe add probe.txt",
        "git -C /workspace/tasks/probe commit -m seed",
      ].join(" && "),
    );

    const transport = new E2bStdioTransport({
      commands: e2bCommandController(sandbox.commands),
      command:
        "bun run /opt/agent/src/mcp/stdio-server.ts --worktree-root /workspace/tasks/probe --allowed-parent /workspace/tasks",
      cwd: "/opt/agent",
    });
    const client = await McpToolClient.connect(transport);
    clients.push(client);

    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "edit_file",
      "git",
      "read_file",
      "ripgrep",
      "run_shell",
      "tree_sitter_symbols",
    ]);
    expect(
      await client.call({
        name: "read_file",
        input: {
          path: "probe.txt",
        },
      }),
    ).toMatchObject({
      success: true,
      output: "1: sandbox-only\n2: ",
      metadata: { totalLines: 2 },
    });

    const pid = transport.pid;
    expect(pid).not.toBeNull();
    await sandbox.commands.kill(pid!);
    await Bun.sleep(100);
    await expect(
      client.call({
        name: "read_file",
        input: {
          path: "probe.txt",
        },
      }),
    ).rejects.toThrow();
  },
  180_000,
);
