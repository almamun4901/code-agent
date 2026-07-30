# Phase 6 — PreToolUse safety boundary

**Status:** Complete.

## Outcome

Treat model tool requests as hostile and enforce one task-scoped security
boundary before any tool executes. The fast policy layer explains obvious
denials; exact-root binding, serialized execution, filesystem permissions,
symlink-safe access, a restricted shell identity, process cleanup, and
network-off E2B sandboxes provide the actual confinement.

```text
Untrusted model request
  -> strict schema
  -> canonical worktree binding
  -> PreToolUse allow/deny decision
  -> per-session execution queue
      -> typed file/Git tools as agent
      -> arbitrary shell as runner
  -> bounded ToolResult observation
```

## Protected resources and invariants

- The model never selects a repository root. One realpath-resolved task
  worktree is injected into every internal tool call.
- `/opt/agent`, linked-worktree Git metadata, host credentials, and external
  networks are unavailable to arbitrary shell commands.
- All model-visible reads and writes stay inside the task worktree. Typed file
  tools reject symlinks and agent-control paths.
- A policy denial or policy failure executes no tool and returns a stable,
  bounded observation. The next safe tool request can still run.
- Git status, diff, staging, and commit remain available. Push and PR creation
  stay on the trusted host.
- Ordinary worktree content remains mutable and can be deleted. The clean Git
  bundle is the recovery source; protecting normal task files from the task
  itself is not a security claim.

## Implementation units

1. Split model-visible requests from rooted internal calls, add structured
   policy decisions, and serialize one task's tool executions.
2. Harden the E2B image with immutable runtime files, separate `agent` and
   `runner` identities, a fixed root-owned shell wrapper, protected Git
   metadata, and disabled internet access.
3. Add component-wise symlink rejection, no-follow file operations, and
   protected path rules without weakening edit preview/version semantics.
4. Run shell commands with a non-login shell, an explicit environment, bounded
   process lifetime, descendant cleanup, and narrow fast-fail diagnostics.
5. Remove Git push and disable hooks, helpers, signing programs, pagers, and
   external diff execution.
6. Add focused offline and opt-in live E2B red-team suites.

## Acceptance

- `rm -rf` outside the worktree, traversal, and symlink escape attacks are
  blocked with written red-team cases and zero protected side effects.
- Runtime/Git metadata writes, direct and interpreter-based network attempts,
  inherited-secret probes, device writes, and surviving background processes
  are also covered.
- Legitimate file edits, searches, tests, Git diffs, and Git commits continue
  to work.
- Typecheck, complete offline tests, focused MCP/sandbox/safety tests, the
  fake-loop regression, template validation, live E2B transport/isolation/
  safety gates, and `git diff --check` pass.
- The completed branch passes `/cso`, `/review`, and documentation review,
  then is pushed, merged into updated `main`, reverified, and pushed.

## Sequencing and non-scope

Estimated implementation time is 10–14 hours. The remaining lifecycle hooks,
StreamableHTTP, network allowlists, final publication, and mutation recovery
are not part of this branch.

ADR 0009 remains a hard gate: after this branch lands, mutation reconciliation
must be implemented on a separate `fix/mutation-recovery` branch before
OpenRouter or Step 7 begins.
