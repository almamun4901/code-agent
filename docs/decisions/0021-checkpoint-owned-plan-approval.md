# 0021 — Checkpoint-owned plan approval

**Date:** 2026-08-03
**Status:** accepted

## Context

The production loop currently exposes mutation-capable tools on its first
model turn. The TUI can display a committed todo plan, but it cannot let a user
correct product choices before implementation, and UI state would not survive
a process crash. Non-interactive evaluations still need a deliberate way to
run without a human prompt.

## Decision

Add a discovery/approval phase to the production checkpoint. Discovery uses a
separate protocol containing only bounded read tools and a structured
`propose_plan` tool. The runtime checkpoints the exact proposal and waits on an
injected approve/revise/cancel port. Mutation tools are both absent from model
requests and denied by a host phase guard until the approved proposal digest is
durable. Protected proposal changes during execution use the same approval
transition. Headless auto-approval is explicit and follows the same persisted
state transitions.

## Alternatives considered

- **Prompt only in Ink** — simple, but loses authority and recovery when the
  terminal or process exits.
- **Show the ordinary todo list for approval** — hides design, dependency,
  scope, assumption, and acceptance choices that users need to correct.
- **Expose all tools and instruct the model not to mutate** — makes policy
  depend on model compliance and malformed/recovered turns.
- **Default headless runs to auto-approve** — creates an unsafe behavioral
  difference whenever output stops being attached to a human TTY.

## Consequences

The production loop gains a second bounded protocol and checkpoint invariants,
and the CLI/controller gains a typed decision channel. Recovery can render the
same proposal without another paid call. Evaluation remains unattended through
explicit auto mode. Materiality enforcement is limited to changes in the
structured protected proposal fields; it does not claim perfect semantic
classification of arbitrary model text.

## Revisit when

Revisit if approval moves to an authenticated remote service, multiple human
approvers are required, or policy expands to per-tool authorization.
