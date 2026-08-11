# Mutation Recovery Prerequisite

**Status:** complete and verified.

## Outcome

Prevent a host crash, MCP disconnect, or cancellation from silently replaying a
mutating tool or losing repository state from prior committed turns.

## Recovery contract

```text
host lease (mode 0600)             sandbox journal (mode 0600)
  sandbox / run identity             operation ID / input hash
  server PID / worktree              in_flight -> completed result
              \                      /
               \---- reconciliation /
```

- `edit_file` apply, `run_shell`, and Git commit receive operation IDs.
- The host lease is durable before a mutating MCP request is sent.
- The sandbox journal is durable before policy or execution starts.
- An identical terminal operation returns its recorded result.
- A missing, mismatched, or in-flight operation is never replayed.
- Host restart reconnects the same E2B sandbox and preserves its worktree.
- Cancellation reaches child processes and becomes a terminal `CANCELLED`
  result.
- Clean close kills the sandbox before clearing the host lease.
- Approved viewport verification uses the same host operation ID and lease.
  Recovery cancels its browser/server process group and records a terminal
  cancelled result instead of inventing or duplicating screenshot evidence.
- Delivery failure after evidence collection preserves the sandbox and the
  `finalizing` checkpoint. Restart resumes delivery without replaying a tool or
  making another model call.

Read-only calls, edit previews, and Git status/diff do not create mutation
records.

## Acceptance matrix

- Strict atomic journal round trips, mode 0600, and corrupt-state rejection.
- Start-before-execute and terminal-result ordering.
- Same operation ID executes once and returns the cached canonical result.
- A concurrent or ambiguous mutation fails closed.
- Completed host/sandbox records reconnect the same worktree.
- Missing, mismatched, and in-flight remote records do not replay.
- Abort kills an in-flight shell process and journals `CANCELLED`.
- Existing MCP direct-call parity, safety, sandbox, and checkpoint suites remain
  green.
- Live E2B cancellation/reconnection leaves zero orphaned sandboxes.

## Completion evidence

- `bun run test:manual:local`: 150 passed, 5 opt-in tests skipped, 0 failed.
- `bun run test:mcp`: 15 passed, 0 failed.
- `bun run test:sandbox`: 33 passed, 0 failed.
- `bun run test:safety`: 4 passed, 0 failed.
- `bun run test:e2b:integration`: 4 passed, 0 failed, including real
  cancellation and same-sandbox reconnection.
- E2B template:
  `terminal-coding-agent-tools:mutation-recovery-v1`, build
  `df4953b4-b43b-4109-b257-d3dd67485e44`.
- The E2B account reported no running sandboxes before or after the final live
  gate.

## Deferred

The production model/tool loop consumes this recovery boundary in the separate
headless-runtime prerequisite. External publication remains host-owned; Step 8
owns the remaining hooks and budget ceilings.
