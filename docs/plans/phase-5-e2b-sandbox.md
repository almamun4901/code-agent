# Phase 5 — E2B sandbox and per-task worktrees

**Status:** Acceptance, review, documentation, commits, and push passed on
`feat/e2b-sandbox`; merge and merged-main verification remain.

## Outcome

The six-tool MCP server runs inside one short-lived E2B sandbox per task. The
host creates an exact clean Git bundle, uploads it with a strict provisioning
configuration, and receives a branch-backed worktree at
`/workspace/tasks/<task-id>`. Tool calls mutate only that remote worktree.

```text
Host
  └─ E2bTaskSession
      ├─ exact clean Git bundle
      ├─ owned sandbox lifecycle
      └─ McpToolClient
          └─ E2bStdioTransport
              └─ six-tool MCP server in /opt/agent
                  └─ task worktree in /workspace/tasks
```

## Implemented boundaries

- `E2bStdioTransport` frames MCP JSON-RPC with the SDK `ReadBuffer` and
  `serializeMessage`, serializes concurrent writes, separates bounded stderr,
  fails closed on malformed output or process loss, and never reconnects.
- `createE2bTaskSession` validates a clean absolute repository root, exact base
  revision, safe task ID, template reference, and timeout before provisioning.
- The pinned template contains Bun 1.3.14, Git, ripgrep, production
  dependencies, Tree-sitter WASM assets, the server, and a non-secret runtime
  manifest. Runtime execution uses the unprivileged `user`.
- Repository intake uses an argument-array Git bundle flow. The in-sandbox
  provisioner receives fixed paths plus strict JSON and performs no
  user-controlled shell interpolation.
- Session close coalesces client/process/sandbox cleanup. Ambiguous create
  failures use a unique metadata token to find and terminate only their own
  orphaned sandbox.
- `E2B_API_KEY` remains host-only. Template builds upload only
  `package.json`, `bun.lock`, and `src/`.

## Acceptance evidence

| Gate | Result |
|---|---|
| TypeScript | pass |
| Complete offline suite | 121 pass, 3 opt-in tests skipped, 0 fail |
| Focused sandbox suite | 24 pass, 0 fail |
| Live MCP transport | 1 pass, including process-loss failure without retry |
| Live six-tool isolation | 1 pass, 25 assertions |
| Host sentinel | randomized absolute host path and content unreachable |
| Positive control | remote marker created and read through real tools |
| Host mutation check | fixture and project status unchanged |
| Cleanup | zero running E2B sandboxes after each live gate |

## Rework discovered by live testing

- The base image switched to an unprivileged user before `/opt/agent` existed.
  Template setup now runs as root and restores `user` after ownership transfer.
- `/workspace/tasks` was initially absent and unwritable. It is now created and
  assigned during the image build.
- A truncated E2B create response produced an orphan without returning a
  handle. Creation metadata now supports exact failure reconciliation without
  retrying creation.
- E2B process-list command text was not stable enough for fault injection.
  The session exposes its transport-owned PID as read-only state.
- Newline-terminated files include a numbered trailing empty line in the
  canonical `read_file` result; live assertions now match the existing tool
  contract.
- A normal macOS Terminal lacked the Codex application's bundled ripgrep.
  Manual verification now performs an immediate dependency preflight.

## Deferred

- `PreToolUse` remains a no-op seam. Destructive command policy, traversal,
  symlink, and environment defenses are Step 6.
- Real tools are not exposed to a live model.
- Mutation replay and reconciliation remain the ADR 0009 prerequisite for a
  later live-model real-tool run.
- StreamableHTTP, pause/resume, remote-first repository intake, and GitHub
  credential delivery remain out of scope.
