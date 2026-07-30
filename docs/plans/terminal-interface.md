# Terminal Interface Implementation Plan

**Status:** implemented on `feat/terminal-interface`; merge verification
pending

## Scope

Provide `agent run <repo> "<task>"` as an Ink interface over the host-side
production runner. The interface observes typed runtime events; execution,
checkpointing, cancellation, mutation reconciliation, sandbox ownership, and
`SessionEnd` remain outside React.

OpenRouter remains supported but is not required for this work. Direct
Anthropic is the default production provider while OpenRouter paid capacity is
unavailable.

## Runtime contracts

`AgentEventSink` receives sequenced, timestamped events for run start, loaded
state, durable plan commits, paired tool activity, actual provider usage,
shutdown start, and run finish. Events never contain prompts, raw commands,
search patterns, or complete tool output. Tool summaries expose only
allowlisted repository-relative paths, Git operation names, globs, edit modes,
and working directories, capped at 2 KiB.

Delivery is asynchronous and failure-isolated. The reducer maintains no more
than 200 tool activities and 256 KiB of tool event state, evicting the oldest
completed activity while retaining the active operation and latest failure.

`AgentRunController.stop()` is idempotent. Shutdown ordering is:

1. Mark the run as stopping and publish `shutdown_started`.
2. Abort the current model, MCP, or policy request.
3. Await mutation reconciliation.
4. Close MCP and E2B resources.
5. Invoke `SessionEnd` once after cleanup, bounded at five seconds.
6. Publish `run_finished`.
7. Unmount Ink, restore terminal state, and return the exit code.

The complete shutdown phase is bounded at 30 seconds. Completion exits 0,
user cancellation 130, invalid command usage 2, and runtime or cleanup
failure 1. Exceeding the bound reports failure only after reconciliation and
cleanup reach a terminal state; the deadline never releases sandbox ownership
early.

## Command and resume behavior

The package publishes the Bun executable through its `bin` mapping. The
command validates `run`, repository, and task arguments; resolves the
repository path before runtime preparation; and renders `Initializing…`
before asynchronous validation or network activity.

The production runner canonicalizes the repository and derives identity from
the canonical path and normalized task. A matching valid checkpoint resumes
automatically. Corrupt, incompatible, mismatched, or another-task checkpoints
fail closed before model or sandbox calls. Step 7 provides no destructive
fresh-start flag.

TTY output uses Ink at a 30 FPS cap. Non-TTY output writes plain lifecycle
lines to stdout with no ANSI sequences; diagnostics use stderr.

## Layout

- At 120 columns or wider, plan, tool activity, and status/budget render in
  three columns.
- From 80 through 119 columns, plan and tools render in two columns with a
  full-width status/budget footer.
- Below 80 columns, all panes stack.

The plan always reflects the last committed checkpoint. Tool activity shows a
safe summary, active or final duration, and succeeded, failed, denied, or
cancelled outcome. Budget shows model turns and actual provider input/output
tokens. Dollar cost and enforced ceilings explicitly remain available in
Step 8; the tool-output token proxy is never presented as model usage.

## Verification

Offline coverage verifies:

- event ordering, pairing, durable-plan honesty, redaction, sequence
  monotonicity, and sink isolation;
- reducer count/byte bounds, active/latest-failure retention, all responsive
  boundaries, resize, Unicode, errors, and static output;
- invalid arguments and checkpoint mismatches before external activity;
- model, policy, read-only tool, mutation, and checkpoint-commit
  cancellation;
- exactly-once reconciliation, close, `SessionEnd`, and exit mapping.

PTY acceptance runs the packaged executable, checks terminal restoration on
completion, failure, and cancellation, and measures ten cold plus ten resumed
launches. The final complete-suite measurement was 198.5 ms maximum cold
first paint and 195.2 ms maximum resumed first paint, below the two-second
gate.

The final gate runs all offline, MCP, sandbox, safety, type, fake-loop,
template, and diff checks; performs a live E2B cancellation/reconciliation
check; confirms no running E2B sandboxes; and completes pre-landing review
before merge. The live cancellation gate completed in 5.6 seconds and
confirmed zero running E2B sandboxes before and after the run.
