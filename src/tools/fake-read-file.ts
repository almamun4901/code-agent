export type FakeReadFileResult = {
  success: boolean;
  content: string;
};

const CANNED_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify(
    {
      name: "terminal-native-coding-agent",
      private: true,
      scripts: { test: "bun test tests/loop.test.ts" },
    },
    null,
    2,
  ),
  "src/loop.ts": [
    "export async function runAgentLoop(): Promise<void> {",
    "  // Phase 1 loop fixture: model calls are real; file reads are canned.",
    "}",
  ].join("\n"),
  "tests/loop.test.ts": [
    'import { describe, expect, test } from "bun:test";',
    "",
    'describe("Phase 1 loop", () => {',
    '  test("completes a typed three-read scenario", () => {});',
    "});",
  ].join("\n"),
};

/**
 * Return deterministic fixture content without touching the host filesystem.
 */
export function fakeReadFile(path: string): FakeReadFileResult {
  if (!isSafeRelativePath(path)) {
    return {
      success: false,
      content: `Invalid fake path: "${path}". Expected a non-empty relative path without traversal.`,
    };
  }

  const content = CANNED_FILES[path];

  if (content === undefined) {
    return {
      success: false,
      content: `Fake file not found: "${path}".`,
    };
  }

  return { success: true, content };
}

function isSafeRelativePath(path: string): boolean {
  if (!path.trim() || path.startsWith("/") || path.includes("\\")) {
    return false;
  }

  return !path.split("/").some((segment) => segment === ".." || segment === "");
}
