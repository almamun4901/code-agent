# Project context for coding agents

This file is read by Claude Code, Cursor, and similar tools at the start of a
session. Read it, then read the three files it points to, before writing or
editing any code.

## Required Git workflow for every roadmap step

Follow this sequence for each step in `PLAN.md`:

1. Start from a clean worktree on `main` and run `git pull --ff-only origin
   main` before doing any step work. If local changes prevent a safe pull, stop
   and resolve them instead of carrying them into the new step.
2. Create a dedicated branch from the updated `main` for that step. Do not
   implement a roadmap step directly on `main`.
3. Break the step into explicit substeps. After each substep, run its relevant
   type checks, tests, linters, and acceptance checks. Commit that substep only
   after its checks pass; keep commits scoped and independently understandable.
4. After every substep is committed, run the step's complete definition of
   done, gstack review, and documentation checks. Push the completed step
   branch only when all required checks pass.
5. Merge the step branch into an up-to-date `main` only after the pushed branch
   has passed all reviews and acceptance gates. Reverify the merged result,
   then push `main`.

Do not mark a roadmap step complete until this branch, verification, push, and
merge sequence is finished. Never silently reuse a branch from an earlier step.

### Branch and commit naming

- Never include `codex`, an agent name, or an AI/vendor prefix in a branch
  name. Name branches for the actual change using
  `<type>/step-<number>-<short-description>`, for example
  `feat/step-5-e2b-sandbox`, `fix/mcp-client-close`, or
  `docs/step-4-finalization`.
- Use a valid Conventional Commit message:
  `<type>(<optional-scope>): <imperative summary>`.
- Select the type from the actual primary change:
  - `feat` for a new product capability;
  - `fix` for a bug correction;
  - `docs` for documentation-only changes;
  - `refactor` for code restructuring without a behavior change;
  - `test` for test-only changes;
  - `perf` for performance improvements;
  - `build`, `ci`, or `chore` for their corresponding maintenance work.
- Keep the subject specific, imperative, and concise. Do not use vague messages
  such as `update code`, mislabel documentation as a feature, or combine
  unrelated changes in one commit.
- Never add `codex`, agent branding, AI-generation notices, or automatic
  agent-attribution trailers to a commit message.

## Read in this order

1. **`PLAN.md`** — the overall roadmap: architecture, build order (steps
   0–10), dependencies, definitions of done, out-of-scope list, risk
   register. Changes rarely.
2. **`PROGRESS.md`** — current state: which step we're on, what's blocked,
   what the last session did, what the next session should start with.
   Changes every session — this is the most recently accurate source of
   "where are we."
3. **`docs/decisions/`** — one file per non-obvious architectural choice
   (model provider, sandbox choice, build order, etc.), with context,
   alternatives considered, and the specific trigger to revisit it. Check
   here before re-deciding something that may already have been decided.

## Working conventions

- **Don't skip ahead in the build order.** `PLAN.md` §3 has an explicit
  dependency table (e.g. the TUI depends on steps 3, 4, and 5 being done).
  If asked to work on a step whose dependencies aren't marked done in
  `PROGRESS.md`, say so before proceeding.
- **State your understanding before acting.** At the start of a session,
  restate what you think the current step and next task are, based on
  `PROGRESS.md`, before writing code. This catches drift early and cheaply.
- **Update `PROGRESS.md` at the end of the session**, not during. Use the
  template at the bottom of that file. Include: what was done, what broke,
  any new decisions (also add real architectural ones to
  `docs/decisions/`), and what the next session should start with.
- **One step's definition of done is a checklist, not a vibe.** Each step in
  `PLAN.md` §3 has a concrete "definition of done" — treat a step as
  complete only when that specific condition is verifiable (e.g. "kill -9
  mid-turn and confirm resume from `.agent/state.json`"), not when the code
  merely runs once.
- **New architectural decision → new ADR.** Use
  `docs/decisions/0000-template.md` as the starting point. Number
  sequentially. Keep it short: context, decision, alternatives, consequences,
  revisit trigger.
- **Cost discipline during development**: use a cheap model for iteration
  (see `docs/decisions/0002-model-provider.md`); the frontier model is
  reserved for the actual step-10 eval run.

## Current step

Check `PROGRESS.md` for the authoritative answer — do not rely on this
file's memory of it, since this section is not kept in sync.
