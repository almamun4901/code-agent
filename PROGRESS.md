# Progress Log — Terminal-Native Coding Agent

> Read this file first at the start of every session. Update it last, at the
> end of every session — five minutes now saves a full re-orientation later.
> This file tracks *where we are right now*. For the overall roadmap see
> `PLAN.md`. For why a choice was made see `docs/decisions/`.

---

## Current state (updated: 2026-07-28)

**Overall:** Steps 0–4 are complete. Step 4 adds exact six-tool MCP discovery,
a persistent stdio server/client boundary around the unchanged dispatcher,
canonical direct-versus-MCP result parity, strict malformed-result handling,
and owned child-process lifecycle. The final offline suite reports 95 pass,
1 opt-in live test skipped, and 0 fail.

**Step-by-step:**

| Step | Status | Notes |
|---|---|---|
| 0 — Fake loop | complete | Four turns; 3/3 tasks completed; one recovery |
| 1 — Real model, fake tools | complete | Authorized live gate passed; project worktree unchanged |
| 2 — Real tools, no sandbox | complete | Six tools, dispatcher, capped results, disposable repo harness |
| 3 — Plan schema + persistence | complete | Repeated hard-kill recovery passed without committed-read replay |
| 4 — MCP transport (stdio) | complete | Six tools have canonical direct/MCP parity; lifecycle and mutation checks pass |
| 5 — Sandbox (E2B) | not started | — |
| 6 — PreToolUse safety hook | not started | — |
| 7 — TUI (Ink) | not started | — |
| 8 — Remaining hooks + budget | not started | — |
| 9 — Telemetry | not started | — |
| 10 — Eval + PR posting | not started | — |

---

## Decisions made so far

- Build order deviates from the capstone spec's own 1–8 numbering — loop
  proven before sandbox, sandbox before TUI. See `PLAN.md` §3 for the full
  dependency reasoning.
- Single model (Claude API, direct) for steps 0–3. OpenRouter routing
  deferred until the loop itself is proven — no reason to debug
  model-agnostic normalization and agent logic at the same time.
- MCP transport: stdio first (step 4), StreamableHTTP later as exercise 5
  from the capstone spec, not as a step-4 requirement.
- Sandbox: E2B over Daytona, on the basis of JS SDK maturity fitting the Bun
  harness. No second data point yet — revisit only if E2B blocks on
  something specific.
- Cost control during *development* (not eval): use a cheap model (Haiku or
  similar) for all iteration on steps 1–9. Reserve the frontier model calls
  for the actual step-10 eval run, to avoid burning budget on debugging.
- tree-sitter: scoping to 2–3 languages actually present in the eval subset
  for v1, not all 17 up front.
- Model turns are atomic at the trust boundary: validate the complete
  `rewrite_plan` + optional `read_file` response locally before applying state
  or executing a tool. Retry one invalid response, then abort. See ADR 0004.
- Live provider tests are opt-in and excluded from `bun test`, even when a key
  is populated. See ADR 0005.
- OpenRouter no longer blocks deterministic Steps 2–6. It must land after the
  sandbox and PreToolUse guard, before the first live-model real-tool run or
  Step 7. See ADR 0006.
- Step 2 tool outputs use an injectable offline tokenizer with pinned
  `o200k_base` as a deterministic proxy, not as Anthropic billing truth. See
  ADR 0007.
- Step 2 symbol extraction uses pinned `web-tree-sitter` plus WASM grammars
  because the native bindings did not compile under the supported local
  Bun/Node toolchain. See ADR 0008.
- A turn is committed only after validation, tool completion, observation and
  transcript capture, and durable checkpoint replacement. Terminal protocol
  failure survives restart. See ADR 0009.
- Before a model receives mutating real tools, add idempotency, write-ahead
  journaling, or operation-specific reconciliation. Repository snapshots alone
  cannot cover shell side effects or remote pushes. See ADR 0009.
- MCP uses pinned stable SDK v1.30 over one persistent stdio connection.
  Results are one text block containing canonical JSON `ToolResult`, semantic
  validation stays in the dispatcher, and disconnected mutations are never
  retried. See ADR 0010.
- Every roadmap step starts from a freshly pulled `main` on its own branch.
  Each explicit substep is checked and committed separately; the completed
  branch is pushed, merged only after all gates pass, reverified on `main`,
  and then `main` is pushed. See `AGENTS.md` and `CLAUDE.md`.

---

## Open questions / blockers

- [ ] Confirm SWE-bench Pro Python subset is actually pullable and that a
  single task's environment reproduces cleanly — not yet dry-run.
- [ ] Confirm ripgrep and tree-sitter binaries are present in E2B's default
  sandbox template, or whether a custom image is needed.
- [ ] GitHub App not yet created — no fine-grained token, no scoped test
  repo. Needed by step 10, easy to forget until blocked on it.
- [ ] Langfuse: self-host via Docker Compose vs. cloud free tier for dev —
  not decided. Doesn't block anything until step 9.
- [ ] OpenRouter account/credits not yet set up — deferred until after Steps
  5–6, but flagging so it is not a surprise at the live real-tool boundary.
- [ ] Choose and verify mutation-recovery reconciliation before the first
  live-model real-tool run after Steps 5–6; this is a blocking ADR 0009 revisit.

---

## Session log

### 2026-07-24 — Planning session

- Reviewed capstone brief architecture and rubric.
- Re-sequenced the spec's 8 build steps into an 11-step order (0–10) based
  on dependency risk rather than component grouping.
- Wrote `PLAN.md`: architecture layer responsibilities, build order table
  with dependencies and hour estimates, out-of-scope table, risk register.
- Decided memory structure: `PLAN.md` (map, rarely edited) +
  `PROGRESS.md` (this file, edited every session) + `docs/decisions/`
  (ADRs) + `CLAUDE.md`/`AGENTS.md` (pointer file for coding agents).
- **Next session should start with:** Step 0 — write `core/loop.ts` as a
  hardcoded plan → hardcoded tool call → hardcoded observation cycle, no
  external dependencies. Definition of done: it runs via `bun run` and
  cycles at least 3 turns printing state transitions to console.

### 2026-07-25 — Step 0 fake loop

- What was done: Added `loop-fake.ts`, a dependency-free TypeScript state
  machine with three ordered fake tasks and explicit PLAN, ACT, OBSERVE, and
  RECOVER phases. The fake edit action fails once and succeeds on retry.
- What broke / had to be reworked: Bun was initially absent from the machine.
  Installed Bun 1.3.14 with the official installer, then reran the script.
- Decisions made this session: No new architectural decisions. The fake loop
  uses typed in-memory state and deterministic results solely to demonstrate
  the already-approved state-machine shape.
- Current status of the step in progress: Step 0 complete. `bun run
  loop-fake.ts` completed four turns, all three tasks, and one recovery with a
  successful exit.
- Next session should start with: Step 1 — design the real-model/fake-tool
  boundary, call one Claude model directly, parse its tool calls, and prove at
  least three real model-driven turns against a canned `read_file` response.

### 2026-07-25 — Step 1 environment preparation

- What was done: Added a local `.env` with an empty `ANTHROPIC_API_KEY`
  placeholder and a root `.gitignore` that excludes credentials, dependency
  folders, agent runtime state, and OS metadata.
- What broke / had to be reworked: Nothing.
- Decisions made this session: No architectural decisions.
- Current status of the step in progress: Step 1 remains not started; the
  environment file exists, but a real API key is still required for model
  verification.
- Next session should start with: Add `ANTHROPIC_API_KEY` locally, then design
  the real-model/fake-tool boundary before implementing Step 1.

### 2026-07-25 — Step 1 implementation planning

- What was done: Wrote `docs/plans/phase-1-real-model-fake-tools.md`, defining
  the model boundary, strict turn protocol, atomic validation and one-retry
  policy, fake `read_file` contract, file-level implementation tasks, complete
  test map, failure modes, cost guardrails, and evidence-based acceptance gate.
- What broke / had to be reworked: No code was changed or run. The repository
  has no `.git` metadata in this workspace, so branch and commit state could not
  be inspected.
- Decisions made this session: Phase 1 will use Anthropic's native client-tool
  blocks with strict remote schemas plus local validation. A whole model turn
  is validated before any state mutation or fake tool execution, making the
  single protocol retry side-effect safe. These refine ADR 0002 without
  changing its architecture.
- Current status of the step in progress: Step 1 is planned but not started.
  Live verification remains blocked until `ANTHROPIC_API_KEY` is populated
  locally.
- Next session should start with: Add the local API key, then implement T1 and
  T2 from `docs/plans/phase-1-real-model-fake-tools.md`; do not mark Step 1
  complete until the live three-turn acceptance gate passes.

### 2026-07-25 — Step 1 implementation and local verification

- What was done: Implemented the Bun/TypeScript package, current Anthropic SDK
  adapter, provider-neutral model contract, strict `rewrite_plan` and
  `read_file` schemas, atomic plan/act/observe loop, deterministic fake file
  reader, strict TypeScript configuration, 34-test offline suite, and explicit
  live integration test. Added a reader-facing README, testing instructions,
  Phase 1 review record, and ADRs 0004–0005.
- What broke / had to be reworked: Bun initially could not write its temporary
  dependency cache inside the sandbox, so dependency installation required the
  approved Bun install path. The first SDK constraint was stale and was updated
  from 0.68.0 to 0.115.0. Strict type-checking exposed unchecked array access,
  which was fixed. The sandboxed live API call failed to connect; the requested
  unsandboxed call was rejected because sending the synthetic transcript to
  Anthropic needs more explicit authorization. No bypass was attempted.
- Decisions made this session: Validate an entire model turn before any side
  effect and keep local validation exact even when the provider supplies strict
  schemas (ADR 0004). Keep live provider tests explicitly opt-in and offline
  tests deterministic (ADR 0005). Add `tsconfig.json` as a ninth Phase 1 file
  because static verification is part of a professional TypeScript boundary.
- Current status of the step in progress: Step 1 is in progress. `bun run
  typecheck` passes; `bun test` reports 34 pass, 1 live test skipped, 0 fail;
  `bun run loop-fake.ts` preserves the Step 0 four-turn/one-recovery baseline.
  Gstack `/review` found four mechanical issues, all fixed. The definition of
  done is not met until the live real-model test passes.
- Next session should start with: Explicitly authorize the outbound synthetic
  test, run `bun run test:integration`, capture the model-turn/token evidence,
  then mark Step 1 complete in `PLAN.md` and `PROGRESS.md`. Only after that
  should ADR 0002's OpenRouter revisit trigger be evaluated before Step 2.

### 2026-07-26 — Step 1 review readability cleanup

- What was done: Renamed the validator-local `readCalls` array to
  `readToolCalls` so it is distinct from the loop's numeric metric. Combined
  `planTool` extraction with its cardinality guard, removing a separate branch
  that existed only to satisfy `noUncheckedIndexedAccess`. Recorded both as
  non-bug follow-ups in the Phase 1 implementation review.
- What broke / had to be reworked: Nothing.
- Decisions made this session: No architectural decisions. These were local
  readability improvements that preserve ADR 0004's validation behavior.
- Current status of the step in progress: Step 1 remains in progress pending
  the authorized live Anthropic gate. `bun run typecheck` passes and `bun test`
  reports 34 pass, 1 live test skipped, 0 fail.
- Next session should start with: Authorize and run `bun run
  test:integration`, then update Step 1 status from evidence.

### 2026-07-26 — Live strict-schema 400 investigation

- What was done: Used gstack `/investigate` to trace the first authorized live
  test's HTTP 400 to unsupported `minItems`, `maxItems`, and `minLength`
  constraints in the raw Anthropic strict-tool schema. Replaced only those
  wire constraints with descriptions, retained exact local validation, added
  a regression test for the supported schema subset, and added sanitized 4xx
  validation detail for future diagnosis.
- What broke / had to be reworked: The original provider adapter discarded the
  API validation message, leaving only status 400. A direct diagnostic retry
  was not permitted because it would send repository-derived schemas
  externally, so no bypass was attempted; official provider documentation and
  the installed SDK transformer established the incompatibility.
- Decisions made this session: Provider-facing strict schemas must stay inside
  Anthropic's supported JSON Schema subset. Unsupported semantic constraints
  remain mandatory local invariants at the model trust boundary; ADR 0004 was
  updated to record this division.
- Current status of the step in progress: Step 1 remains in progress.
  `bun run typecheck` passes; `bun test` reports 36 pass, 1 live test skipped,
  0 fail; and `bun run loop-fake.ts` completes four turns with one recovery.
- Next session should start with: Rerun `bun run test:integration`. If it
  passes, capture model turns, reads, and token totals, then mark Step 1
  complete in `PLAN.md`, `PROGRESS.md`, and the Phase 1 acceptance checklist.

### 2026-07-26 — Live retry-transcript 400 investigation

- What was done: Used gstack `/investigate` on the second live HTTP 400. Traced
  the error to `runAgentLoop` appending a rejected assistant turn containing
  `tool_use` blocks, followed by correction text instead of required
  `tool_result` blocks. Restored the ADR 0004 contract: rejected content never
  enters the provider transcript; only the correction is appended.
- What broke / had to be reworked: The existing malformed-turn test used
  `stop_reason: end_turn` with no tool calls, so it could not expose orphaned
  tool IDs. A new regression test uses a semantically rejected turn containing
  two tool calls. It failed before the fix with three retry messages and passed
  after the fix with two user messages and no rejected IDs.
- Decisions made this session: No new architectural decision. The change
  restores the already-recorded atomic-rejection design in ADR 0004 and
  documents its provider-transcript consequence explicitly.
- Current status of the step in progress: Step 1 remains in progress.
  `bun run typecheck` passes and `bun test` reports 37 pass, 1 live test
  skipped, 0 fail.
- Next session should start with: Rerun `bun run test:integration`. If it
  passes, capture acceptance evidence and mark Step 1 complete across the
  roadmap, progress log, plan checklist, and implementation review.

### 2026-07-26 — Canonical initial-plan contract investigation

- What was done: Used gstack `/investigate` on the third live failure. Proved
  the first request required Claude to preserve canonical task descriptions
  without supplying them. Added the serialized `createInitialPlan()` output to
  the initial user prompt. Also aligned prompt and retry guidance with the
  validator's real rule: complete at most one task, then start the next task in
  the same plan rewrite when work remains.
- What broke / had to be reworked: A new request-contract test failed against
  the previous prompt because the initial message contained none of the task
  IDs or descriptions. A second assertion exposed the contradictory “one
  status change” instruction. Both assertions pass after the fix.
- Decisions made this session: The exact canonical state that the model must
  preserve must be present in its first request. Prompt transition language
  must use the same invariant vocabulary as local validation. ADR 0004 was
  updated; no new architecture was introduced.
- Current status of the step in progress: Step 1 remains in progress.
  `bun run typecheck` passes; `bun test` reports 38 pass, 1 live test skipped,
  0 fail; and the Step 0 fake loop still completes four turns with one
  recovery.
- Next session should start with: Rerun `bun run test:integration`. If it
  passes, record real turn/read/token evidence and mark Step 1 complete
  everywhere its acceptance state is documented.

### 2026-07-26 — Public repository creation

- What was done: Initialized Git on `main`, verified `.env` and dependencies
  are ignored, scanned the publishable tree for common credential patterns,
  reran type-check and the offline suite, created the initial commit, and
  published the project as the public GitHub repository
  `almamun4901/code-agent`.
- What broke / had to be reworked: The existing GitHub CLI credential had
  expired and required device-flow reauthentication. No project data was sent
  until authentication completed.
- Decisions made this session: The repository is public and uses `main` as its
  default development branch. No architectural decisions changed.
- Current status of the step in progress: Repository publication is complete.
  Step 1 remains in progress only because the corrected live Anthropic
  acceptance test has not yet passed.
- Next session should start with: Rerun `bun run test:integration`; if it
  passes, record the evidence, mark Phase 1 complete, commit the documentation
  update, and push it to `main`.

### 2026-07-26 — Step 2 dependency resolution and execution gate

- What was done: Resolved the ADR 0002/Step 2 dependency contradiction by
  superseding ADR 0002 with ADR 0006: OpenRouter now lands at the first
  live-model real-tool boundary, after E2B and PreToolUse, rather than blocking
  deterministic tool work. Added ADR 0007 for the pinned offline
  `o200k_base` output-budget proxy and wrote the decision-complete Step 2 plan,
  including disposable worktrees, preview/apply edits, explicit
  `replaceAll` semantics, and separate lexical-path versus temporary-root
  containment tests.
- What broke / had to be reworked: The offline Step 1 gate passed, but the live
  integration test could not connect from the restricted environment. The
  external retry was denied because this request did not explicitly authorize
  sending the documented synthetic prompt, plan state, and canned tool results
  to Anthropic. No bypass was attempted.
- Decisions made this session: OpenRouter is not a Step 2 dependency and no
  live model may receive real tools before OpenRouter, E2B, and PreToolUse are
  all present. `edit_file` treats multiple matches as valid only when
  `replaceAll: true`. Lexical path validation is permanent input validation;
  temporary-root containment is disposable development scaffolding.
- Current status of the step in progress: Step 1 remains in progress.
  `/Users/malm/.bun/bin/bun run typecheck` passes; the offline suite reports
  38 pass, 1 live test skipped, 0 fail; and the Step 0 regression completes
  four turns with one recovery. Step 2 remains not started.
- Next session should start with: Obtain explicit authorization for the
  documented Anthropic payload, rerun `bun run test:integration` externally,
  and mark Step 1 complete if it passes. Only then implement the Step 2
  temporary-repository harness.

### 2026-07-26 — Step 1 acceptance and Step 2 implementation

- What was done: Ran the explicitly authorized live Anthropic integration
  gate; it passed its completion, 3+ response, three-read, plan-rewrite, and
  non-zero-token assertions. Implemented runtime-validated contracts, typed
  errors, the no-op Step 6 policy seam, the capped result finalizer, disposable
  worktree/local-remote harness, and all six real tools. Added 27 Step 2 tests,
  completed the pre-landing review, and synchronized the roadmap, plans,
  implementation reviews, README, and agent instructions.
- What broke / had to be reworked: The official native Tree-sitter package
  failed to compile because its build did not enable the C++20 features
  required under Node 24. The current `web-tree-sitter` release was also
  incompatible with the available WASM grammar artifacts, so the matching
  0.20.8 runtime was pinned. Review then found that the first dispatcher
  version relied too heavily on compile-time types; complete runtime payload
  validation was added before the policy seam.
- Decisions made this session: Use pinned `web-tree-sitter` 0.20.8 with
  `tree-sitter-wasms` 0.1.13 for the supported Step 2 languages (ADR 0008).
  Keep the parser contract independent of that runtime so native bindings can
  replace it later.
- Current status of the step in progress: Steps 1 and 2 are complete.
  `bun run typecheck` passes; `bun test` reports 65 pass, 1 opt-in live test
  skipped, 0 fail; and `bun run loop-fake.ts` completes four turns with one
  recovery. Before/after status checks proved both the live gate and final
  offline/regression run left the project worktree unchanged.
- Next session should start with: Step 3 planning and engineering review for
  the Zod plan schema, atomic `.agent/state.json` persistence, and kill/restart
  recovery definition of done.

### 2026-07-27 — Step 3 plan schema and crash-safe persistence

- What was done: Added strict Zod TodoWrite and provider-neutral runtime-state
  schemas; extracted the loop into a versioned checkpointed state machine;
  added injectable memory and durable filesystem stores; implemented
  mode-0600 temporary writes, file and directory sync, atomic rename, orphan
  cleanup, symlink rejection, automatic/required/fresh startup policies,
  terminal failure persistence, and cross-field recovery validation. Added 15
  Step 3 tests, including two deterministic `SIGKILL`/restart cycles.
- What broke / had to be reworked: Bun dependency installation initially
  lacked temp-cache permission. Recovery after a rejected first response needed
  a narrow all-pending initial-state exception. Gstack review found that Zod
  trimming weakened exact task identity, terminal retry exhaustion could be
  bypassed by restarting, and checkpoint fields needed semantic correlation;
  all three were fixed with regressions.
- Decisions made this session: A committed turn ends only after durable
  checkpoint replacement. Interrupted uncommitted read work may replay;
  committed work may not. Exactly-once mutation recovery is deferred but is a
  blocking gate before live real tools, as recorded in ADR 0009.
- Current status of the step in progress: Step 3 complete. `bun run typecheck`
  passes; `bun test` reports 81 pass, 1 opt-in live test skipped, 0 fail;
  repeated hard-kill recovery passes; the Step 0 regression completes four
  turns with one recovery; and `git diff --check` passes.
- Next session should start with: Step 4 planning and engineering review for
  MCP stdio transport around the unchanged six-tool dispatcher, including
  direct-vs-MCP behavior parity tests.

### 2026-07-28 — Step 4 MCP transport over stdio

- What was done: Pinned `@modelcontextprotocol/sdk` 1.30.0; added exact
  discovery and wire-result schemas; implemented the six-tool MCP server,
  persistent typed client, and root-validating stdio entry point; added 14
  MCP tests covering discovery, protocol behavior, direct-result parity,
  independent edit/shell/Git mutations, all tool-family failures, containment,
  the 4,000-token budget, malformed results, startup, concurrent close, and
  child loss. Added ADR 0010 plus the Step 4 plan and implementation review,
  and synchronized README, PLAN, and agent instructions.
- What broke / had to be reworked: The SDK's safe child environment omitted
  macOS `TMPDIR`, which changed Git warning output in tests; the launcher now
  forwards only that variable in addition to the SDK allowlist. MCP SDK v1.30
  advertised a top-level Zod discriminated union as an empty object, so Git
  uses an object-shaped compatibility wrapper that retains and publishes all
  four strict branches. Review also found premature semantic schema checks,
  incomplete mutation parity, asynchronous close coalescing, and missing
  malformed-result coverage; each received a regression test. The final run
  also exposed the pre-existing 6,000-match edit test exceeding Bun's default
  5-second timeout on this machine; its explicit test timeout is now 10
  seconds, and both the isolated and full reruns pass. Gstack
  `/document-release` preflight could not formally continue on the `main`
  branch, so no branch or commit was created and the requested factual
  documentation sync was completed in place.
- Decisions made this session: Use stable MCP v1.30 and text-only canonical
  JSON results; omit duplicated structured content; retain dispatcher
  validation authority; use a 60-second MCP request timeout; never retry an
  ambiguous disconnected mutation. Raw SDK invalid-tool requests are
  normalized to `isError` results, while the typed client rejects their
  non-`ToolResult` payloads. See ADR 0010.
- Current status of the step in progress: Step 4 complete. `bun run typecheck`
  passes; `bun test` reports 95 pass, 1 opt-in live test skipped, 0 fail; the
  focused MCP suite reports 14 pass; `bun run loop-fake.ts` completes four
  turns with one recovery; and `git diff --check` passes. Gstack `/review`
  is recorded clean with no unresolved findings.
- Next session should start with: Step 5 planning and `/plan-eng-review` for
  moving this MCP server into E2B. First verify the E2B image has Bun (or a
  supported Node runtime), Git, ripgrep, and the pinned Tree-sitter WASM
  assets; then define the host-filesystem-unreachable probe and preserve the
  Step 4 parity suite across the sandbox boundary.

### 2026-07-28 — Step 4 documentation and branch-workflow finalization

- What was done: Pulled `origin/main` with `--ff-only`, created
  `codex/step-4-documentation-finalization`, and committed the new mandatory
  per-step Git workflow separately in `AGENTS.md` and `CLAUDE.md`. Ran the
  formal gstack `/document-release` audit across all 24 Markdown files, added
  README discoverability and task guidance, synchronized `PLAN.md` maintenance
  rules, corrected the stale Phase 1 live-gate status and T6 checklist, and
  replaced the obsolete Step 4 document-release preflight note.
- What broke / had to be reworked: The first Step 4 document-release attempt
  had correctly stopped on `main`. The feature-branch rerun exposed two pieces
  of factual drift: Phase 1 still claimed its already-passed live gate was
  pending, and the Step 4 review still described the earlier preflight stop as
  the final documentation state. Both are corrected without changing their
  historical failure narratives.
- Decisions made this session: Every future roadmap step must use the sequence
  pull `main` → create a dedicated branch → verify and commit each substep →
  run full acceptance/review/docs → push the branch → merge into updated
  `main` → reverify → push `main`. A step is not complete before that sequence
  finishes.
- Current status of the step in progress: Step 4 implementation, review, and
  documentation are complete. The finalization uses scoped commits on its
  dedicated branch; branch and merge evidence is preserved in Git history.
- Next session should start with: Pull the now-updated `main`, create a new
  dedicated Step 5 branch, and run `/plan-eng-review` before any E2B
  implementation. Do not reuse the Step 4 finalization branch.

---

## Template for future entries

Copy this block at the end of each session:

```markdown
### YYYY-MM-DD — <short session title>
- What was done:
- What broke / had to be reworked:
- Decisions made this session (also add to "Decisions made so far" above,
  and to docs/decisions/ if it's a real architectural choice):
- Current status of the step in progress:
- Next session should start with:
```
