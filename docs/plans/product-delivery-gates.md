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

Checkpoint v4 owns the proposal, revision, feedback, digests, phase, and
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

**Implementation status:** complete on the feature branch; final review, live
acceptance, merge, and merged-main verification remain before the roadmap step
is marked complete.

Checkpoint v4 remains execution truth. `.agent/audit.jsonl` is a mode-0600,
append-only, hash-chained projection containing sequence and operation IDs,
proposal and state digests, bounded safe metadata, exact error/exit/timeout
facts, candidate Git identities, viewport case identities, and output digests
rather than raw output. The checkpoint cursor is the
commit point: recovery validates committed records and truncates a valid orphan
tail. Missing, reordered, corrupt, oversized, or mismatched committed evidence
fails closed.

The approved proposal contains a closed verification contract. Each acceptance
criterion references one or more stable requirements:

- `command` requires an exact repository-relative directory, shell command,
  and 1–30,000 ms timeout;
- `viewport` requires an exact server command, loopback port, route, 320–2560
  by 480–1600 viewport, and up to ten visible CSS selectors per case.

Visual proposals require viewport evidence. Verification tools dispatch only
when their ID and complete request match the approved proposal digest. Command
evidence requires exit 0, no timeout, a clean repository before and after, and
an unchanged commit/tree. A later mutation makes earlier evidence stale.

Viewport verification uses pinned Playwright 1.55.0/Chromium with E2B outbound
networking disabled. It opens only `http://127.0.0.1:<approved-port>`, checks
navigation, page/console errors, horizontal overflow, and selectors, then kills
browser/server process groups. At most 12 cases run across the entire approved
contract; screenshots are streamed through a bounded host reader, limited to
2 MiB each and 16 MiB per run, delivered outside the result worktree, revalidated
for hash/PNG structure, and stored mode 0600 under `.agent/evidence/`.

Completion requires evidence correlated to the approved plan:

- a delivered Git commit and summarized diff;
- terminal results for required checks, including command and exit code;
- no unresolved mutation or model reservation;
- explicit evidence types for special claims, such as real browser viewport
  checks for requested responsive frontend verification.

When evidence passes, the checkpoint becomes `finalizing` and model calls stop.
The runner reconciles mutations, exports/validates/imports the exact commit,
binds result-receipt v2 and audit evidence in a completion receipt, then saves
`completed` before cleanup. Delivery failure preserves the sandbox; restart
resumes finalization without another model call. The delivered tree must equal
the single candidate tree shared by every required check.

`agent inspect <repo> [--json] [--operation <uuid>]` validates these bindings
and reports requirement states, correlated tools, exact errors/exits, Git and
diff identities, screenshots, and completion/block reason. Valid incomplete
runs exit 0, integrity failures 1, and bad usage 2. Terminal pre-v4 checkpoints
are `legacy_unverified`; active v3 execution is refused. The TUI exposes the
same bounded evidence summary and audited tool details. Step 9 exports the
versioned redacted inspection projection asynchronously.
