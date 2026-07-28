# Phase 3 Plan — Plan Schema and Crash-Safe Persistence

**Status:** complete; verified 2026-07-27.

## Outcome

Validate TodoWrite input with Zod and persist the complete provider-neutral
loop state to `.agent/state.json`. A restart restores the last fully committed
turn without replaying any committed read.

## Architecture

```text
runAgentLoop
    |
    +--> Zod TodoWrite structure --> semantic transition validation
    |
    +--> AgentStateV1
             |
             +--> injected CheckpointStore
                      |
                      +--> memory store for unit tests
                      +--> atomic filesystem store in production
```

`AgentStateV1` includes the plan, normalized transcript, most recent
observation, running/completed/failed lifecycle, retry state, and all current
counters. The filesystem
store owns path safety, validation, temporary-file cleanup, synchronization,
and atomic replacement; the loop owns commit timing.

## Recovery contract

- Initial state is committed before the first model request.
- A rejected first response commits its correction and retry budget while
  preserving the legitimate all-pending initial plan.
- An accepted turn commits only after tool completion and observation capture.
- Completed state returns without another model or tool call.
- A terminal protocol failure remains terminal after restart.
- Missing state starts fresh under `auto`; `required` fails; `fresh` is the
  explicit permission to replace an existing run.
- Committed tools never replay. Interrupted uncommitted work may replay.

Exactly-once mutation recovery is not part of Step 3. ADR 0009 makes it a
blocking revisit before the first live-model real-tool run.

## Acceptance matrix

- Strict schema round trips and rejection of malformed or unknown fields.
- Atomic mode-0600 persistence, file/directory sync, orphan cleanup, and
  preservation of the prior checkpoint when replacement fails.
- Fail-closed corrupt/version/incompatible state behavior.
- Rejection of symlinked `.agent` directories and `state.json` files.
- Recovery of transcript, observations, retry budget, turns, and tokens.
- No model or tool call after restoring completed state.
- Deterministic child process killed twice during model turns, then resumed to
  completion without replaying any committed read.
- Type check, complete offline suite, and Step 0 regression all pass.

## Explicitly deferred

- Concurrent checkpoint writers and locking.
- State migrations beyond version 1.
- Exactly-once semantics for mutating tools.
- MCP transport, E2B isolation, lifecycle hooks, telemetry, and TUI work.

## Verification evidence

- `bun run typecheck`: pass.
- `bun test`: 81 pass, 1 explicit live test skipped, 0 fail.
- Repeated hard-kill acceptance: two `SIGKILL` cycles followed by exact
  completion; three committed reads executed once each.
- `bun run loop-fake.ts`: four turns, three completed tasks, one recovery.
- Gstack pre-landing review: three trust-boundary findings fixed; no unresolved
  findings after local follow-up and full-suite verification.
