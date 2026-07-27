import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  dispatchTool,
} from "../src/tools/dispatcher";
import type {
  TokenCodec,
  ToolCall,
  ToolResult,
} from "../src/tools/contracts";
import {
  finalizeToolResult,
  O200K_CODEC,
  serializedTokenCount,
  TOOL_OUTPUT_TOKEN_LIMIT,
} from "../src/tools/token-budget";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "./support/temp-repo";

const repositories: TemporaryRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repo) => repo.cleanup()));
});

async function fixture(): Promise<TemporaryRepository> {
  const repo = await createTemporaryRepository();
  repositories.push(repo);
  return repo;
}

async function dispatch(
  repo: TemporaryRepository,
  call: ToolCall,
  overrides: Parameters<typeof dispatchTool>[1] = {},
): Promise<ToolResult> {
  return dispatchTool(call, {
    developmentRoot: repo.root,
    ...overrides,
  });
}

describe("tool result finalization", () => {
  const characterCodec: TokenCodec = {
    name: "characters",
    encode: (text) => Array.from(text, (character) => character.codePointAt(0) ?? 0),
    decode: (tokens) => String.fromCodePoint(...tokens),
  };

  test("preserves output when the complete serialized result is exactly at the limit", () => {
    const output = "x".repeat(40);
    const expected = finalizeToolResult(
      true,
      { output },
      { codec: characterCodec, tokenLimit: 10_000 },
    );
    const exactLimit = serializedTokenCount(expected, characterCodec);
    const actual = finalizeToolResult(
      true,
      { output },
      { codec: characterCodec, tokenLimit: exactLimit },
    );

    expect(actual.truncated).toBe(false);
    expect(serializedTokenCount(actual, characterCodec)).toBe(exactLimit);
  });

  test("keeps a bounded head and tail plus an informative marker", () => {
    const result = finalizeToolResult(
      true,
      { output: `BEGIN-${"middle ".repeat(1_000)}-END` },
      { codec: characterCodec, tokenLimit: 220 },
    );

    expect(result.truncated).toBe(true);
    expect(result.output).toStartWith("BEGIN-");
    expect(result.output).toEndWith("-END");
    expect(result.output).toContain("tokens omitted");
    expect(serializedTokenCount(result, characterCodec)).toBeLessThanOrEqual(220);
  });

  test("caps code, non-ASCII, metadata, and error-shaped results", () => {
    const result = finalizeToolResult(
      false,
      {
        output: "λ🙂 const value = 1;\n".repeat(5_000),
        metadata: { code: "VERY_LONG_ERROR", exitCode: 2 },
      },
    );

    expect(result.truncated).toBe(true);
    expect(result.metadata?.code).toBe("VERY_LONG_ERROR");
    expect(serializedTokenCount(result)).toBeLessThanOrEqual(
      TOOL_OUTPUT_TOKEN_LIMIT,
    );
  });
});

describe("dispatcher and development containment", () => {
  test("runs the policy seam before execution", async () => {
    const repo = await fixture();
    let policyRan = false;

    const result = await dispatch(
      repo,
      {
        name: "read_file",
        input: { repoPath: repo.worktreePath, path: "src/sample.ts" },
      },
      {
        beforeToolUse: async () => {
          policyRan = true;
        },
      },
    );

    expect(policyRan).toBe(true);
    expect(result.success).toBe(true);
  });

  test("a rejected policy executes no edit", async () => {
    const repo = await fixture();
    const original = await readFile(
      path.join(repo.worktreePath, "src/sample.ts"),
      "utf8",
    );
    const result = await dispatch(
      repo,
      {
        name: "edit_file",
        input: {
          repoPath: repo.worktreePath,
          path: "src/sample.ts",
          mode: "apply",
          oldText: "Greeter",
          newText: "Changed",
          baseVersion: "invented",
        },
      },
      {
        beforeToolUse: async () => {
          throw new Error("blocked by test policy");
        },
      },
    );

    expect(result.success).toBe(false);
    expect(await readFile(path.join(repo.worktreePath, "src/sample.ts"), "utf8"))
      .toBe(original);
  });

  test("rejects an unknown tool and a repository outside the disposable root", async () => {
    const repo = await fixture();
    const unknown = await dispatch(
      repo,
      { name: "unknown", input: { repoPath: repo.worktreePath } } as never,
    );
    const outside = await dispatchTool(
      {
        name: "read_file",
        input: { repoPath: process.cwd(), path: "package.json" },
      },
      { developmentRoot: repo.root },
    );

    expect(unknown.metadata?.code).toBe("UNKNOWN_TOOL");
    expect(outside.metadata?.code).toBe("OUTSIDE_DEVELOPMENT_ROOT");
  });

  test("rejects malformed and unknown calls before policy or execution", async () => {
    const repo = await fixture();
    let policyRan = false;
    const malformed = await dispatchTool(
      { name: "read_file" } as never,
      {
        developmentRoot: repo.root,
        beforeToolUse: async () => {
          policyRan = true;
        },
      },
    );
    const invalidMode = await dispatchTool(
      {
        name: "edit_file",
        input: {
          repoPath: repo.worktreePath,
          path: "src/sample.ts",
          mode: "write",
          oldText: "Greeter",
          newText: "Changed",
        },
      } as never,
      {
        developmentRoot: repo.root,
        beforeToolUse: async () => {
          policyRan = true;
        },
      },
    );
    const unknown = await dispatchTool(
      {
        name: "unknown",
        input: { repoPath: repo.worktreePath },
      } as never,
      {
        developmentRoot: repo.root,
        beforeToolUse: async () => {
          policyRan = true;
        },
      },
    );

    expect(malformed.metadata?.code).toBe("INVALID_TOOL_CALL");
    expect(invalidMode.metadata?.code).toBe("INVALID_TOOL_CALL");
    expect(unknown.metadata?.code).toBe("UNKNOWN_TOOL");
    expect(policyRan).toBe(false);
  });

  test("lexical traversal is rejected separately from root containment", async () => {
    const repo = await fixture();
    const result = await dispatch(repo, {
      name: "read_file",
      input: { repoPath: repo.worktreePath, path: "../seed/package.json" },
    });

    expect(result.metadata?.code).toBe("INVALID_PATH");
  });
});

describe("read_file", () => {
  test("reads full and inclusive ranged UTF-8 text with line numbers", async () => {
    const repo = await fixture();
    const ranged = await dispatch(repo, {
      name: "read_file",
      input: {
        repoPath: repo.worktreePath,
        path: "src/sample.ts",
        startLine: 2,
        endLine: 3,
      },
    });

    expect(ranged.success).toBe(true);
    expect(ranged.output).toContain("2:   greet");
    expect(ranged.output).toContain("3:     return");

    const empty = await dispatch(repo, {
      name: "read_file",
      input: { repoPath: repo.worktreePath, path: "empty.txt" },
    });
    expect(empty.success).toBe(true);
    expect(empty.output).toBe("1: ");
  });

  test("reports missing, unreadable, binary, UTF-8, range, and path errors", async () => {
    const repo = await fixture();
    const results = await Promise.all([
      dispatch(repo, {
        name: "read_file",
        input: { repoPath: repo.worktreePath, path: "missing.txt" },
      }),
      dispatch(repo, {
        name: "read_file",
        input: { repoPath: repo.worktreePath, path: "binary.bin" },
      }),
      dispatch(repo, {
        name: "read_file",
        input: { repoPath: repo.worktreePath, path: "src" },
      }),
      dispatch(repo, {
        name: "read_file",
        input: { repoPath: repo.worktreePath, path: "invalid-utf8.txt" },
      }),
      dispatch(repo, {
        name: "read_file",
        input: {
          repoPath: repo.worktreePath,
          path: "src/sample.ts",
          startLine: 999,
        },
      }),
      dispatch(repo, {
        name: "read_file",
        input: {
          repoPath: repo.worktreePath,
          path: "src/sample.ts",
          startLine: 1,
          endLine: 999,
        },
      }),
      dispatch(repo, {
        name: "read_file",
        input: { repoPath: repo.worktreePath, path: "src//sample.ts" },
      }),
    ]);

    expect(results.map((result) => result.success)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(results[0]?.metadata?.code).toBe("FILE_NOT_FOUND");
    expect(results[1]?.metadata?.code).toBe("BINARY_FILE");
    expect(results[2]?.metadata?.code).toBe("FILE_READ_FAILED");
    expect(results[3]?.metadata?.code).toBe("INVALID_UTF8");
  });

  test("truncates an oversized real file within the serialized cap", async () => {
    const repo = await fixture();
    const result = await dispatch(repo, {
      name: "read_file",
      input: { repoPath: repo.worktreePath, path: "repeat.txt" },
    });

    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("tokens omitted");
    expect(serializedTokenCount(result, O200K_CODEC)).toBeLessThanOrEqual(4_000);
  });
});

describe("edit_file", () => {
  test("previews without writing, then applies with the returned baseVersion", async () => {
    const repo = await fixture();
    const original = await readFile(
      path.join(repo.worktreePath, "src/sample.ts"),
      "utf8",
    );
    const request = {
      repoPath: repo.worktreePath,
      path: "src/sample.ts",
      oldText: "Greeter",
      newText: "Welcomer",
    } as const;
    const preview = await dispatch(repo, {
      name: "edit_file",
      input: { ...request, mode: "preview" },
    });

    expect(preview.success).toBe(true);
    expect(preview.output).toContain("-export class Greeter");
    expect(await readFile(path.join(repo.worktreePath, "src/sample.ts"), "utf8"))
      .toBe(original);

    const applied = await dispatch(repo, {
      name: "edit_file",
      input: {
        ...request,
        mode: "apply",
        baseVersion: String(preview.metadata?.baseVersion),
      },
    });
    expect(applied.success).toBe(true);
    expect(await readFile(path.join(repo.worktreePath, "src/sample.ts"), "utf8"))
      .toContain("class Welcomer");
  });

  test("rejects stale, zero-match, ambiguous, and no-op edits", async () => {
    const repo = await fixture();
    const common = {
      repoPath: repo.worktreePath,
      path: "repeat.txt",
      mode: "preview" as const,
    };
    const results = await Promise.all([
      dispatch(repo, {
        name: "edit_file",
        input: {
          ...common,
          mode: "apply",
          oldText: "needle",
          newText: "pin",
          baseVersion: "sha256:stale",
          replaceAll: true,
        },
      }),
      dispatch(repo, {
        name: "edit_file",
        input: { ...common, oldText: "absent", newText: "present" },
      }),
      dispatch(repo, {
        name: "edit_file",
        input: { ...common, oldText: "needle", newText: "pin" },
      }),
      dispatch(repo, {
        name: "edit_file",
        input: { ...common, oldText: "needle", newText: "needle" },
      }),
    ]);

    expect(results.map((result) => result.metadata?.code)).toEqual([
      "STALE_EDIT",
      "NO_EDIT_MATCH",
      "AMBIGUOUS_EDIT",
      "NO_OP_EDIT",
    ]);
  });

  test("replaceAll permits multiple matches and creation requires a missing target", async () => {
    const repo = await fixture();
    const replace = await dispatch(repo, {
      name: "edit_file",
      input: {
        repoPath: repo.worktreePath,
        path: "repeat.txt",
        mode: "preview",
        oldText: "needle",
        newText: "pin",
        replaceAll: true,
      },
    });
    const createPreview = await dispatch(repo, {
      name: "edit_file",
      input: {
        repoPath: repo.worktreePath,
        path: "src/new.ts",
        mode: "preview",
        oldText: null,
        newText: "export const created = true;\n",
      },
    });
    const createApply = await dispatch(repo, {
      name: "edit_file",
      input: {
        repoPath: repo.worktreePath,
        path: "src/new.ts",
        mode: "apply",
        oldText: null,
        newText: "export const created = true;\n",
        baseVersion: "missing",
      },
    });

    expect(replace.success).toBe(true);
    expect(replace.metadata?.matchCount).toBe(6_000);
    expect(replace.truncated).toBe(true);
    expect(createPreview.metadata?.baseVersion).toBe("missing");
    expect(createApply.success).toBe(true);
  });
});

describe("ripgrep", () => {
  test("supports fixed strings, globs, case modes, empty results, and errors", async () => {
    const repo = await fixture();
    const match = await dispatch(repo, {
      name: "ripgrep",
      input: {
        repoPath: repo.worktreePath,
        pattern: "GREETER",
        path: "src",
        glob: "*.ts",
        caseSensitive: false,
        fixedString: true,
      },
    });
    const empty = await dispatch(repo, {
      name: "ripgrep",
      input: { repoPath: repo.worktreePath, pattern: "not-present" },
    });
    const invalid = await dispatch(repo, {
      name: "ripgrep",
      input: { repoPath: repo.worktreePath, pattern: "[" },
    });

    expect(match.success).toBe(true);
    expect(match.output).toContain("sample.ts");
    expect(empty.success).toBe(true);
    expect(empty.metadata?.matches).toBe(0);
    expect(invalid.success).toBe(false);
  });

  test("caps a large match set", async () => {
    const repo = await fixture();
    const result = await dispatch(repo, {
      name: "ripgrep",
      input: { repoPath: repo.worktreePath, pattern: "needle", path: "repeat.txt" },
    });

    expect(result.truncated).toBe(true);
    expect(serializedTokenCount(result)).toBeLessThanOrEqual(4_000);
  });
});

describe("run_shell", () => {
  test("captures stdout, stderr, nonzero exit, command-not-found, and timeout", async () => {
    const repo = await fixture();
    const mixed = await dispatch(repo, {
      name: "run_shell",
      input: {
        repoPath: repo.worktreePath,
        cwd: ".",
        command: "echo out; echo err >&2; exit 7",
      },
    });
    const missing = await dispatch(repo, {
      name: "run_shell",
      input: {
        repoPath: repo.worktreePath,
        cwd: ".",
        command: "definitely-not-a-real-command",
      },
    });
    const timeout = await dispatch(repo, {
      name: "run_shell",
      input: {
        repoPath: repo.worktreePath,
        cwd: ".",
        command: "sleep 2",
        timeoutMs: 20,
      },
    });

    expect(mixed.success).toBe(true);
    expect(mixed.output).toContain("STDOUT\nout");
    expect(mixed.output).toContain("STDERR\nerr");
    expect(mixed.metadata?.exitCode).toBe(7);
    expect(missing.metadata?.exitCode).toBe(127);
    expect(timeout.metadata?.timedOut).toBe(true);
  });

  test("rejects an invalid cwd and caps large output", async () => {
    const repo = await fixture();
    const invalid = await dispatch(repo, {
      name: "run_shell",
      input: {
        repoPath: repo.worktreePath,
        cwd: "../seed",
        command: "pwd",
      },
    });
    const overflow = await dispatch(repo, {
      name: "run_shell",
      input: {
        repoPath: repo.worktreePath,
        cwd: ".",
        command: "yes output | head -n 10000",
      },
    });

    expect(invalid.metadata?.code).toBe("INVALID_PATH");
    expect(overflow.truncated).toBe(true);
  });
});

describe("git", () => {
  test("reports clean/dirty state and staged, unstaged, path-scoped diffs", async () => {
    const repo = await fixture();
    const clean = await dispatch(repo, {
      name: "git",
      input: { repoPath: repo.worktreePath, subcommand: "status" },
    });
    await repo.write("src/sample.ts", `${await readFile(path.join(repo.worktreePath, "src/sample.ts"), "utf8")}// changed\n`);
    const dirty = await dispatch(repo, {
      name: "git",
      input: { repoPath: repo.worktreePath, subcommand: "status" },
    });
    const diff = await dispatch(repo, {
      name: "git",
      input: {
        repoPath: repo.worktreePath,
        subcommand: "diff",
        path: "src/sample.ts",
      },
    });
    await dispatch(repo, {
      name: "run_shell",
      input: {
        repoPath: repo.worktreePath,
        cwd: ".",
        command: "git add src/sample.ts",
      },
    });
    const staged = await dispatch(repo, {
      name: "git",
      input: {
        repoPath: repo.worktreePath,
        subcommand: "diff",
        staged: true,
        path: "src/sample.ts",
      },
    });

    expect(clean.metadata?.clean).toBe(true);
    expect(dirty.metadata?.clean).toBe(false);
    expect(diff.output).toContain("// changed");
    expect(staged.output).toContain("// changed");
  });

  test("fails an empty commit, commits addAll with a SHA, and pushes locally", async () => {
    const repo = await fixture();
    const empty = await dispatch(repo, {
      name: "git",
      input: {
        repoPath: repo.worktreePath,
        subcommand: "commit",
        message: "nothing",
        addAll: false,
      },
    });
    await repo.write("new.txt", "new\n");
    const commit = await dispatch(repo, {
      name: "git",
      input: {
        repoPath: repo.worktreePath,
        subcommand: "commit",
        message: "add new file",
        addAll: true,
      },
    });
    const push = await dispatch(repo, {
      name: "git",
      input: {
        repoPath: repo.worktreePath,
        subcommand: "push",
        remote: repo.bareRemotePath,
        branch: "agent-step2",
      },
    });
    const badPush = await dispatch(repo, {
      name: "git",
      input: {
        repoPath: repo.worktreePath,
        subcommand: "push",
        remote: path.join(repo.root, "missing.git"),
        branch: "agent-step2",
      },
    });
    const badBranch = await dispatch(repo, {
      name: "git",
      input: {
        repoPath: repo.worktreePath,
        subcommand: "push",
        remote: repo.bareRemotePath,
        branch: "missing-branch",
      },
    });

    expect(empty.success).toBe(false);
    expect(commit.success).toBe(true);
    expect(String(commit.metadata?.sha)).toMatch(/^[0-9a-f]{40}$/);
    expect(push.success).toBe(true);
    expect(badPush.success).toBe(false);
    expect(badBranch.success).toBe(false);
  });

  test("caps a large diff", async () => {
    const repo = await fixture();
    await repo.write("repeat.txt", "changed\n".repeat(8_000));
    const result = await dispatch(repo, {
      name: "git",
      input: {
        repoPath: repo.worktreePath,
        subcommand: "diff",
        path: "repeat.txt",
      },
    });

    expect(result.truncated).toBe(true);
    expect(serializedTokenCount(result)).toBeLessThanOrEqual(4_000);
  });
});

describe("tree_sitter_symbols", () => {
  test.each([
    ["src/sample.py", "python", "class\tWorker", "function\thelper"],
    ["src/sample.ts", "typescript", "class\tGreeter", "function\thelper"],
    ["src/sample.js", "javascript", "class\tWidget", "function\tbuild"],
    ["src/sample.tsx", "tsx", "interface\tProps", "function\tCard"],
  ])("extracts symbols from %s", async (file, language, first, second) => {
    const repo = await fixture();
    const result = await dispatch(repo, {
      name: "tree_sitter_symbols",
      input: { repoPath: repo.worktreePath, path: file },
    });

    expect(result.success).toBe(true);
    expect(result.metadata?.language).toBe(language);
    expect(result.output).toContain(first);
    expect(result.output).toContain(second);
  });

  test("reports recovered parse errors and unsupported files", async () => {
    const repo = await fixture();
    await repo.write("src/broken.py", "def broken(:\n  pass\n");
    const broken = await dispatch(repo, {
      name: "tree_sitter_symbols",
      input: { repoPath: repo.worktreePath, path: "src/broken.py" },
    });
    const unsupported = await dispatch(repo, {
      name: "tree_sitter_symbols",
      input: { repoPath: repo.worktreePath, path: "repeat.txt" },
    });

    expect(broken.success).toBe(true);
    expect(broken.metadata?.hasParseErrors).toBe(true);
    expect(unsupported.metadata?.code).toBe("UNSUPPORTED_LANGUAGE");
  });

  test("caps a large symbol list", async () => {
    const repo = await fixture();
    await repo.write(
      "src/many.py",
      Array.from({ length: 3_000 }, (_, index) => `def fn_${index}():\n    pass\n`).join("\n"),
    );
    const result = await dispatch(repo, {
      name: "tree_sitter_symbols",
      input: { repoPath: repo.worktreePath, path: "src/many.py" },
    });

    expect(result.truncated).toBe(true);
    expect(serializedTokenCount(result)).toBeLessThanOrEqual(4_000);
  });
});
