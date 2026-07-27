# Phase 1 Implementation Review

**Date:** 2026-07-25  
**Workflow:** gstack `/review` checklist, adapted to an explicit file-set review
because this workspace does not contain Git metadata.  
**Status:** complete; corrected live provider acceptance passed.

## Scope reviewed

- `package.json`
- `bun.lock`
- `tsconfig.json`
- `.env.example`
- `src/model/anthropic.ts`
- `src/tools/fake-read-file.ts`
- `src/loop.ts`
- `tests/loop.test.ts`
- `tests/anthropic.integration.test.ts`

The implementation matches the Phase 1 goal: one real model adapter, fake
typed tool execution, complete-plan rewrites, at least three required reads,
bounded recovery, and no real filesystem access.

## Review coverage

The gstack critical and informational categories were applied to the complete
file set:

- LLM output trust boundary
- enum and status completeness
- prompt/tool contract drift
- type coercion and boundary validation
- completeness and negative-path coverage
- secret handling and provider-error sanitization
- deterministic versus live test separation
- documentation staleness

SQL, database, frontend, migration, concurrency, shell-injection, and
distribution checks were not applicable to this phase.

## Findings fixed

1. **Dependency currency** — the initial SDK constraint resolved to 0.68.0
   while 0.115.0 was current. The dependency and lockfile were updated before
   implementation continued.
2. **Live-test isolation** — the integration test originally ran whenever a
   key existed. It now also requires `RUN_LIVE_ANTHROPIC_TEST=1`, so normal
   tests remain offline.
3. **Model override normalization** — a whitespace-only override could select
   an empty model ID. Model names are now trimmed and fall back to the
   documented default.
4. **Exact local schemas** — local validation originally ignored unexpected
   input fields. It now rejects extra fields at every model-produced object
   boundary, with regression tests.

## Follow-up review cleanup

On 2026-07-26, two non-bug readability observations were addressed:

- the validator-local `readCalls` collection was renamed to `readToolCalls` so
  it cannot be confused with the loop's numeric `readCalls` metric;
- the `planTool` extraction and cardinality guard were combined, removing a
  separate defensive branch that appeared unreachable but existed solely for
  `noUncheckedIndexedAccess`.

No unresolved code findings remain.

## Live-gate investigation

The first user-authorized integration run reached Anthropic and returned HTTP
400 before the model produced a turn. Gstack `/investigate` traced the failure
to the strict provider schema: it sent `minItems: 3`, `maxItems: 3`, and
`minLength: 1`, while Anthropic strict structured outputs accept only a JSON
Schema subset.

The provider schema now uses the supported subset and puts semantic guidance
in descriptions. The existing local validator still enforces the exact plan
length, task identities and order, legal state transitions, and expected
non-empty fixture path. A regression test rejects reintroduction of the
unsupported wire constraints. Sanitized 4xx validation messages are now kept
for diagnosis while raw provider envelopes remain private.

The second live run passed request-schema validation and reached Claude. Claude
returned a semantically invalid turn containing two tool calls, which correctly
triggered local recovery. The recovery path then replayed the rejected
assistant content followed by correction text instead of tool results, so
Anthropic rejected the next request. This contradicted ADR 0004 and the loop's
own contract comment. The fix keeps the transcript at its last valid state and
adds only the correction message. A regression test first reproduced the
three-message invalid transcript, then passed with no rejected tool IDs in the
retry request.

The third live run reached local validation but failed twice because Claude did
not preserve a canonical task description. Request inspection showed the
validator required exact IDs and descriptions while the first request supplied
only IDs and fixture paths. It also showed prompt text saying only one status
could change, which contradicted the valid two-field transition that completes
the current task and starts the next. The first user message now carries the
serialized canonical initial plan, and the transition instruction now matches
`validatePlanTransition`. A request-contract regression test failed before the
fix and now verifies every ID, description, initial status, and transition
instruction.

## Verification evidence

| Check | Result |
|---|---|
| `bun run typecheck` | pass |
| `bun test` | 38 pass, 1 live test skipped, 0 fail |
| `bun run loop-fake.ts` | pass; 4 turns, 3/3 tasks, 1 recovery |
| Live Anthropic integration | pass; completion, 3+ responses, 3 fake reads, full plan rewrites, and non-zero token usage asserted |

The local runtime could not independently repeat the outbound diagnostic
because it would send repository-derived schemas to an external provider.
No bypass was attempted; the corrected test can be rerun with the same
explicit command below.

## Final gate

The explicitly authorized `bun run test:integration` command passed on
2026-07-26. A before/after repository-status comparison also proved the live
test did not modify the project worktree.
