# 0017 — Coordinate session shutdown exactly once

**Date:** 2026-07-30
**Status:** accepted

## Context

Ctrl-C can arrive during a model request, policy check, read-only tool,
mutation, or checkpoint installation. Immediate process exit can lose mutation
truth, skip sandbox cleanup, orphan E2B resources, and fire `SessionEnd`
multiple times.

## Decision

Use one idempotent `AgentRunController` shutdown promise. Mark shutdown,
propagate abort, await mutation reconciliation, close MCP and E2B resources,
invoke injectable `SessionEnd` once after cleanup with a five-second bound,
publish the terminal event, then let the CLI unmount and restore the terminal.
Bound the complete shutdown phase at 30 seconds.

## Alternatives considered

- **Exit immediately on repeated Ctrl-C** — bypasses reconciliation and can
  orphan a sandbox.
- **Let Ink own resources** — couples React lifecycle and renderer failures to
  production execution.
- **Treat abort as mutation failure** — cannot distinguish a mutation that
  completed remotely before transport cancellation.

## Consequences

Cancellation takes as long as safe reconciliation requires and returns the
same result to every caller. Completion exits 0, user cancellation 130,
invalid command usage 2, and runtime or cleanup failure 1. A hung shutdown is
reported as failure after 30 seconds rather than silently appearing complete.
The runner never releases sandbox ownership merely because the deadline has
elapsed: reconciliation and cleanup still reach a terminal result before the
controller resolves.

## Revisit when

The sandbox provider supplies a stronger transactional cancellation primitive
that proves mutation outcome and resource closure atomically.
