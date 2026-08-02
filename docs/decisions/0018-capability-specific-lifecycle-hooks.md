# 0018 — Give lifecycle hooks capability-specific authority

## Context

Step 8 adds seven host-owned lifecycle hooks while preserving the sandbox-owned
`PreToolUse` boundary from Step 6. Treating every hook as mutable middleware
would let observation failures change execution and could move tool
authorization across the host/sandbox boundary.

## Decision

Use one typed hook registry with deterministic registration order, bounded
frozen inputs, at most 16 callbacks per hook, and one five-second deadline per
phase. `SessionStart`, `UserPromptSubmit`, `Stop`, and `PreCompact` are
fail-closed gates. `PostToolUse` and `Notification` are failure-isolated
observers. `SessionEnd` remains part of the shutdown result.

`PreToolUse` stays inside the sandbox dispatcher. The mandatory Step 6 policy
runs first and cannot be replaced; an optional sandbox-local extension may
deny only after that policy allows.

Runtime observation events remain a separate asynchronous view surface per
ADR 0016.

## Alternatives considered

- **One universal mutable middleware pipeline** — rejected because observer
  failures could control execution and weaken ADR 0016.
- **Host-side PreToolUse callbacks** — rejected because authorization and
  execution would be separated by a cross-boundary round trip.
- **All hooks fail closed** — rejected because a renderer or notification
  observer must not stop safe work.

## Consequences

Hook behavior is explicit and testable, and Step 9 gets one bounded invocation
surface to instrument. This is an internal TypeScript extension surface, not
dynamic plugin discovery or user-authored scripts.

## Revisit trigger

Revisit only if a real extension requires new authority that cannot be
expressed by the existing hook-specific result type.
