# 0001 — Build order sequences by risk, not by the spec's component numbering

**Date:** 2026-07-24
**Status:** accepted

## Context

The capstone brief's "Build It" section lists 8 steps grouped by component
(TUI, plan state, tool surface, sandbox, hooks, eval, cost control, PR
posting). Following that order literally means integrating the model, the
sandbox, and the TUI before any single piece is proven — three unknowns
debugged simultaneously the first time anything breaks.

## Decision

Rebuilt the order into 11 steps (0–10) sequenced by "what needs to be true
before the next thing is debuggable," deferring the two hardest external
dependencies (sandbox, MCP transport) until the loop logic they wrap is
already trustworthy against fakes/locals. Full table in `PLAN.md` §3.

## Alternatives considered

- **Follow the spec's 1–8 order literally** — matches the brief exactly, but
  means debugging model behavior, sandbox isolation, and TUI rendering all
  at once on first failure. Rejected: no isolated failure surface.
- **TUI-first** (build the visible part first for a demoable artifact early)
  — rejected because the TUI is a view over loop state that doesn't exist
  yet; building it first means mocking the very state it's meant to display.

## Consequences

- Easier: each step is independently runnable and demoable; failures are
  attributable to one new variable, not three.
- Harder: less visually impressive progress in the first few sessions
  (no TUI, no PR, just console output) — worth naming so it doesn't feel
  like stalling.
- Defers: MCP StreamableHTTP and Daytona comparison work until their
  dedicated exercises, rather than building both transports/sandboxes
  up front.

## Revisit when

Not expected to be revisited — this is an ordering choice, not a
capability choice. Would only reopen if a step turns out to have a hidden
dependency the table missed (e.g. step 6's safety hook needing telemetry
from step 9 to validate red-team results).
