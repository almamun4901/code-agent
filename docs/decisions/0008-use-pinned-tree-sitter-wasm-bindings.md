# 0008 — Use pinned Tree-sitter WASM bindings under Bun

**Date:** 2026-07-26
**Status:** accepted

## Context

Step 2 needs deterministic Python, JavaScript, TypeScript, and TSX symbol
parsing under Bun. The official native Node bindings were tried first, but
their native dependency failed to compile with the installed Node 24 toolchain
because its build did not enable the required C++20 mode.

## Decision

Use `web-tree-sitter` 0.20.8 with the matching pinned grammars from
`tree-sitter-wasms` 0.1.13. Load and cache the WASM languages in the real-tool
module and keep the symbol result contract independent of the parser runtime.

## Alternatives considered

- **Native `tree-sitter` bindings** — preferred initially, but rejected for
  Step 2 after a reproducible local compile failure under the supported Bun
  host.
- **Current `web-tree-sitter` with the available grammar package** — rejected
  because its newer dynamic-linking expectations were incompatible with those
  grammar artifacts.
- **Regex symbol extraction** — rejected because malformed-source recovery and
  nested syntax require a real parser.

## Consequences

- Symbol tests run offline under Bun without a native build step.
- Parser and grammar versions remain intentionally coupled and pinned.
- The dispatcher contract does not change if native bindings become viable
  later.

## Revisit when

When the native bindings compile cleanly in the supported Bun CI matrix, or
when the WASM packages require a security or grammar update.
