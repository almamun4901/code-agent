# Phase 4 Implementation Review

**Date:** 2026-07-28
**Scope:** MCP v1 stdio server/client, discovery schemas, parity, and lifecycle
**Result:** complete; no unresolved findings

## Scope check

The implementation is a transport layer around the Step 2 dispatcher. It does
not refactor tool execution, connect real tools to the model loop, add a
sandbox, claim stronger containment, retry mutations, or begin Steps 5–7.
ADR 0009 remains a blocking gate for live-model mutation exposure.

## Findings and fixes

1. **Concurrent close returned before teardown completed.** Client shutdown now
   coalesces onto one promise, so every close caller waits for the owned
   transport and child process.
2. **Child-loss coverage exercised discovery rather than a tool call.** The
   lifecycle test now kills the stdio child and requires an actual call to
   reject within two seconds.
3. **Raw SDK protocol-error behavior was implicit.** Tests now record v1's
   `isError` normalization, prove the typed client throws on the noncanonical
   payload, and prove the connection remains usable.
4. **Discovery schemas could bypass dispatcher semantics.** Business rules such
   as shell timeout range now remain in the dispatcher; a 30,001 ms request
   has exact direct/MCP `INVALID_TIMEOUT` parity.
5. **A top-level Git union advertised an empty schema.** The v1-compatible
   object wrapper retains discriminated validation and publishes all four
   strict operation branches. Discovery tests now check every property,
   required field, annotation, and Git branch.
6. **Mutation parity omitted shell and final Git-state comparison.** Direct and
   MCP edit, shell, commit, and push paths now run in separate identical
   repositories and compare resulting bytes and repository state.
7. **Malformed-result handling lacked boundary tests.** In-memory MCP peers now
   verify rejection of non-JSON text, invalid `ToolResult` shape, and
   contradictory `isError`.

The security pass found no new in-scope trust-boundary defect. Known symlink,
host-shell, network, and mutation-recovery risks remain explicitly assigned to
Steps 5–6 and ADR 0009.

## Verification

- `bun run typecheck`: pass.
- `bun test`: 95 pass, 1 opt-in live test skipped, 0 fail.
- MCP suite: 14 pass, 0 fail.
- Step 0 regression: pass with four turns and one recovery.
- `git diff --check`: pass.

## gstack maintenance note

The `/review` result was persisted as clean after all findings were fixed.
The initial `/document-release` invocation stopped because its preflight
requires a feature branch and the implementation worktree was on `main`.
The final audit ran on `codex/step-4-documentation-finalization`, corrected
cross-document drift, and verified the required per-step branch workflow
before merge.
