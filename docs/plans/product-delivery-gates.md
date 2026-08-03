# Product delivery gates

These gates were added after the first live greenfield dogfood run. They sit
between lifecycle budgets and telemetry because the agent is not practically
usable until completed work is returned, approved intent governs mutations,
and completion is backed by inspectable evidence.

## Gate 8A — Result delivery

**Implementation status:** complete on merged `main`; offline, live E2B, and
real-model delivery acceptance gates pass.

The sandbox remains the only model-controlled filesystem. Before cleanup, the
trusted host must receive a bounded Git artifact rooted at the exact bundled
commit, validate its object graph and changed paths, and import it into a new
local branch. It must never switch, reset, or modify the user's current branch
or a dirty worktree.

The delivery state is transactional:

```text
sandbox commit
  -> export staged
  -> host validates base and bounds
  -> local branch imported
  -> receipt checkpointed
  -> sandbox cleanup allowed
```

Recovery may repeat validation and an idempotent import, but may not create a
second branch containing different bytes. Failed export keeps an actionable
recovery record. The gate also fixes shared-group permissions so a file created
by `run_shell` can subsequently pass typed edit preview/apply under `agent`.

Acceptance evidence includes shell-create → typed-edit parity, dirty-host
refusal, malicious bundle/path rejection, death at every delivery transition,
idempotent resume, and a completed local-only calculator appearing on a new
local branch after E2B cleanup.

The implementation uses `result/<first-12-run-id>` for the deterministic local
branch. It bounds the bundle to 16 MiB, the introduced object graph to 64 MiB
and 10,000 objects, history to 200 commits, and changed paths to 2,000. Changed
`.git`/`.agent` paths, control-character paths, symlinks, and gitlinks are
rejected. A successful no-op task receives an empty completion commit so it
still has an exportable, inspectable result receipt.

## Gate 8B — Plan approval

**Implementation status:** complete. Implementation, review, merged-main
offline verification, interactive revision/restart E2B, explicit auto-approval
E2B, result delivery, cancellation, and sandbox cleanup gates pass.

Interactive runs begin in read-only discovery. The proposed artifact must make
product choices visible—not merely list implementation verbs—including visual
direction, technology, feature scope, acceptance checks, and material
assumptions.

The runtime then checkpoints `awaiting_approval` and offers approve, revise,
or cancel. Revision feedback becomes canonical task context and produces a new
proposal. Mutation-capable tools are absent or denied until approval is
durably committed. Resuming an awaiting run displays the same proposal without
another paid call. Material changes to design, dependencies, or acceptance
criteria require reapproval; ordinary progress updates do not.

Non-interactive evaluation must opt into auto-approval explicitly. It cannot
be the default for a human TTY session.

Checkpoint v3 owns the proposal, revision, feedback, digests, phase, and
reapproval metadata. Discovery exposes only bounded file reads, search,
symbol lookup, Git status/diff, and `propose_plan`; a second host guard rejects
forged or recovered preapproval mutations before sandbox dispatch. Approval is
checkpointed before the execution plan is installed. Ctrl-C preserves
`awaiting_approval`, while explicit cancel is terminal with exit code 130 and
no delivery. Protected approach, product/visual direction, technology, scope,
acceptance, assumptions, and unresolved-question changes require
`request_reapproval`; todo progress alone does not.

Interactive TTY runs use the approval screen. Programmatic interactive runs
must inject an approval handler. Non-TTY runs must pass `--auto-approve` (or
the typed `approvalMode: "auto"` option); persisted state and environment
variables are not authorization for a new invocation.

## Gate 8C — Completion evidence and inspection

Checkpoint v3 remains execution truth. Add a host-readable inspection command
and bounded, mode-0600 audit projection with sequence IDs, operation IDs,
redacted arguments, exact error codes, terminal results, durations, and state
digests. Do not claim access to hidden model reasoning and do not persist
unbounded secrets or source payloads.

Completion requires evidence correlated to the approved plan:

- a delivered Git commit and summarized diff;
- terminal results for required checks, including command and exit code;
- no unresolved mutation or model reservation;
- explicit evidence types for special claims, such as real browser viewport
  checks for requested responsive frontend verification.

Plan checkmarks remain useful navigation, but they cannot independently
authorize completion. The TUI should expose drill-down summaries; the inspect
command provides durable detail after terminal exit. Step 9 then exports the
same evidence asynchronously to OpenTelemetry and Langfuse.
