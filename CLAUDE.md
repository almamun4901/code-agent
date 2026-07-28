# Project context for coding agents

This file is read by Claude Code, Cursor, and similar tools at the start of a
session. Read it, then read the three files it points to, before writing or
editing any code.

## Read in this order

1. **`PLAN.md`** — the overall roadmap: architecture, build order (steps
   0–10), dependencies, definitions of done, out-of-scope list, risk
   register. Changes rarely.
2. **`PROGRESS.md`** — current state: which step we're on, what's blocked,
   what the last session did, what the next session should start with.
   Changes every session — this is the most recently accurate source of
   "where are we."
3. **`docs/decisions/`** — one file per non-obvious architectural choice
   (model provider, sandbox choice, build order, etc.), with context,
   alternatives considered, and the specific trigger to revisit it. Check
   here before re-deciding something that may already have been decided.

## Working conventions

- **Don't skip ahead in the build order.** `PLAN.md` §3 has an explicit
  dependency table (e.g. the TUI depends on steps 3, 4, and 5 being done).
  If asked to work on a step whose dependencies aren't marked done in
  `PROGRESS.md`, say so before proceeding.
- **State your understanding before acting.** At the start of a session,
  restate what you think the current step and next task are, based on
  `PROGRESS.md`, before writing code. This catches drift early and cheaply.
- **Update `PROGRESS.md` at the end of the session**, not during. Use the
  template at the bottom of that file. Include: what was done, what broke,
  any new decisions (also add real architectural ones to
  `docs/decisions/`), and what the next session should start with.
- **One step's definition of done is a checklist, not a vibe.** Each step in
  `PLAN.md` §3 has a concrete "definition of done" — treat a step as
  complete only when that specific condition is verifiable (e.g. "kill -9
  mid-turn and confirm resume from `.agent/state.json`"), not when the code
  merely runs once.
- **New architectural decision → new ADR.** Use
  `docs/decisions/0000-template.md` as the starting point. Number
  sequentially. Keep it short: context, decision, alternatives, consequences,
  revisit trigger.
- **Cost discipline during development**: use a cheap model for iteration
  (see `docs/decisions/0002-model-provider.md`); the frontier model is
  reserved for the actual step-10 eval run.

## gstack skills used in this project

- Before starting a step: `/plan-eng-review` on the relevant `PLAN.md`
  section.
- After a step's definition of done is met: `/review`.
- Step 6 (PreToolUse guard) specifically: `/cso` once built, `/careful` and
  `/guard` while building.
- Debugging steps 5 and 8: `/investigate`.
- Step 10: `/ship` for the PR-posting step.
- End of each session: `/document-release` to keep `PLAN.md`, `PROGRESS.md`,
  and `CLAUDE.md` in sync.

## Testing

- Runtime: Bun 1.3+
- Type check: `bun run typecheck`
- Offline deterministic suite: `bun test`
- Focused MCP stdio suite: `bun run test:mcp`
- Step 0 regression: `bun run loop-fake.ts`
- Explicit live Phase 1 gate: `bun run test:integration`

The live gate requires `ANTHROPIC_API_KEY` and opts in with
`RUN_LIVE_ANTHROPIC_TEST=1`. It sends the synthetic Phase 1 prompt, plan state,
and canned tool results to Anthropic. Normal `bun test` never makes that call.

## Current implementation structure

- `src/loop.ts` owns plan/act/observe/recover orchestration and all semantic
  validation of model turns.
- `src/plan/schema.ts` owns strict Zod schemas for TodoWrite input and the
  provider-neutral versioned runtime checkpoint.
- `src/state/checkpoint.ts` owns fail-closed loading and durable atomic
  `.agent/state.json` replacement.
- `src/model/anthropic.ts` translates the provider-neutral loop contract to the
  Anthropic Messages API and sanitizes provider errors.
- `src/tools/fake-read-file.ts` returns canned fixture data without filesystem
  access.
- `tests/loop.test.ts` covers the state machine and trust boundary offline.
- `tests/checkpoint.test.ts` covers state validation, filesystem safety,
  repeated hard-kill recovery, and committed-tool non-replay.
- `tests/anthropic.integration.test.ts` is the opt-in live acceptance gate.
- `src/tools/dispatcher.ts` validates and routes all six real tools, invokes
  the Step 6 policy seam, normalizes failures, and caps serialized results.
- `src/tools/token-budget.ts` enforces the 4,000-token offline
  `o200k_base` result budget.
- `src/mcp/schemas.ts` owns exact MCP discovery schemas and strict
  JSON-safe `ToolResult` decoding.
- `src/mcp/server.ts` registers the six existing tools and delegates every
  valid call to the unchanged dispatcher.
- `src/mcp/client.ts` owns the persistent connection, 60-second request
  timeout, result validation, and idempotent shutdown.
- `src/mcp/stdio-server.ts` requires an absolute `--development-root` and
  reserves stdout for MCP messages.
- `tests/support/temp-repo.ts` creates disposable worktrees and a local bare
  remote without touching the project worktree.
- `tests/tools.test.ts` covers the real dispatcher and all six tools.
- `tests/mcp.test.ts` covers discovery, direct/MCP parity, mutations, failures,
  result budgets, and stdio lifecycle.

## Current step

Check `PROGRESS.md` for the authoritative answer — do not rely on this
file's memory of it, since this section is not kept in sync.
