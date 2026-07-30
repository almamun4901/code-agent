# 0014 — Checkpoint production tool intent before execution

**Date:** 2026-07-30
**Status:** accepted

## Context

The production runner joins the routed model, durable plan, E2B MCP client,
and mutation-recovery lease. A host interruption after model validation but
before checkpoint installation could otherwise lose token accounting, while
an interruption during a mutation could cause a replacement turn to invent a
new operation ID.

Free routed models also emit either a plan and action together or sequential
plan-only and action-only responses. Requiring parallel tool calls would
exclude a verified provider route without adding safety.

## Decision

Persist every validated assistant turn, proposed plan, exact tool request, and
host-generated operation ID as a pending turn before calling MCP. Commit the
plan, tool result, transcript, and usage only after the action reaches a
terminal result.

Allow a plan rewrite with zero or one action and allow subsequent one-action
responses against the last committed incomplete plan. Plan revisions are
bounded to 20 tasks, require an active task while incomplete, and may advance
completed-task accounting by one only after a successful tool observation.

## Alternatives considered

- **Require plan and action in one model response** — rejected because the
  verified free route emits them sequentially.
- **Generate operation IDs only inside MCP** — rejected because a host restart
  could not correlate the pending model turn with a completed sandbox
  mutation.
- **Commit the new plan before its action finishes** — rejected because the
  checkpoint and terminal UI would claim progress without an observation.
- **Freeze the initial task list** — rejected because a coding agent must
  revise its full plan as repository evidence changes.

## Consequences

- Resumption reuses the exact mutation operation ID and same E2B worktree.
- Read-only pending actions may repeat after a hard host kill; completed
  actions and all committed turns do not replay.
- Provider-native sequential tool calling adds model turns but keeps each
  checkpoint and action boundary explicit.
- The Step 7 observation event can emit `plan_committed` only after the final
  checkpoint save returns.

## Revisit when

Revisit if the provider boundary guarantees parallel ordered tool calls, MCP
adds a durable server-issued transaction identity, or production evaluation
shows that count-based plan honesty is insufficient.
