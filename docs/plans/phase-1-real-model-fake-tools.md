# Phase 1 Plan — Real Model, Fake Tools

**Status:** complete; live verification passed 2026-07-26.

## Outcome

Replace Step 0's deterministic actor with one real Claude model while keeping
tool execution canned and harmless. At the end of this phase, Claude must drive
at least three turns, rewrite the complete plan every turn, request a typed
`read_file` call, consume the matching fake result, and finish with a validated
completed plan.

This phase proves the model boundary and conversation protocol. It does not
prove filesystem tools, persistence, MCP, sandboxing, hooks, or UI behavior.

## What already exists

- `loop-fake.ts` proves the `PLAN -> ACT -> OBSERVE -> RECOVER` state-machine
shape, maximum-turn guard, and terminal summary. Reuse those concepts, but
leave the Step 0 artifact unchanged as a deterministic reference.
- `.env` exists locally and is ignored. The key was available during
  implementation checks; its value was never read into logs or documentation.
- `.gitignore` already excludes credentials, dependencies, and `.agent/`
runtime state.
- ADR 0002 already chooses the direct Claude API for Steps 0–3 and requires a
stable `callModel()` boundary so OpenRouter can replace it later.



## Scope challenge

The implementation uses nine files, including the generated lockfile and a
strict TypeScript configuration added during implementation review. No router
abstraction, general tool registry, persistence, or provider-neutral content
model is needed yet.


| File                                  | Responsibility                                                           |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `package.json`                        | Scripts and the Anthropic SDK dependency                                 |
| `bun.lock`                            | Reproducible dependency resolution                                       |
| `tsconfig.json`                       | Strict local type-checking contract                                      |
| `.env.example`                        | Names the required key and optional model override                       |
| `src/model/anthropic.ts`              | Stable model adapter and Anthropic request/response translation          |
| `src/tools/fake-read-file.ts`         | Deterministic, canned `read_file` behavior                               |
| `src/loop.ts`                         | State machine, turn validation, retry policy, and executable entry point |
| `tests/loop.test.ts`                  | Protocol/state-machine unit tests with a fake model adapter              |
| `tests/anthropic.integration.test.ts` | Opt-in live API acceptance test                                          |


Types stay next to their owning module in this phase. Extract shared contracts
only when Step 2 introduces a second real consumer.

## Architecture

```text
task prompt
    |
    v
+--------------------+       ModelRequest       +----------------------+
| src/loop.ts        | -----------------------> | model/anthropic.ts   |
|                    | <----------------------- | callModel()          |
| owns plan + turns  |        ModelTurn         +----------+-----------+
| validates protocol|                                  |
+---------+----------+                                  v
          |                                      Anthropic Messages API
          |
          | validated read_file call
          v
+---------------------------+
| tools/fake-read-file.ts   |
| canned result, no I/O     |
+-------------+-------------+
              |
              | tool_result with matching tool_use_id
              v
         next model turn
```

The loop owns orchestration and state. The model adapter owns only provider
translation. The fake tool owns only canned results. This preserves the target
architecture's boundaries and makes the model adapter replaceable after this
phase.

## Turn contract

Claude receives two strict client-tool schemas:

1. `rewrite_plan`
  - Input is the entire current plan, not a delta.
  - Every task has a stable ID, description, and `pending | in_progress | completed` status.
  - Exactly one task may be `in_progress` unless all tasks are complete.
2. `read_file`
  - Input is `{ path: string }`.
  - It never touches disk in Phase 1.

For an active turn, the accepted response is:

```text
assistant content
  ├── rewrite_plan(full replacement)
  └── read_file({ path })          # zero only when the rewritten plan is complete
```

The loop validates the full response before applying the plan or running the
fake tool. Validation rejects unknown tools, duplicate plan updates, more than
one action, malformed inputs, action-before-plan order, and premature
`end_turn`. After validation, the loop applies `rewrite_plan` and produces a
correlated acknowledgment result, then runs `read_file` and produces its
correlated result. Both `tool_result` blocks are returned together in one user
message, in the same order as their `tool_use` blocks. The adapter preserves
Anthropic content blocks and tool-use IDs so this conversation shape remains
valid.

Although Anthropic supports strict tool schemas, local validation remains
mandatory at the application trust boundary. The remote guarantee and the
local invariant checks solve different problems.

Anthropic strict tool use supports a subset of JSON Schema. The wire schemas
therefore describe types, required fields, enums, and closed objects, while
unsupported semantic constraints such as an exact three-item plan and a
non-empty expected path are documented in tool descriptions and enforced
exactly by `validateTurn`.

## Data flow and state transitions

```text
START
  |
  v
create initial plan + prompt
  |
  v
callModel(messages, tools)
  |
  +-- transport/API error --------------------------> FAIL with clear cause
  |
  v
validate complete ModelTurn
  |
  +-- invalid protocol, first occurrence ----------> add correction, retry once
  |
  +-- invalid protocol, second occurrence ---------> FAIL, no tool executed
  |
  v
replace in-memory plan
  |
  +-- all tasks complete + no action --------------> COMPLETE
  |
  +-- plan incomplete + no action -----------------> invalid protocol
  |
v
execute fake read_file
  |
  v
append assistant blocks
  + one user message containing:
      1. rewrite_plan acknowledgment (matching ID)
      2. read_file result (matching ID, when present)
  |
  +-- maximum turns reached ------------------------> FAIL
  |
  +-------------------------------------------------> next turn
```



## Implementation tasks

- [x] **T1 — Bootstrap the Bun package**
  - Add `@anthropic-ai/sdk`.
  - Add scripts for the live Phase 1 run, unit tests, and the opt-in integration
  test.
  - Add `.env.example` with empty `ANTHROPIC_API_KEY` and
  `ANTHROPIC_MODEL=claude-haiku-4-5`.
  - Never read, print, or persist the key beyond process configuration.

- [x] **T2 — Implement the stable model adapter**
  - Export a narrow `callModel(request): Promise<ModelTurn>` interface.
  - Construct the Anthropic client from `ANTHROPIC_API_KEY`.
  - Default to the low-cost Claude Haiku 4.5 model, with an environment
  override.
  - Use the Messages API and native client-tool blocks, not JSON embedded in
  prose.
  - Preserve `stop_reason`, content blocks, usage, and tool-use IDs.
  - Convert provider errors into typed, actionable failures without leaking
  credentials.

- [x] **T3 — Implement the fake tool**
  - Accept only a non-empty relative path.
  - Return deterministic canned content for the three paths used by the
  acceptance scenario.
  - Return a clear canned "not found" error for any other path.
  - Perform no filesystem or shell operation.

- [x] **T4 — Implement the real-model loop**
  - Seed a three-item inspection task that requires three distinct reads.
  - Send explicit system instructions defining the full-plan rewrite protocol.
  - Validate each entire model response before mutating state.
  - Apply the rewritten plan, execute at most one fake action, append a matching
  result for every tool-use ID in one correctly ordered user message, and
  continue.
  - Retry one invalid model response once with a concise protocol correction.
  - Enforce a small maximum-turn ceiling and print a final summary containing
  status, turns, completed tasks, retries, and token usage.

- [x] **T5 — Add deterministic unit coverage**
  - Inject a fake `callModel` function so unit tests make no network calls.
  - Cover every response-validation branch and state transition.
  - Assert that rejected turns execute no tool and mutate no plan.
  - Assert that the second invalid response aborts.
  - Assert exact `tool_use_id` correlation in the next `tool_result`.

- [x] **T6 — Run the implemented live acceptance test**
  - The first authorized run reached Anthropic but returned HTTP 400 because
    the strict wire schema included unsupported constraints. The wire schema
    was corrected.
  - The second authorized run reached the model and exercised protocol
    recovery, then exposed rejected tool calls being replayed without results.
    Rejected turns no longer enter the provider transcript.
  - The third authorized run exposed a prompt-contract gap: validation required
    canonical task descriptions that the first request never supplied. The
    canonical initial plan is now included, contradictory status-change
    guidance was aligned with the validator, and the corrected rerun passed.
  - Skip with an explicit message when `ANTHROPIC_API_KEY` is absent.
  - With the key present, assert at least three model turns, three fake reads,
  a full valid plan on every turn, and a completed terminal plan.
  - Record token counts but never snapshot natural-language model text.
  - Run it a small fixed number of times if needed to distinguish a protocol
  defect from one stochastic miss; do not hide repeated failures with
  unlimited retries.



## Test coverage map

```text
CODE PATHS                                      TEST
callModel()
  ├── missing API key                           unit: clear preflight failure
  ├── successful tool_use response              integration: real API
  └── provider/network failure                  unit: normalized safe error

validateTurn()
  ├── plan + one read                           unit: accepted
  ├── completed plan + no read                  unit: accepted
  ├── missing/duplicate plan                    unit: rejected
  ├── unknown/duplicate action                  unit: rejected
  ├── malformed tool input                      unit: rejected
  ├── action before plan                        unit: rejected
  └── premature end/max_tokens/refusal          unit: rejected

runLoop()
  ├── three-turn completion                     unit + live integration [EVAL]
  ├── invalid response then recovery            unit
  ├── two invalid responses                     unit: abort
  ├── fake read not found                       unit: observation returned
  ├── maximum-turn exhaustion                   unit: abort
  └── both tool IDs/results correlated + ordered unit
```

The live test is an eval, not a deterministic unit test: it checks whether the
prompt and model reliably honor the turn protocol. All orchestration branches
remain covered by deterministic tests.

## Failure modes


| Failure                                             | Handling                                                                 | Test                     | User-visible result           |
| --------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------ | ----------------------------- |
| Missing API key                                     | Fail before client call                                                  | Unit                     | Clear setup instruction       |
| Rate limit, timeout, or API outage                  | Surface typed provider error; rely only on bounded SDK transport retries | Unit with injected error | Clear failure, no fake action |
| Model omits or corrupts full plan                   | Reject whole turn and retry once                                         | Unit + live eval         | Retry count in summary        |
| Model emits an unknown or multiple action           | Reject before execution                                                  | Unit                     | Clear protocol failure        |
| Tool arguments fail local validation                | Reject before execution                                                  | Unit                     | Clear validation failure      |
| Fake path is unknown                                | Return `is_error` tool result and let model recover                      | Unit                     | Visible observation           |
| Model stops before plan completion                  | Treat as protocol failure                                                | Unit                     | Clear failure after retry     |
| Model loops indefinitely                            | Maximum-turn guard                                                       | Unit                     | Clear ceiling failure         |
| Tool result is missing, reordered, or uses wrong ID | Construct both results only from the validated ordered blocks            | Unit                     | Prevented by invariant        |


No listed path may fail silently.

## Performance and cost guardrails

- Use Claude Haiku 4.5 for development and keep the model configurable.
- Cap output tokens per call at the smallest value that reliably carries the
plan and tool calls; start at 2,048 and adjust from measured failures.
- Do not stream in Phase 1. A single complete response is easier to validate
atomically and streaming is not needed to prove the boundary.
- Print per-run input/output token totals. Dollar accounting belongs to Step 8.
- Keep the maximum-turn ceiling below the later production ceiling; this
scenario should normally finish in three to six turns.



## Acceptance gate

Phase 1 is complete only when all of the following are evidenced:

- [x] `bun test` passes and makes no network call.
- [x] The live test passes with a locally supplied key.
- [x] One run contains at least three real model responses.
- [x] Deterministic coverage proves every accepted turn contains a validated
  full-plan replacement.
- [x] Deterministic coverage proves three typed `read_file` calls receive
  correlated fake results.
- [x] Every `rewrite_plan` and `read_file` call receives one ordered,
  ID-correlated result in the next user message.
- [x] The deterministic loop reaches a fully completed plan and exits.
- [x] A forced malformed-response test proves one retry, then abort.
- [x] Provider failures are sanitized and logs contain no secret or raw
  provider payload.
- [x] `loop-fake.ts` still runs, preserving Step 0's regression baseline.

After the evidence is captured, update `PLAN.md` Step 1 to `complete` and update
`PROGRESS.md` at session end. If the live acceptance gate cannot run, leave the
step `in progress`, not complete.

## Implementation record

Implemented on 2026-07-25 with `@anthropic-ai/sdk` 0.115.0, Bun 1.3.14,
TypeScript 5.9.3, and strict compiler settings.

Local evidence:

- `bun run typecheck`: pass
- `bun test`: 38 pass, 1 explicit live test skipped, 0 fail
- `bun run loop-fake.ts`: pass with four turns and one recovery
- gstack `/review`: four mechanical findings fixed, no unresolved code findings

The first user-authorized live run reached Anthropic and exposed a strict
schema compatibility defect: the raw tool schema sent `minItems`, `maxItems`,
and `minLength` constraints outside Anthropic's supported subset. Those
constraints were removed from the wire schema only; exact local guards remain
unchanged. A regression test now prevents their reintroduction, and safe 4xx
validation details are preserved without exposing the raw response envelope.

The next live run exposed a second integration defect after the model returned
an invalid-but-well-formed tool turn. The retry path appended that rejected
assistant turn plus correction text, violating Anthropic's requirement that
every replayed `tool_use` receive an immediate `tool_result`. The rejected
assistant content is now omitted exactly as ADR 0004 originally required. A
regression test proves rejected tool IDs do not enter the retry request. The
later corrected live acceptance run passed.

The third live run then failed local validation twice because task descriptions
were not preserved. The validator was correct, but the first model request
contained only fixture IDs and paths, not the canonical descriptions it
required Claude to copy. The initial prompt now serializes `createInitialPlan()`
as the authoritative plan. The same audit found and removed contradictory
guidance that allowed only one status field change even though advancing after
a successful read legitimately completes one task and starts the next.

The corrected live run passed on 2026-07-26. The integration assertions proved
completion, at least three real model responses, one full plan rewrite per
accepted turn, three correlated fake reads, a fully completed plan, and
non-zero input and output token usage. Repository status was identical before
and after the live command.

## NOT in scope

- OpenRouter or multi-provider normalization: after Steps 5–6, before the
first live-model/real-tool run or Step 7, per ADR 0006.
- Real filesystem access or the other five tools: Step 2.
- Zod TodoWrite persistence and crash recovery: Step 3. Phase 1 validates the
smaller turn contract only.
- MCP transport: Step 4.
- E2B, worktrees, and host isolation: Step 5.
- Hooks, budget enforcement, telemetry export, TUI, eval harness, and PR
creation: later roadmap steps.
- Streaming responses and parallel tool execution: neither is required to prove
this phase and both enlarge the failure surface.



## Execution order

Sequential implementation, no parallelization opportunity. The contract must be
fixed before the adapter, loop, and tests can agree on it:

```text
T1 bootstrap
  -> T2 adapter + T3 fake tool
  -> T4 loop
  -> T5 unit tests
  -> T6 live acceptance
  -> status updates
```

Estimated effort: **4–6 engineering hours**, with most uncertainty in prompt
iteration during the live acceptance test.

## References

- Anthropic tool-use overview:
[https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
- Anthropic tool-call lifecycle:
[https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- Anthropic TypeScript SDK:
[https://github.com/anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript)
- Current model guidance:
[https://platform.claude.com/docs/en/about-claude/models/choosing-a-model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model)
