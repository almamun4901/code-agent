# Terminal-Native Coding Agent

A Bun/TypeScript coding agent built around an explicit
`plan -> act -> observe -> recover` loop. The target system will combine a
terminal UI, model-independent inference, typed MCP tools, isolated E2B
worktrees, lifecycle hooks, OpenTelemetry traces, and GitHub pull-request
creation.

## Current status

Steps 0–8 are complete. Gate 8A is implemented and has passed its feature-branch
acceptance gates; roadmap completion awaits landing and merged-main verification.
The deterministic fake loop, live Claude loop with fake tools, six real local
tools, crash-safe plan persistence, MCP stdio transport,
isolated E2B execution, and the PreToolUse safety boundary have passed their
acceptance gates. Mutation recovery is also complete: mutating calls are
journaled on both host and sandbox, interrupted sessions reconnect to the same
worktree, and ambiguous operations fail closed. The six tools execute serially
inside one short-lived, network-disabled E2B worktree per task.
The routed OpenRouter provider and host-side production runner now connect the
model to those real tools. The runner validates repository/task identity
before external activity, checkpoints validated tool intent before execution,
resumes the same E2B mutation operation, and reconciles before cleanup.

Successful sandbox work is now committed, exported as a bounded Git bundle,
validated against the exact starting commit, and imported into a new local
`result/<run-id>` branch before E2B cleanup. The checked-out branch, HEAD, and
worktree are never switched or modified. Gate 8B remains next: implementation
still starts before a human can approve product/design choices. Gate 8C then
requires completion claims to reference durable verification evidence. Those
two gates block telemetry and evaluation; GitHub PR delivery remains Step 10.

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
- a transport-neutral real-tool dispatcher with strict runtime input
  validation, immutable task-root binding, structured PreToolUse decisions,
  fail-closed policy errors, and per-session serialization;
- real `read_file`, preview/apply `edit_file`, `ripgrep`,
  `tree_sitter_symbols`, `run_shell`, and typed git operations;
- exact MCP discovery schemas for those six tools, including status, diff,
  and commit Git operations with no model-visible repository path or push;
- persistent MCP stdio client/server transport with canonical direct-call
  parity, strict result decoding, and child-process lifecycle handling;
- durable operation IDs, host session leases, and sandbox mutation journals
  for edit apply, shell, and Git commit;
- same-sandbox reconnection, terminal cancellation reconciliation, and
  duplicate-mutation prevention;
- transactional result export/import with bounded bundle, commit, object, and
  path validation; owner-only receipts; crash-resumable transitions; and
  idempotent local branch creation;
- result branches that survive E2B cleanup without switching the user's branch
  or accepting a dirty host worktree, protected paths, symlinks, or gitlinks;
- separate `agent` and `runner` identities, immutable runtime ownership,
  protected linked-worktree Git metadata, and a fixed root-owned shell wrapper;
- component-wise symlink rejection, no-follow file access, controlled shell
  and Git environments, process cleanup, and disabled sandbox internet;
- disposable git worktrees and a local bare remote for tool tests;
- complete success and error results capped at 4,000 offline
  `o200k_base` tokens.
- a production `model -> plan -> E2B MCP tool -> checkpoint` runner with
  provider-native sequential plan/action turns and actual usage accounting;
- all eight lifecycle hook boundaries with capability-specific authority,
  bounded execution, and observer isolation;
- checkpoint-v3 paid-call reservations, dual projected/observed cost ledgers,
  50-call / 200k-context / $5.00 ceilings, and transactional compaction at
  150k tokens.

On success, `agent run` prints the new local result branch and its commit. The
user can inspect or merge that branch normally; the active branch remains
untouched. Interactive plan approval and completion-evidence inspection are
still pending in Gates 8B and 8C.

## Current architecture

```text
task prompt
    |
    v
src/loop.ts
  plan / act / observe / recover
    |
    +---- normalized ModelRequest ----> src/model/contracts.ts
                                           |
                                           v
                                    provider adapters
                                     /             \
                                    v               v
                         src/model/openrouter.ts  src/model/anthropic.ts
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
    +---- strict schema + immutable canonical task root
    +---- PreToolUse allow/deny + serialized execution
    +---- typed file/Git tools as agent
    +---- run_shell through root-owned wrapper as runner
    +---- operation journal before every mutation
    +---- capped, canonical serialized ToolResult
    |
    v
network-disabled E2B task worktree
    |
    +---- /opt/agent and Git control state protected by permissions
    +---- ordinary task content remains mutable
    ^
    |
src/runtime/agent-runner.ts
    +---- canonical repository + task identity
    +---- pending turn and stable mutation operation ID
    +---- provider-neutral model runtime + recovered E2B session
    +---- lifecycle hooks + durable budget preflight
    +---- transactional context compaction
    +---- reconciliation before sandbox cleanup
    +---- bounded Git export + validated result/<run-id> import
    +---- durable receipt before E2B cleanup
```

`E2bTaskSession` now uploads an exact clean Git revision, provisions a
branch-backed worktree under `/workspace/tasks`, and connects to the MCP server
through streamed E2B stdin/stdout. The sandbox starts with internet disabled;
typed tools run as `agent`, while arbitrary shell commands run as `runner`
through the fixed wrapper. Its host lease records the exact sandbox and active
mutation; recovery verifies the sandbox journal before reconnecting or
refusing replay. Shell commands use a group-preserving umask so their task
artifacts remain editable by typed tools under the separate `agent` identity.
On completion, the host validates the sandbox's delta bundle in a temporary
bare repository, creates a new result branch with `git update-ref`, checkpoints
the receipt, and only then permits cleanup. The production runner joins that session to the routed
model and durable version-3 checkpoint. The Ink terminal UI renders committed
plan, tool, lifecycle notice, context, call, compaction, and dual-cost state.
Later roadmap steps add telemetry and evaluation/PR publication.

## Setup

Requirements:

- Bun 1.3 or newer
- Git and ripgrep for the complete local tool suite
- an Anthropic API key only for commands that intentionally call the live API
- an E2B API key and pinned template ID only for explicit sandbox tests

```sh
bun install
cp .env.example .env
```

Add only the API keys needed for explicit live commands to local `.env`. That
file is ignored and must never be committed.

## Development commands

```sh
# Strict TypeScript verification
bun run typecheck

# Offline deterministic suite; never calls Anthropic
bun test

# Focused MCP stdio suite
bun run test:mcp

# Focused offline safety/red-team suite
bun run test:safety

# Focused offline sandbox/template/session suite
bun run test:sandbox

# Complete local verification, including the focused sandbox suite
bun run test:manual:local

# Read-only list of currently running E2B sandboxes
bun run e2b:sandboxes:list

# Full offline suite, including any explicitly skipped integration files
bun run test:all

# Step 0 regression baseline
bun run loop-fake.ts

# Run the Phase 1 program against Anthropic
bun run phase1

# Explicit live acceptance test
bun run test:integration

# Explicit live E2B transport and safety gates
bun run test:e2b:transport
bun run test:e2b:safety

# Focused offline production-runner suite
bun run test:runtime

# Focused lifecycle and budget suites
bun test tests/lifecycle-hooks.test.ts tests/runtime-budgets.test.ts

# Explicit selected-provider -> live E2B MCP production-runner gate
bun run test:runtime:integration

# Start MCP for one exact task root under a trusted parent
bun run mcp:stdio -- --worktree-root /absolute/tasks/task-a --allowed-parent /absolute/tasks
```

The [Step 5 manual terminal test guide](docs/testing/step-5-manual-terminal-tests.md)
lists the safe execution order, expected results, explicit live E2B gates, and
exact-ID cleanup procedure. Live sandbox tests remain opt-in.

The [Step 6 manual safety test guide](docs/testing/step-6-manual-safety-tests.md)
adds the PreToolUse red-team matrix, two-identity runtime checks, network and
environment isolation gates, process cleanup checks, and a reusable evidence
record. Its live cases remain opt-in and must be run one at a time.

The live E2B safety suite also proves shell-create to typed-edit parity and
end-to-end result delivery: the delivered file remains available through its
new local branch after the sandbox is gone. Use the immutable
`terminal-coding-agent-tools:result-delivery-v1` template tag.

`bun run phase1` and `bun run test:integration` send the synthetic Phase 1
prompt, plan state, and canned tool results to Anthropic. Standard `bun test`
keeps the live integration test skipped even when a key is present.

`bun run phase1` resumes a valid `.agent/state.json` checkpoint automatically.
Invalid, incompatible, or unsupported state is preserved and reported instead
of being silently reset.

The MCP server reserves stdout for JSON-RPC. Startup and runtime diagnostics go
to stderr. Its worktree root and allowed parent must be existing absolute
directories, and the canonical worktree must be a strict child of that parent.
MCP tool failures are returned as JSON `ToolResult` values; connection,
protocol, timeout, and malformed-result failures reject the client call.

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
- [`docs/plans/phase-5-e2b-sandbox.md`](docs/plans/phase-5-e2b-sandbox.md):
  E2B runtime, worktree provisioning, lifecycle ownership, and live gates.
- [`docs/plans/phase-6-pretooluse-safety-hook.md`](docs/plans/phase-6-pretooluse-safety-hook.md):
  threat model, structural confinement, red-team matrix, and acceptance gates.
- [`docs/plans/lifecycle-budgets.md`](docs/plans/lifecycle-budgets.md):
  Step 8 hook authority, budget/accounting invariants, recovery, and tests.
- [`docs/plans/product-delivery-gates.md`](docs/plans/product-delivery-gates.md):
  safe local result delivery, plan approval, completion evidence, and the
  required ordering before telemetry and evaluation.
- [`docs/plans/mutation-recovery.md`](docs/plans/mutation-recovery.md):
  operation journaling, same-sandbox recovery, cancellation, and acceptance
  evidence.
- `src/runtime/agent-runner.ts` validates run identity, opens or recovers the
  owned E2B session, and reconciles before cleanup.
- `src/runtime/production-loop.ts` checkpoints validated pending turns before
  MCP execution and commits plans only with terminal observations.
- `tests/agent-runtime.integration.test.ts` is the opt-in routed-model to live
  E2B MCP acceptance gate.
- [`docs/testing/step-5-manual-terminal-tests.md`](docs/testing/step-5-manual-terminal-tests.md)
  and [`docs/testing/step-6-manual-safety-tests.md`](docs/testing/step-6-manual-safety-tests.md):
  ordered local and opt-in live verification procedures.
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
- [`docs/reviews/phase-6-implementation-review.md`](docs/reviews/phase-6-implementation-review.md):
  Step 6 security review, engineering findings, fixes, and landing evidence.
- [`docs/reviews/result-delivery-implementation-review.md`](docs/reviews/result-delivery-implementation-review.md):
  Gate 8A scope audit, transaction and trust-boundary review, fixes, and live
  delivery evidence.

Read `PROGRESS.md` first when resuming work. It is intentionally more current
than the roadmap.
