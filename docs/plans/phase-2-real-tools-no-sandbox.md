# Phase 2 Plan — Real Tools, No Sandbox

**Status:** complete; verified 2026-07-26.

## Outcome

Implement `read_file`, `edit_file`, `ripgrep`, `tree_sitter_symbols`,
`run_shell`, and `git` as typed local functions behind one transport-neutral
dispatcher. Verify them against disposable git worktrees and cap every
serialized result at 4,000 tokens under the pinned offline codec.

This phase proves tool correctness and truncation. It does not expose real
tools to a model, provide structural isolation, implement destructive-command
policy, add MCP, or perform real network operations.

## Architecture

```text
deterministic test call
        |
        v
dispatchTool(call, context)
        |
        +--> beforeToolUse()       # no-op seam; Step 6 implements policy
        |
        +--> typed tool executor
        |
        +--> typed error capture
        |
        +--> finalizeResult()      # serialized result <= 4,000 tokens
        v
ToolResult
```

The dispatcher owns routing, policy interception, error normalization, and
final result truncation. Tool implementations own only their operation. MCP
in Step 4 wraps this dispatcher without changing tool behavior.

## Shared contracts

- `ToolCall` is a discriminated union covering all six tools.
- `ToolResult` contains `success`, `output`, `truncated`,
  `originalTokenCount`, and bounded operation-specific metadata.
- Tool implementations throw typed errors. The dispatcher converts them into
  visible error results and applies the same token cap to success and failure.
- `repoPath` is explicit. File paths and shell working directories are
  repo-relative.
- Real input validation rejects absolute child paths, empty path segments, and
  lexical `..` traversal.
- The test harness separately refuses any `repoPath` or resolved shell cwd
  outside its per-test temporary root. This is disposable development
  scaffolding, not a sandbox or adversarial security control.
- Truncation uses an injectable codec, pinned to `o200k_base` for this phase.
  It preserves a bounded head and tail plus an omission marker, with the final
  serialized result, metadata and marker included, at or below 4,000 tokens.

## Tool contracts

### `read_file`

Read a UTF-8 file, optionally by an inclusive line range, and return numbered
text. Missing, unreadable, binary, invalid-range, and overflow behavior must be
explicit.

### `edit_file`

Use two modes:

- `preview` computes an exact replacement or file creation without writing,
  returning a unified diff, match count, proposed hash, and `baseVersion`
  (`missing` or the current SHA-256).
- `apply` repeats the edit specification and requires the previewed
  `baseVersion`. Reject a stale version before writing.

With `replaceAll: false` or omitted, exactly one `oldText` match is required;
zero or multiple matches are errors. With `replaceAll: true`, one or more
matches are intentionally replaced and are not ambiguous. A creation request
requires the target to be missing.

### `ripgrep`

Invoke `rg` with an argument array, never interpolated shell text. Support a
pattern, optional path/glob, case mode, and fixed-string mode. Exit 1 is a
successful empty result; higher exit codes are failures.

### `tree_sitter_symbols`

Return symbol kind, name, and source range for Python, TypeScript/TSX, and
JavaScript/JSX functions, classes, methods, and declarations. Report
unsupported extensions and whether parsing recovered from syntax errors.

### `run_shell`

Require explicit `repoPath` and repo-relative cwd. Execute through
`/bin/sh -lc` with bounded timeout and raw-output buffer, returning stdout,
stderr, and exit code. Step 2 exercises only benign local commands.

### `git`

Expose one discriminated tool:

- `status`: required `repoPath`; return porcelain output, branch, and `clean`.
- `diff`: required `repoPath`; optional `staged` and path.
- `commit`: required message and explicit `addAll`; return the commit SHA.
- `push`: required remote and branch.

Push tests target only a temporary local bare repository. No real remote is
used.

## Implementation order

1. Complete the Step 1 live acceptance gate and status updates.
2. Add the shared token codec, result finalizer, contracts, typed errors, and
   no-op policy seam.
3. Add the temporary repository harness: seed repository, per-test disposable
   worktree, local bare remote, containment assertion, and unconditional
   cleanup.
4. Implement and test `read_file`, establishing the overflow contract.
5. Implement `ripgrep`, including a large-match overflow case.
6. Implement `edit_file` and `git`, sharing diff-output conventions.
7. Implement `run_shell` with timeout and output bounds.
8. Implement `tree_sitter_symbols`; prove Bun compatibility before committing
   to native bindings, falling back to pinned WASM grammars if needed.
9. Route all tools through the dispatcher, run the complete verification
   matrix, and update project documentation.

## Test and acceptance matrix

- Shared finalizer: below limit, exact boundary, code/non-ASCII overflow,
  head/tail marker, metadata included in cap, capped error output.
- Dispatcher: every route, unknown/malformed call, policy ordering, typed
  failure conversion, no execution after validation failure.
- Harness: worktree and bare remote are disposable; actual project unchanged;
  outside-root repo/cwd rejection is tested separately from lexical traversal.
- Read: full/ranged, empty, missing, binary, range past EOF, overflow.
- Edit: side-effect-free preview, apply, stale version, zero/ambiguous match,
  `replaceAll` multiple match, creation, no-op, overflow.
- Ripgrep: matches, no matches, invalid regex, fixed string, glob/path,
  large-match overflow.
- Symbols: all supported dialects, nested symbols, malformed source,
  unsupported extension, overflow.
- Shell: stdout/stderr, nonzero exit, command-not-found, timeout, invalid cwd,
  output overflow.
- Git: clean/dirty status, staged/unstaged/path diff, diff overflow, empty
  commit failure, `addAll` commit plus SHA verification, local push success,
  wrong branch/remote failure.

Step 2 is complete only when all six tools run through the dispatcher against
a real disposable repository, every serialized result respects the 4,000-token
cap, all offline/type/regression gates pass, and no live model or real network
operation was used.

## Implementation record

Implemented with a runtime-validated `ToolCall` union, typed execution errors,
one dispatcher and policy seam, disposable git worktrees, and a shared result
finalizer. Native Tree-sitter bindings failed to compile under the installed
Bun/Node toolchain, so symbol extraction uses pinned `web-tree-sitter` 0.20.8
with pinned WASM grammars as recorded in ADR 0008.

Verification evidence:

- Explicit Step 1 live gate: pass; repository state unchanged.
- `bun run typecheck`: pass.
- `bun test`: 65 pass, 1 opt-in live test skipped, 0 fail.
- `bun run loop-fake.ts`: pass; 4 turns, 3/3 tasks, 1 recovery.
- Full offline gate plus Step 0 regression: repository state unchanged.
- Step 2 suite: 27 tests covering every tool route, finalizer, dispatcher,
  development containment, local commit, and local bare-remote push.
- Pre-landing review: one runtime-validation gap found and fixed; no unresolved
  findings.

## Explicitly deferred

- Live-model access to real tools: after OpenRouter, E2B, and PreToolUse.
- MCP transport: Step 4.
- Structural host isolation: Step 5.
- Symlink escape, destructive-command, environment-trick, and adversarial
  traversal defenses: Step 6.
- Real remote push: Step 10.
