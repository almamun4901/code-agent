import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createMcpToolServer } from "./server";

const USAGE =
  "Usage: bun run src/mcp/stdio-server.ts --worktree-root <absolute-directory> --allowed-parent <absolute-directory>";

async function canonicalDirectory(value: string, label: string): Promise<string> {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute.\n${USAGE}`);
  }
  let info;
  try {
    info = await stat(value);
  } catch {
    throw new Error(`${label} does not exist: ${value}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`${label} is not a directory: ${value}`);
  }
  return realpath(value);
}

export async function parseWorktreeBoundary(
  args: string[],
): Promise<{ worktreeRoot: string; allowedParent: string }> {
  if (
    args.length !== 4 ||
    args[0] !== "--worktree-root" ||
    !args[1] ||
    args[2] !== "--allowed-parent" ||
    !args[3]
  ) {
    throw new Error(USAGE);
  }

  const worktreeRoot = await canonicalDirectory(args[1], "Worktree root");
  const allowedParent = await canonicalDirectory(args[3], "Allowed parent");
  const relative = path.relative(allowedParent, worktreeRoot);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Worktree root must be a child of the allowed parent: ${worktreeRoot}`,
    );
  }
  return { worktreeRoot, allowedParent };
}

export async function runStdioServer(args: string[]): Promise<void> {
  const { worktreeRoot } = await parseWorktreeBoundary(args);
  const server = createMcpToolServer({ worktreeRoot });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  runStdioServer(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown startup failure.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
