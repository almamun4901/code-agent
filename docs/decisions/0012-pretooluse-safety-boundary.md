# 0012 — Bind model tools to a structurally confined task boundary

**Date:** 2026-07-29
**Status:** accepted

## Context

Step 5 isolates one clean task worktree in E2B, but the model-visible tools
still accept a repository path, the runtime and workspace share one Unix
identity, shell children inherit the server environment, Git can push, and
typed file access can follow symlinks. A poisoned repository can instruct the
model to exploit any of those surfaces.

Arbitrary shell cannot be made safe by parsing every possible command. The
policy hook must reject obvious attacks without being mistaken for the
security boundary.

## Decision

Bind every model-visible tool request to one immutable canonical worktree and
serialize executions. Use structured `PreToolUse` allow/deny decisions for
early diagnostics, while Unix identities and permissions, symlink-safe typed
access, descendant cleanup, and E2B internet denial provide confinement.

Run the MCP server and typed tools as `agent`; run arbitrary shell through one
root-owned wrapper that permanently drops to `runner`. Keep `/opt/agent` and
linked-worktree Git metadata unavailable to `runner`. Remove Git push from the
sandbox tool surface; final publication remains host-owned.

## Alternatives considered

- **Shell allowlist or comprehensive parser** — rejected because legitimate
  build/test commands are open-ended and shell equivalents can bypass lexical
  rules.
- **One unprivileged Unix user** — rejected because Git commits need linked
  metadata outside the worktree while arbitrary shell must not modify that
  metadata or the MCP runtime.
- **Network command denylist** — rejected as the boundary because Python,
  Node, raw sockets, DNS, and encoded commands bypass utility-name checks.
- **Keep model-supplied `repoPath` with parent containment** — rejected because
  the task root is session configuration, not model input.

## Consequences

- Policy denials are legible, but structural controls still hold when lexical
  policy misses an encoded or alternate command.
- Sandboxed tasks cannot install packages or run network-dependent tests in
  v1; any future egress allowlist requires its own review.
- Typed paths that traverse symlinks are rejected, including legitimate
  symlinked layouts.
- Ordinary task content remains deletable. The disposable bundle is the
  recovery source.
- Git status, diff, staging, and commit remain available without repository
  hooks, credential helpers, signing, external diffs, pagers, or push.
- ADR 0009 still blocks live-model mutation until a separate reconciliation
  branch lands.

## Revisit when

Revisit network denial if the Step 10 evaluation proves offline task
environments materially reduce pass rate, or revisit symlink rejection if the
selected benchmark contains required symlinked source layouts. Preserve exact
task-root binding, credential isolation, and host-owned publication in either
case.
