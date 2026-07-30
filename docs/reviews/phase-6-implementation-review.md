# Phase 6 implementation review

**Date:** 2026-07-30  
**Branch:** `feat/pretooluse-guard`  
**Status:** Complete with no unresolved findings

## Scope

The branch implements the PreToolUse defense-in-depth boundary described by
ADR 0012: immutable task-root binding, strict model-visible schemas, serialized
execution, separate shell identity, protected runtime and Git metadata,
symlink-safe typed files, controlled process environments, network denial, Git
surface reduction, and focused red-team evidence.

Mutation recovery remains intentionally outside this branch and is the
mandatory next change under ADR 0009.

## Findings fixed during implementation

1. Model requests could include unknown fields such as a stale `repoPath`.
   Manual dispatcher validation now rejects unknown fields before policy or
   execution, matching the strict MCP schemas.
2. Existing-file edits assumed one write completed the requested byte range.
   The apply path now loops until every byte is written and fails if the
   filesystem makes no progress.
3. E2B bare template IDs resolved the provider's missing `default` tag. Live
   configuration now requires a tagged template reference and reports the
   expected format.
4. Template environment declarations were not present in E2B command
   processes. Canonical `/workspace` layouts now select fixed security
   defaults rather than depending on propagated environment variables.
5. GNU `timeout` rejected millisecond strings. The root-owned wrapper converts
   integer milliseconds to fractional seconds before execution.
6. A network test searched combined diagnostic output, so a failed Python
   traceback echoed the success marker from source text. The test now checks
   command stdout separately and proves the failure reached the network
   boundary.
7. E2B throws for `pgrep` exit 1 even though that is the expected
   no-process result. The negative control now normalizes absence into an
   explicit successful observation.

## Security review

The final `/cso` daily audit covered all phases and reported no findings at the
8/10 confidence threshold. Secret history and tracked configuration checks
found no credential exposure. `bun audit --json` returned no advisories. The
lockfile is tracked, `.env` and local security reports are ignored, and no
CI/CD, webhook, container, IaC, or deploy surface exists in this repository.

The attack model remains deliberately narrow and explicit: the model may
delete ordinary task content, but the clean bundle remains recoverable and the
model cannot use sandbox tools to alter the runtime, linked-worktree Git
control state, host, credentials, or external systems.

## Engineering review

The final `/review` scope check is clean. Every implementation unit in
`docs/plans/phase-6-pretooluse-safety-hook.md` is represented in code and
tests. The full diff was checked for trust-boundary violations, shell
injection outside the intended arbitrary-shell interface, concurrency errors,
schema drift, incomplete Git-surface removal, and documentation staleness.
No unresolved code finding remains.

Specialist subreviews were not dispatched because this session disallowed
sub-agent delegation. The main review applied the security, testing,
maintainability, performance, API-contract, and red-team checks directly.

## Acceptance evidence

- `bun run typecheck`
- `bun test`: 138 passed, 3 opt-in tests skipped, 0 failed
- `bun run test:mcp`
- `bun run test:sandbox`: 28 passed, 0 failed
- `bun run test:safety`: 4 passed, 0 failed
- `bun run loop-fake.ts`
- `bun run e2b:template:check`
- `bun run test:e2b:transport`: passed
- `bun run test:e2b:safety`: passed with the expected six-tool, identity,
  filesystem, process, Git, credential, and network assertions
- `bun run e2b:sandboxes:list`: zero running sandboxes after live gates
- `git diff --check`

The feature branch is ready to land. Merged-main verification repeats the
same required gates before `main` is pushed.
