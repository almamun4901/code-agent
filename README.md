# Terminal-Native Coding Agent

A Bun/TypeScript coding agent built around an explicit
`plan -> act -> observe -> recover` loop. The target system will combine a
terminal UI, model-independent inference, typed MCP tools, isolated E2B
worktrees, lifecycle hooks, OpenTelemetry traces, and GitHub pull-request
creation.

## Current status

Steps 0–2 are complete. The deterministic fake loop, live Claude loop with
fake tools, and six real local tools have all passed their acceptance gates.
The real tools have only been exercised by deterministic tests against
disposable repositories; no model has received them.

The code currently proves:

- a provider-neutral `callModel()` boundary backed by the Anthropic Messages
  API;
- complete plan replacement on every accepted model turn;
- exact local validation of model-produced tool inputs;
- provider-facing strict schemas limited to Anthropic's supported JSON Schema
  subset, without weakening semantic guards;
- atomic turn rejection before state mutation or tool execution;
- ordered, ID-correlated results for `rewrite_plan` and `read_file`;
- one protocol retry followed by a hard failure;
- deterministic fake file reads with no host filesystem access.
- a transport-neutral real-tool dispatcher with runtime input validation and
  a no-op policy seam for Step 6;
- real `read_file`, preview/apply `edit_file`, `ripgrep`,
  `tree_sitter_symbols`, `run_shell`, and typed git operations;
- disposable git worktrees and a local bare remote for tool tests;
- complete success and error results capped at 4,000 offline
  `o200k_base` tokens.

## Current architecture

```text
task prompt
    |
    v
src/loop.ts
  plan / act / observe / recover
    |
    +---- normalized ModelRequest ----> src/model/anthropic.ts
    |                                      |
    |                                      v
    |                                Anthropic Messages API
    |
    +---- validated read_file ------> src/tools/fake-read-file.ts
    |                                      |
    |                                      v
    |                                 canned result only
    |
deterministic tests
    |
    v
src/tools/dispatcher.ts
    |
    +---- runtime validation + policy seam
    +---- six typed real tools
    +---- capped serialized ToolResult
    |
    v
disposable git worktree + local bare remote
```

Later roadmap steps add persistent plans, move dispatch over MCP, run the tools
inside E2B, add safety hooks and telemetry, and expose the loop through an Ink
terminal UI. The Step 1 model loop and Step 2 real-tool dispatcher remain
deliberately disconnected until those safety layers exist.

## Setup

Requirements:

- Bun 1.3 or newer
- an Anthropic API key only for commands that intentionally call the live API

```sh
bun install
cp .env.example .env
```

Add `ANTHROPIC_API_KEY` to the local `.env`. That file is ignored and must
never be committed.

## Development commands

```sh
# Strict TypeScript verification
bun run typecheck

# Offline deterministic suite; never calls Anthropic
bun test

# Full offline suite, including any explicitly skipped integration files
bun run test:all

# Step 0 regression baseline
bun run loop-fake.ts

# Run the Phase 1 program against Anthropic
bun run phase1

# Explicit live acceptance test
bun run test:integration
```

`bun run phase1` and `bun run test:integration` send the synthetic Phase 1
prompt, plan state, and canned tool results to Anthropic. Standard `bun test`
keeps the live integration test skipped even when a key is present.

## Documentation map

- [`PLAN.md`](PLAN.md): target architecture, build order, definitions of done,
  scope, and risks.
- [`PROGRESS.md`](PROGRESS.md): authoritative current state, blockers, session
  history, and next action.
- [`docs/plans/phase-1-real-model-fake-tools.md`](docs/plans/phase-1-real-model-fake-tools.md):
  detailed Step 1 design, implementation tasks, test map, and acceptance gate.
- [`docs/plans/phase-2-real-tools-no-sandbox.md`](docs/plans/phase-2-real-tools-no-sandbox.md):
  real-tool contracts, disposable repository harness, test matrix, and
  completion evidence.
- [`docs/decisions/`](docs/decisions/): architectural decision records explaining
  what was chosen, alternatives, consequences, and revisit triggers.
- [`docs/reviews/phase-1-implementation-review.md`](docs/reviews/phase-1-implementation-review.md):
  gstack review findings, fixes, and verification evidence.
- [`docs/reviews/phase-2-implementation-review.md`](docs/reviews/phase-2-implementation-review.md):
  Step 2 scope audit, review fix, and final verification evidence.

Read `PROGRESS.md` first when resuming work. It is intentionally more current
than the roadmap.
