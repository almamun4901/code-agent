# 0019 — Reserve paid model calls and keep dual cost ledgers

## Context

Step 8 must enforce 50 paid calls, 200,000 request-context tokens, and $5.00
projected task cost while surviving process death. Provider-reported cost is
useful evidence but arrives only after a request and is not uniformly available.
Compaction is itself a paid model request and can fail between response receipt
and checkpoint installation.

## Decision

Before every agent or compaction request, atomically persist one
`pendingModelCall` containing the request digest, conservative input estimate,
maximum output, and full projected reservation. Disable implicit Anthropic
transport retries. Persist the validated response and normalized usage before
applying the turn or summary transition.

Enforce a checked-in integer-microdollar ledger using the checkpoint's pricing
snapshot. Store provider-reported cost separately and report drift without
retroactively changing the enforced ledger. A reservation without a durable
response becomes terminal `AMBIGUOUS_MODEL_CALL`, consumes its reservation,
and is never replayed.

Compaction uses the selected provider/model, no tools, a strict bounded JSON
summary, and the same reservation protocol. A saved summary response is
installed deterministically after restart without another provider request.

## Alternatives considered

- **Enforce provider-reported cost only** — rejected because it arrives after
  spend and is unavailable for direct Anthropic responses.
- **Retry ambiguous calls** — rejected because it can duplicate spend and
  model-side effects.
- **Truncate transcript locally** — rejected because it silently discards
  decisions and creates untestable recovery behavior.

## Consequences

The enforced ledger is conservative and can stop earlier than the provider's
invoice. Checkpoint v3 is required. Empty v2 checkpoints migrate with zero
usage; non-empty v2 checkpoints are refused because historic pricing identity
cannot be reconstructed honestly.

## Revisit trigger

Revisit when prompt caching, batch pricing, another production model, or a
provider idempotency key is introduced.
