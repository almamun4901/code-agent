# 0013 — Recover mutating calls in their owned E2B session

**Date:** 2026-07-30
**Status:** accepted

## Context

ADR 0009 allows an interrupted uncommitted tool to replay, which is safe for
the Phase 1 read fixture but unsafe for `edit_file`, `run_shell`, and Git
commit. Rebuilding a fresh sandbox would also discard mutations from earlier
committed turns. Repository snapshots alone cannot describe arbitrary shell
effects or staged Git state.

## Decision

Give every mutating MCP request a host-generated operation ID. The sandbox
atomically records that ID, a hash of the validated input, and `in_flight`
before policy or execution, then stores the canonical `ToolResult` as
`completed`. Identical completed requests return the recorded result instead of
executing twice; a second or ambiguous in-flight mutation is rejected.

The host separately persists the owned sandbox ID, MCP server PID, worktree,
base revision, run identity, and active mutation. After a host restart it
reconnects the same sandbox, verifies the pinned runtime and both journal
records, and restarts MCP on the preserved worktree. A completed mutation is
returned to the runtime; a missing, mismatched, or still-in-flight result fails
closed and is never replayed automatically.

Cancellation propagates through MCP to tool child processes. A cancelled
mutation is killed and journaled as a terminal `CANCELLED` result before normal
session cleanup. In E2B, the fixed root-owned wrapper terminates the sandbox's
isolated `runner` identity so descendants cannot keep the request ambiguous
after the MCP caller aborts.

Cancellation can also arrive after the host lease is written but before the
remote server accepts the request. Reconciliation sends a read-only barrier
through the same serialized MCP execution queue. If the barrier completes and
the remote journal is provably absent, every earlier request has drained and
the mutation is durably completed as `CANCELLED` without execution. A missing
journal without that proof remains ambiguous and fails closed.

## Alternatives considered

- **Replay every mutation in a fresh sandbox** — rejected because arbitrary
  shell behavior is not idempotent and earlier committed work would be lost.
- **Kill the old sandbox and resume from the base commit** — rejected because
  the checkpoint would claim effects that no longer exist.
- **Snapshot only Git diffs** — rejected because it loses staged state,
  untracked files, and shell-created repository artifacts.
- **Retry transport failures by default** — rejected because an MCP disconnect
  does not prove the remote mutation did not run.

## Consequences

- Recovery preserves the exact worktree used by prior committed turns.
- Journal files are strict, atomic, mode 0600, and fail closed on corruption.
- An ambiguous operation may require operator inspection instead of automatic
  progress; safety is preferred to duplicate mutation.
- The serialized read-only barrier closes the host-written/remote-accepted
  cancellation race without treating transport failure or an unreadable
  journal as proof that no mutation ran.
- This contract relies on the Step 6 boundary: sandbox internet is disabled,
  Git push is unavailable, and tool side effects stay inside the owned E2B
  session.
- A clean session close kills the sandbox before clearing the host lease.

## Revisit when

Revisit if tools gain external side effects, Git publication moves into the
sandbox, E2B can no longer reconnect by sandbox ID, or a durable remote task
protocol can provide stronger exactly-once semantics.
