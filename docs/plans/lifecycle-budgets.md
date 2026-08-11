# Step 8 — Lifecycle hooks and budget ceilings

Step 8 adds a typed lifecycle boundary around the production runner and makes
paid model activity recoverable and bounded.

## Runtime contract

The eight hook names are `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `Notification`, `Stop`, and `PreCompact`.
Seven are host-owned. `PreToolUse` remains sandbox-owned and always runs the
mandatory safety policy before its optional extension.

Production limits are fixed:

- 50 paid agent or compaction calls;
- compaction at 150,000 request tokens or 1.5 MiB checkpoint pressure;
- rejection above 200,000 request tokens;
- $5.00 projected cost, stored as 5,000,000 integer microdollars;
- a 2 MiB hard checkpoint ceiling with a replay-safe terminal fallback.

Tests may inject smaller limits. Production CLI and environment variables
cannot weaken them.

## Recovery contract

Checkpoint v4 persists model identity and pricing, context estimates, projected
and observed cost ledgers, call counters, compaction history, notification
deduplication, prompt lifecycle, and the sole `pendingModelCall` record.

A paid call is reserved before transport. A crash without a durable response
terminates ambiguously without replay. A durable agent response completes its
ordinary transition on resume. A durable summary response installs the
compacted transcript on resume without being treated as an agent turn.

Checkpoint v4 also adds the approved verification contract, audit cursor,
`finalizing` lifecycle, evidence, and completion receipt. A finalizing run has
no pending model work; delivery recovery completes without another paid call.

Empty v2 production checkpoints migrate through the supported decoder. Active
pre-8C v3 execution fails with `COMPLETION_MIGRATION_REQUIRED`; terminal v3
runs remain inspectable as `legacy_unverified` and are never upgraded to
verified completion. Non-empty v2 checkpoints fail
with an actionable error rather than inventing historical model prices.

## Provider accounting

Direct Anthropic uses the Messages token-count endpoint before each request and
has SDK retries disabled. OpenRouter retains the routed response model, native
prompt/completion counts, and reported cost. Its preflight estimate uses the
last native prompt count for append-only growth and a conservative local
`o200k_base` fallback otherwise.

The initial catalog supports direct Claude Haiku 4.5 and the equivalent
OpenRouter route at $1 per million uncached input tokens and $5 per million
output tokens. A routed model mismatch records usage and stops before another
call.

## Verification

`tests/lifecycle-hooks.test.ts` covers hook ordering, authority, validation,
timeouts, observer isolation, and frozen snapshots.
`tests/runtime-budgets.test.ts` covers bootstrap ordering, prompt denial,
call/context/cost boundaries, compaction, kill points, Stop rejection,
PostToolUse, checkpoint fallback, and v2 migration policy.

Run:

```sh
bun run typecheck
bun test
bun run test:runtime
bun run test:mcp
bun run test:sandbox
bun run test:safety
git diff --check
```

Live provider and E2B gates remain explicit because they spend money or create
external resources.
