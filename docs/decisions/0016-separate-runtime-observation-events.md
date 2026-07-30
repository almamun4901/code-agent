# 0016 — Separate runtime observation events from lifecycle hooks

**Date:** 2026-07-30
**Status:** accepted

## Context

The terminal interface needs live plan, tool, usage, and shutdown state, but
rendering must not influence model, tool, checkpoint, or sandbox behavior.
Step 8 will add hooks that can intentionally control execution, so using the
same interface for both concerns would blur the trust boundary.

## Decision

Publish a permanent typed `AgentEvent` observation stream with monotonic
sequence numbers and timestamps. Deliver cloned events asynchronously, ignore
sink failures, expose only allowlisted 2 KiB tool summaries, and keep this
observation plane separate from lifecycle hooks.

## Alternatives considered

- **React watches `.agent/state.json`** — introduces filesystem races and
  exposes pending persistence details instead of durable runtime truth.
- **Use lifecycle hooks as UI events** — lets renderer behavior accidentally
  delay, fail, or control execution.
- **Expose raw model and tool payloads** — leaks prompts, commands, search
  strings, and potentially secrets into terminal history.

## Consequences

Any interface can observe the runner without owning it. The runtime must
maintain a small stable event contract and safe-summary allowlist. Step 8 can
add control hooks without changing TUI state reduction.

## Revisit when

A non-terminal observer demonstrates that the event contract cannot represent
a durable runtime transition without reading persistence or raw payloads.
