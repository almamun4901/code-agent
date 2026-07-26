# 0004 — Validate an entire model turn before applying any side effect

**Date:** 2026-07-25
**Status:** accepted

## Context

Step 1 requires the model to rewrite the full plan and request a fake
`read_file` action in the same response. Model output is an untrusted boundary:
the response can omit the plan, mutate task identity, reorder calls, provide a
wrong path, or emit multiple actions. Retrying after partially applying such a
response could duplicate tool execution or leave plan state inconsistent.

## Decision

Use two strict client tools, `rewrite_plan` followed by at most one
`read_file`. Validate the entire response locally before mutating plan state or
executing the fake tool. Reject invalid turns atomically, retry once per logical
turn, then abort on a second violation.

Every accepted tool call receives an ordered result with the original
`tool_use_id`. Local validation requires exact keys even though Anthropic also
enforces strict remote schemas.

Rejected assistant content is never appended to the provider transcript. The
retry adds only a user correction to the last valid transcript state. This
avoids both trusting rejected state and replaying unresolved `tool_use` blocks
without the provider-required `tool_result` blocks.

The provider-facing schemas use only Anthropic's supported strict-output JSON
Schema subset. Semantic constraints that the provider does not support (for
example an exact three-item plan) are stated in tool descriptions and enforced
by the same exact local validator.

The first user message includes the authoritative initial plan, including
canonical task IDs and descriptions. Instructions must describe transitions in
the validator's terms: at most one task completion per turn, with the next task
moving to `in_progress` in the same rewrite when work remains.

## Alternatives considered

- **Parse plan JSON from prose** — rejected because it creates a second,
  weaker response format and makes tool-call correlation harder.
- **Apply `rewrite_plan` before validating `read_file`** — rejected because a
  later-invalid action would leave partial state behind.
- **Rely only on Anthropic strict schemas** — rejected because the loop's trust
  boundary must remain correct when tests, OpenRouter, or another provider
  supplies responses.
- **Retry indefinitely** — rejected because it hides prompt defects and creates
  an uncontrolled cost loop.

## Consequences

- Invalid model output has no side effects and is safe to retry once.
- The loop owns semantic invariants while the adapter owns provider
  translation.
- Wire-schema compatibility cannot weaken application validation; exact task
  count, identity, ordering, paths, and state transitions remain local
  invariants.
- The two-tool protocol is more explicit but asks the model to emit multiple
  tool calls in one response.
- Step 2 can replace only the fake executor without weakening turn validation.

## Revisit when

Revisit after OpenRouter is introduced if a supported provider cannot reliably
emit the ordered two-tool response. Preserve atomic validation even if the
wire-level response shape changes.
