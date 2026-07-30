# 0015 — Select the production model provider at runtime

**Date:** 2026-07-30
**Status:** accepted

## Context

ADR 0006 required OpenRouter before the first live real-tool run and Step 7.
That boundary is implemented, tested, and merged, but the available account's
daily free-model allowance was exhausted during production-runner acceptance.
The user does not currently have paid OpenRouter capacity and explicitly
authorized finishing Step 7 through the already configured Anthropic API.

The provider-neutral `CallModel` contract and both adapters already exist.
Making OpenRouter availability a permanent TUI build dependency would now test
account quota rather than architecture.

## Decision

Select `anthropic` or `openrouter` at the host runner boundary through
`AGENT_MODEL_PROVIDER`, defaulting to `anthropic` during Step 7. Keep both
adapters and all OpenRouter verification; do not route model choice into the
loop, MCP server, sandbox, or terminal view.

Use the direct Anthropic adapter for the mandatory live production-runner and
Step 7 acceptance gates until paid OpenRouter capacity is available.

## Alternatives considered

- **Wait for each free OpenRouter reset** — rejected because quota timing is
  unrelated to correctness and blocks the already provider-neutral TUI.
- **Remove OpenRouter** — rejected because its normalization boundary is
  complete and remains part of the target architecture.
- **Use only deterministic model injection** — rejected because it would not
  verify a real provider-to-E2B tool sequence.

## Consequences

- Step 7 can proceed without an OpenRouter subscription.
- Anthropic API usage may incur charges independently of any Claude consumer
  subscription.
- Provider-specific configuration fails before sandbox creation.
- OpenRouter can be restored without changing the production loop or TUI.

## Revisit when

Revisit before Step 10 evaluation, when paid OpenRouter capacity becomes
available, or if provider behavior requires logic outside its adapter.
