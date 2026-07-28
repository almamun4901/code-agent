# Phase 3 Implementation Review

**Date:** 2026-07-27
**Scope:** Zod plan schema, atomic runtime checkpoints, and hard-kill recovery
**Result:** complete; no unresolved findings

## Scope check

The implementation stays within Step 3. It does not connect the model to the
Step 2 real-tool dispatcher, add MCP or E2B, or claim exactly-once mutation
recovery. ADR 0009 makes mutation reconciliation a blocking revisit before the
first live-model real-tool run.

## Findings and fixes

1. **Canonical plan text was normalized before comparison.** Zod `.trim()`
   could accept whitespace-modified task identities. Validation now checks
   non-whitespace content without transforming the original string, and a
   regression test proves exact comparison still rejects the change.
2. **Terminal protocol failure could be retried after restart.** Exhausting the
   one-retry allowance now commits a failed lifecycle with its terminal error.
   Recovery rejects it before another model call.
3. **Checkpoint fields were only structurally correlated.** Recovery now
   cross-checks model, committed-turn, rewrite, retry, read, transcript,
   lifecycle, and terminal-error state before accepting a checkpoint.

## Verification

- `bun run typecheck`: pass.
- `bun test`: 81 pass, 1 opt-in live test skipped, 0 fail.
- Repeated `SIGKILL` test: pass.
- Step 0 regression: pass with four turns and one recovery.
- `git diff --check`: pass.
