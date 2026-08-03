# Gate 8A result-delivery implementation review

**Date:** 2026-08-03  
**Branch:** `feat/result-delivery`  
**Scope:** shared task-artifact permissions and transactional E2B Git result
delivery into a new local branch before cleanup.

## Scope audit

The branch implements Gate 8A only. It does not add Gate 8B plan approval,
Gate 8C completion evidence, telemetry, GitHub publication, or host-side model
writes. The sandbox remains the only model-controlled filesystem.

## Delivered boundary

The sandbox runs shell commands with a group-preserving umask, so files created
as `runner:task` remain writable by typed tools running as `agent`. After a
completed run, the host reconciles mutations, creates a final sandbox commit,
exports a delta Git bundle rooted at the exact starting SHA, and stages it in a
mode-0600 host store.

Validation occurs in a temporary bare repository before the host repository is
changed. It verifies the expected single result ref, base ancestry, commit and
object bounds, changed-path bounds, and rejects protected paths, control
characters, symlinks, and gitlinks. Import fetches objects and atomically
creates `result/<run-id>` without checkout. A durable receipt is saved before
the sandbox may be deleted.

Delivery transitions are `exported -> validated -> imported -> completed`.
Recovery reuses the staged bundle, recognizes an already imported identical
ref, and never creates a different branch for the same run. Delivery failure
disconnects MCP but preserves the sandbox lease for recovery. A completed
receipt is revalidated against the local ref without another model call.

## Review findings and fixes

The installed gstack review bundle had no mandatory `review/checklist.md`, so
the prescribed skill stopped. The same manual equivalent used for Step 8 was
run against `origin/main`: scope drift, shell injection, Git trust boundary,
recovery races, value completeness, and documentation staleness.

- Empty-result export: a completed no-op task had no `base..HEAD` objects and
  Git refused an empty bundle. Fixed by creating an explicit empty completion
  commit when HEAD still equals the base.
- Result tree escape: bundle/path checks did not reject changed symlinks or
  gitlinks. Fixed by validating raw diff modes and rejecting `120000`/`160000`,
  plus rejecting control-character paths.
- Failed-delivery lifecycle: E2B was preserved but the MCP connection remained
  live. Fixed with an idempotent disconnect that retains the sandbox recovery
  lease and blocks further calls through the abandoned session.

No unresolved critical or informational findings remain after these fixes.

## Verification evidence

- TypeScript strict check passes.
- Focused result/session/runtime suite passes, including interruption at all
  four transitions, idempotent resume, dirty-host refusal, malicious bundle and
  path rejection, owner-only state, and completed-receipt resume.
- Full offline suite passes with live provider/sandbox cases opt-in.
- Live E2B shell-create to typed-edit preview/apply passes under the separate
  `runner` and `agent` identities.
- Live E2B delivery creates `result/eeeeeeeeeeee`, preserves the active local
  branch and HEAD, exposes the delivered file through Git after cleanup, and
  leaves no running sandbox.
- Runtime template built successfully as
  `terminal-coding-agent-tools:result-delivery-v1`.
