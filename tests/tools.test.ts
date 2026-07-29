import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  dispatchTool,
} from "../src/tools/dispatcher";
import { defaultPreToolUse } from "../src/tools/pretooluse-policy";
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
  overrides: Partial<Parameters<typeof dispatchTool>[1]> = {},
): Promise<ToolResult> {
  return dispatchTool(call, {
    worktreeRoot: repo.worktreePath,
    ...overrides,
  });
}

async function configureGit(
  repo: TemporaryRepository,
  key: string,
  value: string,
): Promise<void> {
  const child = Bun.spawn(
    ["/usr/bin/git", "config", key, value],
    {
      cwd: repo.worktreePath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
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
        input: { path: "src/sample.ts" },
      },
      {
        preToolUse: async () => {
          policyRan = true;
          return { outcome: "allow" };
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
          path: "src/sample.ts",
          mode: "apply",
          oldText: "Greeter",
          newText: "Changed",
          baseVersion: "invented",
        },
      },
      {
        preToolUse: async () => {
          return {
            outcome: "deny",
            code: "TEST_POLICY_DENIED",
            reason: "blocked by test policy",
          };
        },
      },
    );

    expect(result.success).toBe(false);
    expect(await readFile(path.join(repo.worktreePath, "src/sample.ts"), "utf8"))
      .toBe(original);
  });

  test("fails closed when the policy hook throws", async () => {
    const repo = await fixture();
    const result = await dispatch(
      repo,
      {
        name: "read_file",
        input: { path: "src/sample.ts" },
      },
      {
        preToolUse: async () => {
          throw new Error("policy backend unavailable");
        },
      },
    );

    expect(result).toMatchObject({
      success: false,
      metadata: { code: "POLICY_FAILURE" },
    });
    expect(result.output).toContain("policy backend unavailable");
  });

  test("rejects an unknown tool and requires an immutable worktree root", async () => {
    const repo = await fixture();
    const unknown = await dispatch(
      repo,
      { name: "unknown", input: {} } as never,
    );
    const missingRoot = await dispatchTool(
      {
        name: "read_file",
        input: { path: "package.json" },
      },
      {} as never,
    );

    expect(unknown.metadata?.code).toBe("UNKNOWN_TOOL");
    expect(missingRoot.metadata?.code).toBe("MISSING_WORKTREE_ROOT");
  });

  test("rejects malformed and unknown calls before policy or execution", async () => {
    const repo = await fixture();
    let policyRan = false;
    const malformed = await dispatchTool(
      { name: "read_file" } as never,
      {
        worktreeRoot: repo.worktreePath,
        preToolUse: async () => {
          policyRan = true;
          return { outcome: "allow" };
        },
      },
    );
    const invalidMode = await dispatchTool(
      {
        name: "edit_file",
        input: {
          path: "src/sample.ts",
          mode: "write",
          oldText: "Greeter",
          newText: "Changed",
        },
      } as never,
      {
        worktreeRoot: repo.worktreePath,
        preToolUse: async () => {
          policyRan = true;
          return { outcome: "allow" };
        },
      },
    );
    const unknown = await dispatchTool(
      {
        name: "unknown",
        input: {},
      } as never,
      {
        worktreeRoot: repo.worktreePath,
        preToolUse: async () => {
          policyRan = true;
          return { outcome: "allow" };
        },
      },
    );
    const injectedRoot = await dispatchTool(
      {
        name: "read_file",
        input: {
          path: "src/sample.ts",
          repoPath: "/tmp",
        },
      },
      {
        worktreeRoot: repo.worktreePath,
        preToolUse: async () => {
          policyRan = true;
          return { outcome: "allow" };
        },
      },
    );

    expect(malformed.metadata?.code).toBe("INVALID_TOOL_CALL");
    expect(invalidMode.metadata?.code).toBe("INVALID_TOOL_CALL");
    expect(unknown.metadata?.code).toBe("UNKNOWN_TOOL");
    expect(injectedRoot.metadata?.code).toBe("INVALID_TOOL_CALL");
    expect(policyRan).toBe(false);
  });

  test("lexical traversal is rejected separately from root containment", async () => {
    const repo = await fixture();
    const result = await dispatch(repo, {
      name: "read_file",
      input: { path: "../seed/package.json" },
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
      input: { path: "empty.txt" },
    });
    expect(empty.success).toBe(true);
    expect(empty.output).toBe("1: ");
  });

  test("reports missing, unreadable, binary, UTF-8, range, and path errors", async () => {
    const repo = await fixture();
    const results = await Promise.all([
      dispatch(repo, {
        name: "read_file",
        input: { path: "missing.txt" },
      }),
      dispatch(repo, {
        name: "read_file",
        input: { path: "binary.bin" },
      }),
      dispatch(repo, {
        name: "read_file",
        input: { path: "src" },
      }),
      dispatch(repo, {
        name: "read_file",
        input: { path: "invalid-utf8.txt" },
      }),
      dispatch(repo, {
        name: "read_file",
        input: {
          path: "src/sample.ts",
          startLine: 999,
        },
      }),
      dispatch(repo, {
        name: "read_file",
        input: {
          path: "src/sample.ts",
          startLine: 1,
          endLine: 999,
        },
      }),
      dispatch(repo, {
        name: "read_file",
        input: { path: "src//sample.ts" },
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
      input: { path: "repeat.txt" },
    });

    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("tokens omitted");
    expect(serializedTokenCount(result, O200K_CODEC)).toBeLessThanOrEqual(4_000);
  });

  test("rejects malformed and symlinked read/search/symbol paths", async () => {
    const repo = await fixture();
    const outsideFile = path.join(repo.root, "outside.ts");
    const outsideDirectory = path.join(repo.root, "outside");
    await writeFile(outsideFile, "export const secret = true;\n");
    await mkdir(outsideDirectory);
    await writeFile(
      path.join(outsideDirectory, "secret.ts"),
      "export const hidden = true;\n",
    );
    await symlink(outsideFile, path.join(repo.worktreePath, "final-link.ts"));
    await symlink(
      path.join(repo.root, "missing.ts"),
      path.join(repo.worktreePath, "dangling.ts"),
    );
    await symlink(outsideDirectory, path.join(repo.worktreePath, "parent-link"));

    const malformedPaths = [
      "",
      ".",
      "/etc/passwd",
      "src\\sample.ts",
      "src//sample.ts",
      "src/./sample.ts",
      "src/../sample.ts",
      "src/\0sample.ts",
    ];
    for (const malformedPath of malformedPaths) {
      const result = await dispatch(repo, {
        name: "read_file",
        input: { path: malformedPath },
      });
      expect(result.metadata?.code).toBe(
        malformedPath === "" ? "INVALID_TOOL_CALL" : "INVALID_PATH",
      );
    }

    for (const protectedPath of [
      ".git",
      ".git/config",
      ".agent/state.json",
      ".agents/policy.md",
      ".codex/config.toml",
    ]) {
      const result = await dispatch(repo, {
        name: "read_file",
        input: { path: protectedPath },
      });
      expect(result.metadata?.code).toBe("PROTECTED_PATH");
    }

    for (const symlinkPath of [
      "final-link.ts",
      "dangling.ts",
      "parent-link/secret.ts",
    ]) {
      const read = await dispatch(repo, {
        name: "read_file",
        input: { path: symlinkPath },
      });
      expect(read.metadata?.code).toBe("SYMLINK_PATH");
    }

    const search = await dispatch(repo, {
      name: "ripgrep",
      input: { pattern: "hidden", path: "parent-link" },
    });
    const symbols = await dispatch(repo, {
      name: "tree_sitter_symbols",
      input: { path: "final-link.ts" },
    });
    expect(search.metadata?.code).toBe("SYMLINK_PATH");
    expect(symbols.metadata?.code).toBe("SYMLINK_PATH");
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
    expect(
      await readFile(path.join(repo.worktreePath, "src/sample.ts"), "utf8"),
    ).toBe(original.replace("Greeter", "Welcomer"));
  });

  test("rejects stale, zero-match, ambiguous, and no-op edits", async () => {
    const repo = await fixture();
    const common = {
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

  test(
    "replaceAll permits multiple matches and creation requires a missing target",
    async () => {
      const repo = await fixture();
      const replace = await dispatch(repo, {
        name: "edit_file",
        input: {
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
          path: "src/new.ts",
          mode: "preview",
          oldText: null,
          newText: "export const created = true;\n",
        },
      });
      const createApply = await dispatch(repo, {
        name: "edit_file",
        input: {
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
    },
    10_000,
  );

  test("blocks protected paths, symlink creation parents, and symlink swaps", async () => {
    const repo = await fixture();
    const outsideDirectory = path.join(repo.root, "outside-edit");
    const outsideFile = path.join(outsideDirectory, "target.ts");
    await mkdir(outsideDirectory);
    await writeFile(outsideFile, "outside\n");
    await symlink(outsideDirectory, path.join(repo.worktreePath, "linked"));

    for (const protectedPath of [
      ".git/config",
      ".agent/state.json",
      ".agents/policy.md",
      ".codex/config.toml",
      "AGENTS.md",
      "CLAUDE.md",
    ]) {
      const result = await dispatch(repo, {
        name: "edit_file",
        input: {
          path: protectedPath,
          mode: "preview",
          oldText: null,
          newText: "poisoned\n",
        },
      });
      expect(result.metadata?.code).toBe("PROTECTED_PATH");
    }

    const linkedCreation = await dispatch(repo, {
      name: "edit_file",
      input: {
        path: "linked/new.ts",
        mode: "preview",
        oldText: null,
        newText: "escaped\n",
      },
    });
    expect(linkedCreation.metadata?.code).toBe("SYMLINK_PATH");
    expect(await readFile(outsideFile, "utf8")).toBe("outside\n");

    const request = {
      path: "src/sample.ts",
      oldText: "Greeter",
      newText: "Changed",
    } as const;
    const preview = await dispatch(repo, {
      name: "edit_file",
      input: { ...request, mode: "preview" },
    });
    const originalPath = path.join(repo.worktreePath, request.path);
    await unlink(originalPath);
    await symlink(outsideFile, originalPath);
    const swapped = await dispatch(repo, {
      name: "edit_file",
      input: {
        ...request,
        mode: "apply",
        baseVersion: String(preview.metadata?.baseVersion),
      },
    });
    expect(swapped.metadata?.code).toBe("SYMLINK_PATH");
    expect(await readFile(outsideFile, "utf8")).toBe("outside\n");

    await unlink(originalPath);
    await writeFile(originalPath, "export class Greeter {}\n");
    const parentPreview = await dispatch(repo, {
      name: "edit_file",
      input: {
        path: "src/sample.ts",
        mode: "preview",
        oldText: "Greeter",
        newText: "Changed",
      },
    });
    await rename(
      path.join(repo.worktreePath, "src"),
      path.join(repo.worktreePath, "src-original"),
    );
    await symlink(outsideDirectory, path.join(repo.worktreePath, "src"));
    const parentSwapped = await dispatch(repo, {
      name: "edit_file",
      input: {
        path: "src/sample.ts",
        mode: "apply",
        oldText: "Greeter",
        newText: "Changed",
        baseVersion: String(parentPreview.metadata?.baseVersion),
      },
    });
    expect(parentSwapped.metadata?.code).toBe("SYMLINK_PATH");
    expect(await readFile(outsideFile, "utf8")).toBe("outside\n");
  });
});

describe("ripgrep", () => {
  test("supports fixed strings, globs, case modes, empty results, and errors", async () => {
    const repo = await fixture();
    const match = await dispatch(repo, {
      name: "ripgrep",
      input: {
        pattern: "GREETER",
        path: "src",
        glob: "*.ts",
        caseSensitive: false,
        fixedString: true,
      },
    });
    const empty = await dispatch(repo, {
      name: "ripgrep",
      input: { pattern: "not-present" },
    });
    const invalid = await dispatch(repo, {
      name: "ripgrep",
      input: { pattern: "[" },
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
      input: { pattern: "needle", path: "repeat.txt" },
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
        cwd: ".",
        command: "echo out; echo err >&2; exit 7",
      },
    });
    const missing = await dispatch(repo, {
      name: "run_shell",
      input: {
        cwd: ".",
        command: "definitely-not-a-real-command",
      },
    });
    const timeout = await dispatch(repo, {
      name: "run_shell",
      input: {
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
        cwd: "../seed",
        command: "pwd",
      },
    });
    const overflow = await dispatch(repo, {
      name: "run_shell",
      input: {
        cwd: ".",
        command: "yes output | head -n 10000",
      },
    });

    expect(invalid.metadata?.code).toBe("INVALID_PATH");
    expect(overflow.truncated).toBe(true);
  });

  test("fast-fails obvious attacks and keeps the next safe tool available", async () => {
    const repo = await fixture();
    const attacks = [
      ["rm -rf /tmp/outside", "SHELL_DESTRUCTIVE_OUTSIDE_ROOT"],
      ["rm --recursive ../seed", "SHELL_DESTRUCTIVE_OUTSIDE_ROOT"],
      ["curl https://example.com", "SHELL_EGRESS_UTILITY"],
      ["wget https://example.com", "SHELL_EGRESS_UTILITY"],
      ["nc example.com 443", "SHELL_EGRESS_UTILITY"],
      ["printf poison > /opt/agent/package.json", "SHELL_RUNTIME_MUTATION"],
      ["printf poison > .git/config", "SHELL_GIT_CONTROL_MUTATION"],
      ["printf poison > /dev/sda", "SHELL_DEVICE_WRITE"],
      ["printf 'bad\0command'", "SHELL_NULL_BYTE"],
    ] as const;

    for (const [command, code] of attacks) {
      const result = await dispatch(repo, {
        name: "run_shell",
        input: { cwd: ".", command },
      });
      expect(result).toMatchObject({
        success: false,
        metadata: { code },
      });
    }

    const safe = await dispatch(repo, {
      name: "read_file",
      input: { path: "src/sample.ts" },
    });
    expect(safe.success).toBe(true);
  });

  test("uses an allowlisted non-login environment without inherited injection", async () => {
    const repo = await fixture();
    const injected = {
      CODEX_SAFETY_TEST_SECRET: "must-not-leak",
      GIT_CONFIG_COUNT: "99",
      BUN_OPTIONS: "--smol",
      NODE_OPTIONS: "--trace-warnings",
      LD_PRELOAD: "/tmp/evil.so",
      PYTHONPATH: "/tmp/evil-python",
      ENV: "/tmp/evil-profile",
    };
    const previous = Object.fromEntries(
      Object.keys(injected).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, injected);
    try {
      const result = await dispatch(repo, {
        name: "run_shell",
        input: { cwd: ".", command: "env" },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain("PATH=/usr/local/bin:/usr/bin:/bin");
      expect(result.output).toContain("HOME=/tmp/runner-home");
      expect(result.output).toContain(
        `TASK_ROOT=${await realpath(repo.worktreePath)}`,
      );
      for (const [key, value] of Object.entries(injected)) {
        expect(result.output).not.toContain(key);
        expect(result.output).not.toContain(value);
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("does not treat lexical policy as proof of arbitrary shell safety", async () => {
    const repo = await fixture();
    const decision = await defaultPreToolUse(
      {
        name: "run_shell",
        input: {
          cwd: ".",
          command:
            "python -c 'import base64;print(base64.b64decode(\"Y3VybA==\"))'",
        },
      },
      { worktreeRoot: repo.worktreePath },
    );
    expect(decision).toEqual({ outcome: "allow" });
  });
});

describe("git", () => {
  test("reports clean/dirty state and staged, unstaged, path-scoped diffs", async () => {
    const repo = await fixture();
    const clean = await dispatch(repo, {
      name: "git",
      input: { subcommand: "status" },
    });
    await repo.write("src/sample.ts", `${await readFile(path.join(repo.worktreePath, "src/sample.ts"), "utf8")}// changed\n`);
    const dirty = await dispatch(repo, {
      name: "git",
      input: { subcommand: "status" },
    });
    const diff = await dispatch(repo, {
      name: "git",
      input: {
        subcommand: "diff",
        path: "src/sample.ts",
      },
    });
    await dispatch(repo, {
      name: "run_shell",
      input: {
        cwd: ".",
        command: "git add src/sample.ts",
      },
    });
    const staged = await dispatch(repo, {
      name: "git",
      input: {
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

  test("fails an empty commit, commits addAll with a SHA, and rejects push", async () => {
    const repo = await fixture();
    const empty = await dispatch(repo, {
      name: "git",
      input: {
        subcommand: "commit",
        message: "nothing",
        addAll: false,
      },
    });
    await repo.write("new.txt", "new\n");
    const commit = await dispatch(repo, {
      name: "git",
      input: {
        subcommand: "commit",
        message: "add new file",
        addAll: true,
      },
    });
    const push = await dispatchTool(
      {
        name: "git",
        input: {
          subcommand: "push",
          remote: repo.bareRemotePath,
          branch: "agent-step2",
        },
      },
      { worktreeRoot: repo.worktreePath },
    );

    expect(empty.success).toBe(false);
    expect(commit.success).toBe(true);
    expect(String(commit.metadata?.sha)).toMatch(/^[0-9a-f]{40}$/);
    expect(push.metadata?.code).toBe("INVALID_TOOL_CALL");
  });

  test("disables repository-controlled hooks, signing, pagers, and external diffs", async () => {
    const repo = await fixture();
    const sentinel = path.join(repo.root, "git-program-ran");
    const probe = path.join(repo.root, "probe.sh");
    const hooks = path.join(repo.root, "hooks");
    await mkdir(hooks);
    await writeFile(
      probe,
      `#!/bin/sh\nprintf 'executed\\n' >> '${sentinel}'\nexit 0\n`,
    );
    await chmod(probe, 0o755);
    await writeFile(path.join(hooks, "pre-commit"), await readFile(probe));
    await chmod(path.join(hooks, "pre-commit"), 0o755);
    await configureGit(repo, "core.hooksPath", hooks);
    await configureGit(repo, "commit.gpgSign", "true");
    await configureGit(repo, "gpg.program", probe);
    await configureGit(repo, "core.pager", probe);
    await configureGit(repo, "diff.external", probe);
    await configureGit(repo, "credential.helper", `!${probe}`);

    await repo.write(".gitattributes", "*.ts diff=hostile\n");
    await configureGit(repo, "diff.hostile.command", probe);
    await repo.write(
      "src/sample.ts",
      `${await readFile(path.join(repo.worktreePath, "src/sample.ts"), "utf8")}// hardened\n`,
    );

    const injected = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: hooks,
      GIT_EXTERNAL_DIFF: probe,
      GIT_PAGER: probe,
    };
    const previous = Object.fromEntries(
      Object.keys(injected).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, injected);
    try {
      const status = await dispatch(repo, {
        name: "git",
        input: { subcommand: "status" },
      });
      const diff = await dispatch(repo, {
        name: "git",
        input: { subcommand: "diff", path: "src/sample.ts" },
      });
      const commit = await dispatch(repo, {
        name: "git",
        input: {
          subcommand: "commit",
          message: "test: verify hardened git",
          addAll: true,
        },
      });
      expect(status.success).toBe(true);
      expect(diff.success).toBe(true);
      expect(commit.success).toBe(true);
      expect(await Bun.file(sentinel).exists()).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("caps a large diff", async () => {
    const repo = await fixture();
    await repo.write("repeat.txt", "changed\n".repeat(8_000));
    const result = await dispatch(repo, {
      name: "git",
      input: {
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
      input: { path: file },
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
      input: { path: "src/broken.py" },
    });
    const unsupported = await dispatch(repo, {
      name: "tree_sitter_symbols",
      input: { path: "repeat.txt" },
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
      input: { path: "src/many.py" },
    });

    expect(result.truncated).toBe(true);
    expect(serializedTokenCount(result)).toBeLessThanOrEqual(4_000);
  });
});
