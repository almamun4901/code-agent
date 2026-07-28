# Terminal-Native Coding Agent

A Bun/TypeScript coding agent built around an explicit
`plan -> act -> observe -> recover` loop. The target system will combine a
terminal UI, model-independent inference, typed MCP tools, isolated E2B
worktrees, lifecycle hooks, OpenTelemetry traces, and GitHub pull-request
creation.

## Current status

Steps 0–4 are complete. The deterministic fake loop, live Claude loop with
fake tools, six real local tools, crash-safe plan persistence, and MCP stdio
transport have passed their acceptance gates.
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
- deterministic fake file reads with no host filesystem access;
- strict Zod TodoWrite and versioned runtime-state schemas;
- atomic mode-0600 `.agent/state.json` checkpoints with fail-closed recovery;
- transcript, observation, retry, turn, and token continuity across repeated
  `SIGKILL` restarts;
- terminal protocol failures and cross-field checkpoint corruption rejected
  before any resumed model call;
- a transport-neutral real-tool dispatcher with runtime input validation and
  a no-op policy seam for Step 6;
- real `read_file`, preview/apply `edit_file`, `ripgrep`,
  `tree_sitter_symbols`, `run_shell`, and typed git operations;
- exact MCP discovery schemas for those six tools, including four
  discriminated Git operations;
- persistent MCP stdio client/server transport with canonical direct-call
  parity, strict result decoding, and child-process lifecycle handling;
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
    +---- AgentStateV1 ------------> src/state/checkpoint.ts
                                           |
                                           v
                                atomic .agent/state.json
    |
deterministic tests
    |
    v
McpToolClient
    |
    | JSON-RPC over stdin/stdout
    v
src/mcp/stdio-server.ts
    |
    v
src/mcp/server.ts
    |
    v
src/tools/dispatcher.ts
    |
    +---- runtime validation + development-root containment
    +---- policy seam + six typed real tools
    +---- capped, canonical serialized ToolResult
    |
    v
disposable git worktree + local bare remote
```

Later roadmap steps run the MCP tool server inside E2B, add safety hooks and
telemetry, and expose the loop through an Ink terminal UI.
The model loop and Step 2 real-tool dispatcher remain
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

# Focused MCP stdio suite
bun run test:mcp

# Full offline suite, including any explicitly skipped integration files
bun run test:all

# Step 0 regression baseline
bun run loop-fake.ts

# Run the Phase 1 program against Anthropic
bun run phase1

# Explicit live acceptance test
bun run test:integration

# Start the MCP stdio server for an absolute development root
bun run mcp:stdio -- --development-root /absolute/path/to/development-root
```

`bun run phase1` and `bun run test:integration` send the synthetic Phase 1
prompt, plan state, and canned tool results to Anthropic. Standard `bun test`
keeps the live integration test skipped even when a key is present.

`bun run phase1` resumes a valid `.agent/state.json` checkpoint automatically.
Invalid, incompatible, or unsupported state is preserved and reported instead
of being silently reset.

The MCP server reserves stdout for JSON-RPC. Startup and runtime diagnostics go
to stderr. Its development root must be an existing absolute directory. MCP
tool failures are returned as JSON `ToolResult` values; connection, protocol,
timeout, and malformed-result failures reject the client call.

## Roadmap-step workflow

Every roadmap step starts from an updated `main` and uses its own branch. Break
the step into explicit substeps, run the relevant checks after each one, and
commit each verified substep separately. After the complete definition of done,
gstack review, and documentation audit pass, push the step branch, merge it
into an updated `main`, reverify the merged result, and then push `main`.

The authoritative agent instructions and exact sequence are in
[`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md).

## Documentation map

- [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md): mandatory per-step
  Git workflow, reading order, project conventions, and verification commands.
- [`PLAN.md`](PLAN.md): target architecture, build order, definitions of done,
  scope, and risks.
- [`PROGRESS.md`](PROGRESS.md): authoritative current state, blockers, session
  history, and next action.
- [`docs/plans/phase-1-real-model-fake-tools.md`](docs/plans/phase-1-real-model-fake-tools.md):
  detailed Step 1 design, implementation tasks, test map, and acceptance gate.
- [`docs/plans/phase-2-real-tools-no-sandbox.md`](docs/plans/phase-2-real-tools-no-sandbox.md):
  real-tool contracts, disposable repository harness, test matrix, and
  completion evidence.
- [`docs/plans/phase-3-plan-schema-persistence.md`](docs/plans/phase-3-plan-schema-persistence.md):
  checkpoint architecture, recovery contract, test matrix, and deferred
  mutation-safety gate.
- [`docs/plans/phase-4-mcp-stdio.md`](docs/plans/phase-4-mcp-stdio.md):
  stdio architecture, wire/error contract, parity matrix, and completion
  evidence.
- [`docs/decisions/`](docs/decisions/): architectural decision records explaining
  what was chosen, alternatives, consequences, and revisit triggers.
- [`docs/reviews/phase-1-implementation-review.md`](docs/reviews/phase-1-implementation-review.md):
  gstack review findings, fixes, and verification evidence.
- [`docs/reviews/phase-2-implementation-review.md`](docs/reviews/phase-2-implementation-review.md):
  Step 2 scope audit, review fix, and final verification evidence.
- [`docs/reviews/phase-3-implementation-review.md`](docs/reviews/phase-3-implementation-review.md):
  Step 3 trust-boundary findings, fixes, and recovery verification.
- [`docs/reviews/phase-4-implementation-review.md`](docs/reviews/phase-4-implementation-review.md):
  Step 4 schema, lifecycle, mutation-parity, and result-boundary review.

Read `PROGRESS.md` first when resuming work. It is intentionally more current
than the roadmap.
