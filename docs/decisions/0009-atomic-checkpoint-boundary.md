# 0009 — Commit agent turns with atomic versioned checkpoints

**Date:** 2026-07-27
**Status:** accepted

## Context

The loop previously kept its plan, transcript, observations, retry budget, and
token accounting only in memory. A process kill therefore discarded all
progress. Persisting only the plan would restore the checklist but lose the
provider conversation and the observation required to validate the next plan
transition.

## Decision

Persist a strict, versioned runtime snapshot to `.agent/state.json`, including
running, completed, and terminal protocol-failure lifecycle states. A turn is
committed only after its complete model response is validated, its tool
finishes, its observation and correlated results enter the transcript, and the
new snapshot is atomically installed.

Writes use a same-directory mode-0600 temporary file, file `fsync`, atomic
rename, and directory `fsync`. Invalid or incompatible state fails closed.
Only one process may own a repository checkpoint in v1.

A restart never replays a committed tool. Work interrupted before the commit
boundary may replay. This step connects only the read-only fixture tool, where
that replay is safe.

## Alternatives considered

- **Persist only the plan** — rejected because observation, retry, transcript,
  and accounting continuity would be lost.
- **Repository snapshot or stash before mutation** — rejected because it
  cannot reverse arbitrary shell effects or remote pushes.
- **Add exactly-once tool journaling now** — deferred because real tools are
  still deliberately disconnected from the model loop.

## Consequences

- Process termination resumes from the last complete turn.
- Unknown schema versions and corrupt state require explicit operator action.
- Exhausting the protocol retry remains terminal across process restarts.
- A failed checkpoint after tool execution can cause that uncommitted tool to
  replay on restart.
- Step 3 proves recovery only with the current read-only fixture protocol.

## Revisit when

Before the first live-model real-tool run after Steps 5–6, require idempotency
keys, a write-ahead execution journal, or operation-specific reconciliation for
every mutating tool. Do not expose `edit_file`, `run_shell`, or mutating git
operations to a model until that recovery contract is verified.
