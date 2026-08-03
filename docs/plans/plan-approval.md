# Step 8B — Durable plan approval

## Objective

Let a user inspect and correct the proposed design and scope before any
repository mutation or sandbox commit can occur. Discovery may spend model
budget and use bounded repository reads, but the checkpoint must reach a
durable approval state before the execution protocol can expose or dispatch a
mutating tool.

Step 8B is complete only when interactive approve/revise/cancel, explicit
non-interactive auto-approval, crash recovery, material reapproval, and
defense-in-depth mutation denial all pass offline and live E2B acceptance.

## Product contract

An interactive run follows this state machine:

```text
discovering
  -> read-only observation(s)
  -> proposed plan checkpointed
  -> awaiting_approval
       | approve -> approved -> executing
       | revise  -> discovering -> new proposed plan
       | cancel  -> cancelled

executing
  -> ordinary progress updates
  -> material replan requested
  -> awaiting_approval
```

The approval screen shows a bounded, structured proposal rather than only the
internal todo list. It includes:

- a concise implementation approach;
- product and visual direction, with an explicit `not_applicable` value when
  the task has no user-facing design;
- technology and dependency choices with rationale;
- included and excluded feature scope;
- acceptance criteria and how each criterion will be verified;
- material assumptions and unresolved questions;
- the ordered execution plan that becomes the initial committed todo plan.

Approve durably binds execution to the exact proposal digest. Revise accepts
bounded user feedback, records it as canonical discovery context, and requires
a newly generated proposal. Cancel is terminal and does not deliver a result.
A recovered `awaiting_approval` checkpoint renders the identical proposal and
does not make another model call.

## Trust boundaries and invariants

### Discovery is structurally read-only

The discovery model request uses a separate system prompt and tool list. It
may call exactly one of these per accepted turn:

- `read_file`;
- `ripgrep`;
- `tree_sitter_symbols`;
- `git` with only `status` or `diff`;
- `propose_plan` with the complete structured proposal.

`edit_file`, `run_shell`, and `git commit` are absent. The discovery Git schema
must not advertise `commit`, and a host-side phase guard must deny any
mutating `ModelToolRequest` before `session.call`. Tool visibility alone is
not an authorization boundary.

Every discovery response is validated atomically before a read is dispatched
or a proposal is saved. A read observation and the complete discovery
transcript are checkpointed before another paid call. The existing one-retry
protocol and paid-call reservation rules continue to apply.

### Approval is durable runtime state

Extend the production checkpoint with one bounded approval record owned by the
runtime, not the TUI. Its schema contains:

- phase: `discovering | awaiting_approval | approved | executing |
  cancelled`;
- current proposal, revision number, and SHA-256 digest;
- discovery transcript and bounded revision feedback history;
- approved proposal digest and approval mode;
- the reason and prior digest for a material reapproval request.

Schema refinements enforce, at minimum:

- `awaiting_approval` always has one validated proposal and no pending model
  or repository action;
- `approved`/`executing` has an approved digest equal to the current proposal
  digest;
- `discovering` cannot contain a pending mutation;
- `cancelled` is terminal and cannot contain a model reservation, pending
  turn, or deliverable result;
- execution cannot begin from a proposal whose ordered execution tasks do not
  match the initial committed todo plan.

Keep checkpoint v3 as the execution source of truth. Add a decoder migration
for old v3 checkpoints rather than creating an approval sidecar:

- fresh/empty running checkpoints migrate to `discovering`;
- terminal checkpoints remain inspectable and resumable for result delivery;
- a running legacy checkpoint that already contains execution or mutation
  history fails with an actionable `APPROVAL_MIGRATION_REQUIRED` error instead
  of being silently grandfathered as approved.

### User input is an injected port

The production loop waits through a typed approval port that returns exactly
one decision:

- `{ kind: "approve" }`;
- `{ kind: "revise", feedback }`;
- `{ kind: "cancel" }`.

The loop checkpoints `awaiting_approval` before invoking the port and
checkpoints the decision before continuing. Cancellation/termination while
waiting leaves the proposal awaiting approval so a later resume can show it
without spending again. Explicit `cancel` is different: it saves a terminal
cancelled checkpoint and returns the existing cancellation exit semantics.

The controller exposes a one-shot decision method scoped to the current
proposal digest. Stale or duplicate decisions are rejected. The TUI is only a
view/input adapter over approval events and this controller method.

### Auto-approval is explicit

Add `--auto-approve` to `agent run`. A human TTY defaults to interactive
approval and cannot inherit auto-approval from an environment variable.
Programmatic/headless callers must select an approval mode explicitly; the
evaluation harness selects `auto`, while unattended callers that omit a mode
fail before opening a sandbox or making a paid call.

Auto mode still creates the proposal, checkpoints `awaiting_approval`, and
then durably records an approval decision. It does not bypass proposal
generation, proposal validation, mutation guards, or later material
reapproval. A material replan in auto mode is auto-approved through the same
transition and is visible in the checkpoint.

### Material replans use the same gate

Execution keeps ordinary `rewrite_plan` status/ordering updates under the
approved proposal. Add a distinct `request_reapproval` protocol tool for
changes to protected intent: product/visual direction, dependencies,
included/excluded scope, acceptance criteria, or material assumptions.

The tool carries a complete replacement proposal plus a concise reason. The
runtime validates it, compares its protected-field digest with the approved
proposal, and:

- rejects a no-op request whose protected digest did not change;
- checkpoints the new proposal as `awaiting_approval` before any further
  model or repository call;
- retains the prior approved digest for audit correlation;
- resumes execution only after the replacement proposal is approved.

The model prompt must state when reapproval is required, but enforcement is
structural: protected proposal fields can change only through this transition.
Todo status and implementation-detail refinements that do not alter protected
intent remain ordinary `rewrite_plan` updates.

## Implementation substeps

Each substep is committed only after its focused checks pass.

### 1. Define approval schemas and checkpoint migration

Files:

- add `src/runtime/approval.ts` for proposal, decision, phase, digest, and
  material-change schemas/helpers;
- extend `src/runtime/schema.ts` with the bounded approval record and
  cross-field refinements;
- update `src/runtime/checkpoint.ts` migration/terminal fallback handling;
- add focused fixtures and tests in `tests/plan-approval.test.ts` and
  `tests/runtime-budgets.test.ts`.

Checks:

```sh
bun run typecheck
bun test tests/plan-approval.test.ts tests/runtime-budgets.test.ts
git diff --check
```

Commit: `feat(runtime): persist plan approval state`

### 2. Add the read-only discovery protocol

Files:

- split discovery and execution prompts/tool definitions in
  `src/runtime/production-loop.ts` (or small dedicated protocol modules if the
  loop would otherwise become harder to audit);
- validate and commit discovery reads and `propose_plan` atomically;
- reuse paid-call reservation, token/cost ceilings, compaction bounds, event
  summaries, and recovery behavior;
- hard-deny preapproval mutations before the sandbox session call.

Focused tests prove exact tool exposure, malformed proposal rejection, one
read per turn, read observation persistence, crash recovery, no mutation call
on a forged/recovered turn, and no extra paid call when an awaiting proposal
is resumed.

Checks:

```sh
bun run typecheck
bun test tests/plan-approval.test.ts tests/agent-runtime.test.ts tests/runtime-budgets.test.ts
git diff --check
```

Commit: `feat(runtime): add read-only plan discovery`

### 3. Implement approve, revise, cancel, and material reapproval

Files:

- add the typed approval port and state transitions to
  `src/runtime/production-loop.ts`;
- thread approval configuration through `src/runtime/agent-runner.ts`;
- add `request_reapproval` to the execution protocol without weakening the
  existing rewrite-plan/action atomicity;
- update cancellation and recovery validation so explicit cancel and process
  interruption remain distinct.

Focused tests cover approve-before-first-mutation, revision feedback becoming
canonical context, multiple revisions, explicit cancel, interruption while
waiting, stale/double decisions, auto approval, material reapproval, no-op
reapproval rejection, and mutation reconciliation refusing a preapproval
operation.

Checks:

```sh
bun run typecheck
bun test tests/plan-approval.test.ts tests/agent-runtime.test.ts tests/mutation-recovery.test.ts
git diff --check
```

Commit: `feat(runtime): enforce plan approval decisions`

### 4. Add interactive and static CLI/TUI UX

Files:

- extend `src/runtime/events.ts` with bounded approval-requested and
  approval-resolved events;
- update `src/tui/state.ts`, `src/tui/app.tsx`, and static output to render the
  complete proposal, revision, mode, and awaiting state;
- extend `src/cli.tsx` argument parsing with `--auto-approve` and wire
  interactive approve/revise/cancel input through the controller;
- update CLI/TUI/PTY tests and README usage.

TTY interaction must be keyboard usable, sanitize all proposal/feedback text,
show the exact proposal revision being decided, and keep Ctrl-C routed through
the existing single shutdown owner. Non-TTY output prints the bounded proposal
without terminal control sequences; it proceeds only with explicit
`--auto-approve`.

Checks:

```sh
bun run typecheck
bun test tests/plan-approval.test.ts tests/cli.test.ts tests/tui.test.tsx tests/tui-pty.test.ts
git diff --check
```

Commit: `feat(cli): add plan approval controls`

### 5. Documentation, review, and acceptance

- add ADR 0021 for the checkpoint-owned approval state machine;
- update README runtime/CLI/recovery documentation;
- update `docs/plans/product-delivery-gates.md` with final limits and evidence;
- run gstack review and resolve every accepted finding;
- record offline and live evidence, then update `PROGRESS.md` last.

Commit: `docs(runtime): document plan approval`

## Test and failure matrix

The dedicated suite must cover these boundaries:

| Boundary | Required proof |
| --- | --- |
| Tool exposure | Discovery schemas contain no edit, shell, or commit capability |
| Host authorization | Forged/recovered preapproval mutation never reaches `session.call` |
| Proposal validation | Oversize, missing, duplicate-ID, control-text, and inconsistent execution-plan proposals fail closed |
| Paid-call recovery | Ambiguous calls remain ambiguous; staged response resumes without replay |
| Approval recovery | Kill after proposal save and before/after each decision save; resume displays identical digest with no extra call |
| Revision | Feedback is bounded, durable, canonical, and yields a new proposal revision |
| Cancellation | Ctrl-C preserves awaiting state; explicit cancel is terminal with no delivery |
| Auto mode | Omission fails headlessly; explicit mode follows the same durable transitions |
| Reapproval | Protected changes pause before another mutation; ordinary todo progress does not pause |
| Migration | Empty legacy active state migrates; already-mutating active legacy state is refused |
| UX | Wide/narrow TTY, static output, invalid keys, feedback editing, Ctrl-C, and resumed proposal render correctly |
| Regression | Lifecycle, budgets, mutation recovery, result delivery, TUI, MCP, and sandbox suites remain green |

Use small injected runtimes and sessions for exhaustive kill-point tests. Live
tests are reserved for the final gate because they spend model budget and
create E2B resources.

## Complete definition of done

Run the full offline gate:

```sh
bun run typecheck
bun test
bun run test:runtime
bun run test:mcp
bun run test:sandbox
bun run test:safety
git diff --check
```

Then run two explicit live E2B scenarios against a disposable repository:

1. Interactive: discover, revise once, kill/restart while awaiting the second
   proposal, approve, implement, verify, deliver, and confirm no mutation
   journal entry predates the approved proposal digest.
2. Auto: run non-interactively with explicit `--auto-approve`, complete and
   deliver the task, and confirm the checkpoint contains the auto decision and
   exact approved digest.

For both scenarios, inspect the delivered branch, verify the required tests,
confirm sandbox cleanup, and confirm that cancellation before approval creates
neither a result branch nor a sandbox commit.

Finally:

- run gstack review and the documentation audit;
- push the completed feature branch;
- merge only after all acceptance gates pass;
- rerun the full offline gate on updated `main`;
- push `main`;
- update `PLAN.md` and `PROGRESS.md` to complete only after the merge and
  merged-main verification.

## Explicit non-goals

- Step 8C audit-file and inspection commands;
- browser/viewport evidence and evidence-backed completion;
- OpenTelemetry/Langfuse export;
- GitHub approval comments or remote approval channels;
- multiple simultaneous human approvers;
- approval of individual tool calls;
- hidden chain-of-thought capture or display.

## Primary risks

- **Transcript/counter drift:** discovery is a second protocol over the same
  paid-call ledger. Keep its transcript and committed-turn accounting explicit
  and include it in compaction and recovery invariants.
- **UI-owned truth:** Ink unmounts and process death must not lose or invent a
  decision. Save state before emitting resolution or continuing execution.
- **Semantic materiality:** the runtime cannot infer every design implication
  from free text. Protect the structured proposal fields and require all
  changes to them through `request_reapproval`; document that enforcement
  boundary honestly.
- **Legacy checkpoint bypass:** never treat prior mutation history as implicit
  approval. Fail active legacy work closed.
- **Headless accidental spend:** reject unattended runs without an explicit
  approval mode before sandbox creation or model transport.
