import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createMcpToolServer } from "./server";

const USAGE =
  "Usage: bun run src/mcp/stdio-server.ts --development-root <absolute-directory>";

export async function parseDevelopmentRoot(args: string[]): Promise<string> {
  if (args.length !== 2 || args[0] !== "--development-root" || !args[1]) {
    throw new Error(USAGE);
  }

  const root = args[1];
  if (!path.isAbsolute(root)) {
    throw new Error(`Development root must be absolute.\n${USAGE}`);
  }

  let info;
  try {
    info = await stat(root);
  } catch {
    throw new Error(`Development root does not exist: ${root}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Development root is not a directory: ${root}`);
  }

  return path.resolve(root);
}

export async function runStdioServer(args: string[]): Promise<void> {
  const developmentRoot = await parseDevelopmentRoot(args);
  const server = createMcpToolServer({ developmentRoot });
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
