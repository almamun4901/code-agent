import { Sandbox } from "e2b";

type SandboxAdminCommand =
  | { command: "list" }
  | { command: "kill"; sandboxId: string };

const SANDBOX_ID = /^[a-z0-9]{8,64}$/;

export function parseSandboxAdminArgs(args: string[]): SandboxAdminCommand {
  if (args.length === 1 && args[0] === "list") {
    return { command: "list" };
  }

  if (
    args.length === 3 &&
    args[0] === "kill" &&
    args[2] === "--yes" &&
    SANDBOX_ID.test(args[1] ?? "")
  ) {
    return { command: "kill", sandboxId: args[1]! };
  }

  throw new Error(
    [
      "Usage:",
      "  bun run e2b:sandboxes:list",
      "  bun run e2b:sandbox:kill -- <sandbox-id> --yes",
    ].join("\n"),
  );
}

async function listSandboxes(): Promise<void> {
  const paginator = Sandbox.list();
  const sandboxes = [];
  while (paginator.hasNext) {
    sandboxes.push(...(await paginator.nextItems()));
  }

  if (sandboxes.length === 0) {
    process.stdout.write("No running E2B sandboxes.\n");
    return;
  }

  for (const sandbox of sandboxes) {
    process.stdout.write(
      `${sandbox.sandboxId}\t${sandbox.state}\t${sandbox.templateId}\n`,
    );
  }
}

async function main(): Promise<void> {
  if (!process.env.E2B_API_KEY?.trim()) {
    throw new Error("E2B_API_KEY is required.");
  }

  const command = parseSandboxAdminArgs(process.argv.slice(2));
  if (command.command === "list") {
    await listSandboxes();
    return;
  }

  await Sandbox.kill(command.sandboxId);
  process.stdout.write(`Terminated E2B sandbox ${command.sandboxId}.\n`);
}

if (import.meta.main) {
  await main();
}
