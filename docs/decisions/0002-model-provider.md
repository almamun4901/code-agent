# 0002 — Direct Claude API for steps 0–3, OpenRouter deferred

**Date:** 2026-07-24
**Status:** superseded by 0006

## Context

The target architecture routes through OpenRouter for model-agnostic access
to Claude Sonnet 4.7, GPT-5.4-Codex, and Gemini 3 Pro. Building that
normalization layer at the same time as the plan/act/observe loop means any
bug could be in the loop, the routing, or the provider's response shape —
no way to isolate which.

## Decision

Use a single hardcoded model via the Claude API directly for steps 0–3.
Introduce `router.ts` and OpenRouter only once the loop's turn-taking,
plan-rewriting, and tool-call parsing are proven against one known-good
provider.

## Alternatives considered

- **OpenRouter from the start** — matches the final architecture diagram
  exactly, but means the first debugging session has to distinguish "is this
  a loop bug or a routing bug" with no prior baseline. Rejected.
- **Mocked model responses throughout early steps** — even more isolated,
  but step 1's explicit goal is proving the model reliably emits valid
  tool-call JSON and rewrites full plan state; a mock can't tell us that.
  Rejected for step 1 specifically (used anyway in step 0).

## Consequences

- Easier: step 1 failures are unambiguously loop/prompt issues.
- Harder: swapping in `router.ts` later requires the loop's model-call
  interface to be designed for it in advance (a single `callModel()`
  function with a stable input/output shape), even before OpenRouter exists.
- Cost note: use a cheap model (e.g. Haiku-class) for all steps 0–9
  iteration; reserve the frontier model for the actual step-10 eval run.

## Revisit when

Superseded by ADR 0006. Step 2 is a deterministic tool-correctness phase and
does not call a model, so OpenRouter is no longer a Step 2 entry gate.
