# 0006 — Introduce OpenRouter at the live real-tool boundary

**Date:** 2026-07-26
**Status:** superseded by 0015

## Context

ADR 0002 required OpenRouter immediately after Step 1 and before Step 2.
Step 2 now deliberately verifies six tools and their dispatcher through
deterministic calls against disposable local worktrees. It does not expose
those tools to a model. Making a model-provider migration a Step 2 prerequisite
would combine two unrelated unknowns and contradict the risk-sequenced build
order.

## Decision

OpenRouter does not block Steps 2–6. Keep the stable provider-neutral
`callModel()` contract, and introduce OpenRouter after the sandbox and
PreToolUse guard are verified, before the first live-model run with real tools
or the Step 7 TUI, whichever comes first.

## Alternatives considered

- **Keep OpenRouter before Step 2** — rejected because deterministic tool
  correctness has no model-provider dependency.
- **Defer OpenRouter until the final eval** — rejected because the TUI and
  production loop should be exercised against the final provider boundary
  before Step 10.

## Consequences

- Steps 2–6 remain attributable to tool, transport, sandbox, and policy
  behavior without adding provider normalization failures.
- The existing `callModel()` boundary must remain provider-neutral.
- No live model may receive the real tool surface before OpenRouter, E2B, and
  the PreToolUse guard are all in place.

## Revisit when

Superseded by ADR 0015 after the OpenRouter boundary was implemented and
verified, but its free-model quota could not support continued Step 7
development.
