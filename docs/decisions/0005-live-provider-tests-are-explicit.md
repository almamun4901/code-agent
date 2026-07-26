# 0005 — Live provider tests are explicit and excluded from the offline suite

**Date:** 2026-07-25
**Status:** accepted

## Context

The Phase 1 acceptance gate requires a real Anthropic call, but ordinary unit
tests must remain deterministic, fast, free, and safe to run without network
access. A populated local API key must not silently turn `bun test` into an
outbound, billable operation.

## Decision

Keep the live test in a separate integration file and require both a populated
`ANTHROPIC_API_KEY` and `RUN_LIVE_ANTHROPIC_TEST=1`. The
`bun run test:integration` script sets the opt-in flag; normal `bun test` skips
the live case.

Document that live commands send the synthetic Phase 1 prompt, plan state, and
canned tool results to Anthropic.

## Alternatives considered

- **Run live whenever a key exists** — rejected because test behavior would
  change silently based on developer environment.
- **Mock the SDK and call Step 1 complete** — rejected because a mock cannot
  prove the provider's real tool-use behavior.
- **Include the live test in CI by default** — rejected for now because no CI
  secret policy or cost ceiling exists yet.

## Consequences

- The offline suite is deterministic and makes no provider call.
- Live verification requires an explicit command and outbound authorization.
- Step 1 cannot be marked complete when the live gate is skipped or blocked.

## Revisit when

Revisit when CI and budget enforcement exist. At that point, a protected,
cost-capped integration job may run the live gate automatically.
