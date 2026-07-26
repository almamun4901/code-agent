# 0003 — E2B over Daytona for the sandbox layer

**Date:** 2026-07-24
**Status:** accepted

## Context

The architecture allows either E2B or Daytona for sandboxed, worktree-isolated
task execution. Building an abstraction over both from the start means
designing an interface with only one real implementation to test it
against — premature generalization with no second data point.

## Decision

Build against E2B only for v1. No sandbox-provider abstraction layer.

## Alternatives considered

- **Daytona** — devcontainer-based, plausible fit, but JS SDK maturity is
  the deciding factor given the harness is Bun/TypeScript-native; E2B's SDK
  fits more directly. Not rejected outright — just not first.
- **Build an abstraction over both immediately** — rejected as premature:
  an interface designed for two implementations before either one is proven
  tends to leak assumptions from whichever was built first anyway.

## Consequences

- Easier: `sandbox/e2b.ts` can be written directly against what E2B actually
  provides, without speculative interface design.
- Harder: if E2B turns out to be a poor fit (missing binaries in default
  images, isolation gaps), there's rework rather than a swap.
- Exercise coverage: the capstone's exercises don't explicitly require a
  Daytona comparison, so this isn't blocking any rubric item.

## Revisit when

If E2B's default sandbox template is missing required binaries (ripgrep,
tree-sitter) with no viable custom-image path, or if a concrete isolation
gap is found during step 6's red-team testing that E2B can't close.
