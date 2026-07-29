# 0011 — Pinned E2B runtime with Git-bundle task intake

**Date:** 2026-07-28
**Status:** accepted

## Context

Step 5 must execute the existing six-tool MCP server outside the host while
reproducing an exact local Git revision. E2B's default image has Node and Git
but lacks Bun and ripgrep. Remote cloning would also introduce credentials and
branch drift. A streamed remote stdio process can fail ambiguously, including
after E2B has created a sandbox but before returning its handle.

## Decision

Use one secure E2B sandbox per task, a pinned custom Bun template, and a clean
Git bundle uploaded from the host. Provision one branch-backed worktree under
`/workspace/tasks`, run the unchanged MCP dispatcher over a custom streamed
stdio transport, kill resources on close or timeout, and never retry an
ambiguous tool call. Tag each create request with a unique ID so a failed
create response can reconcile only its own orphaned sandbox.

## Alternatives considered

- **Clone a remote repository** — rejected because it requires repository
  credentials and can resolve a different revision from the requested base.
- **Use E2B's default image** — rejected because the verified image lacks Bun
  and ripgrep.
- **Bring StreamableHTTP forward** — deferred because the stdio transport
  passed framing, lifecycle, live handshake, and process-loss gates.
- **Pause and resume sandboxes** — deferred; Step 5 uses short-lived
  kill-on-close sessions with explicit checkpointing remaining on the host.

## Consequences

- The host keeps E2B, model, and Git-provider credentials and performs no
  repository tool execution.
- Template builds upload only `package.json`, `bun.lock`, and `src/`.
- Ordinary tests remain offline; live tests require three explicit settings.
- Every task starts from an exact clean commit but uncommitted host work is
  intentionally rejected rather than copied.
- Template updates and E2B API behavior are operational dependencies.
- Symlink, traversal, shell-policy, and environment attacks remain Step 6.

## Revisit when

Revisit remote stdio if framing or long-lived stdin becomes unreliable in two
independent live runs, if create-failure reconciliation cannot prevent orphaned
sandboxes, or if Step 6 finds an isolation gap that the E2B runtime cannot
close. Bring StreamableHTTP forward only at one of those triggers.
