# Progress Log — Terminal-Native Coding Agent

> Read this file first at the start of every session. Update it last, at the
> end of every session — five minutes now saves a full re-orientation later.
> This file tracks *where we are right now*. For the overall roadmap see
> `PLAN.md`. For why a choice was made see `docs/decisions/`.

---

## Current state (updated: 2026-07-30)

**Overall:** Steps 0–6 are complete. Step 6 binds every model request to one
canonical task root, serializes execution, runs shell commands as a restricted
`runner`, protects the runtime and Git control state, rejects symlinked typed
paths, scrubs process environments, disables sandbox internet, removes Git
push, and kills leftover runner processes. Final verification reports 138
offline tests, 15 focused MCP tests, 28 focused sandbox tests, and 4 focused
safety tests passing; both live E2B gates pass and leave zero running
sandboxes. ADR 0009 mutation recovery is now the mandatory next change.

**Step-by-step:**

| Step | Status | Notes |
|---|---|---|
| 0 — Fake loop | complete | Four turns; 3/3 tasks completed; one recovery |
| 1 — Real model, fake tools | complete | Authorized live gate passed; project worktree unchanged |
| 2 — Real tools, no sandbox | complete | Six tools, dispatcher, capped results, disposable repo harness |
| 3 — Plan schema + persistence | complete | Repeated hard-kill recovery passed without committed-read replay |
| 4 — MCP transport (stdio) | complete | Six tools have canonical direct/MCP parity; lifecycle and mutation checks pass |
| 5 — Sandbox (E2B) | complete | Six remote tools, exact task worktree, host-isolation sentinel, process-loss handling, and cleanup verified on merged `main` |
| 6 — PreToolUse safety hook | complete | Exact-root binding, two identities, symlink-safe files, offline shell, reduced Git, and red-team/live gates pass |
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
- Model-visible tool schemas contain no repository root. The MCP session binds
  one realpath-resolved worktree, validates before policy, returns structured
  denials, and serializes all tools. See ADR 0012.
- Arbitrary shell is not made safe through parsing. It runs as `runner`
  through a fixed root-owned wrapper with a controlled environment, timeout,
  descendant cleanup, protected Git/runtime permissions, and E2B networking
  disabled. Typed tools and Git run as `agent`. See ADR 0012.
- Git push is absent from the sandbox contract. Git status, diff, and commit
  run with hooks, helpers, signing, pagers, and external diff execution
  disabled; publication remains a trusted host operation.

---

## Open questions / blockers

- [ ] Confirm SWE-bench Pro Python subset is actually pullable and that a
  single task's environment reproduces cleanly — not yet dry-run.
- [x] Confirm E2B runtime contents: the default image has Node and Git but
  lacks Bun and ripgrep, so Step 5 uses the successfully built pinned template.
- [ ] GitHub App not yet created — no fine-grained token, no scoped test
  repo. Needed by step 10, easy to forget until blocked on it.
- [ ] Langfuse: self-host via Docker Compose vs. cloud free tier for dev —
  not decided. Doesn't block anything until step 9.
- [ ] OpenRouter account/credits not yet set up — deferred until after Steps
  5–6, but flagging so it is not a surprise at the live real-tool boundary.
- [ ] Choose and verify mutation-recovery reconciliation before the first
  live-model real-tool run, OpenRouter, or Step 7; this is the mandatory next
  branch and a blocking ADR 0009 revisit.
- [x] Resolve the focused live-gate failure. The initial ambiguous E2B create
  response was followed by a successful bounded run. Template workspace
  ownership and the newline-aware probe assertion were corrected; the real
  MCP handshake, six-tool discovery, read call, process-loss failure, and
  cleanup now pass.
- [x] Run the full live six-tool isolation gate.
- [x] Complete Step 5 review, documentation, scoped commits, and feature-branch
  push.
- [x] Merge and complete merged-main verification.
- [x] Complete Step 6 security, engineering, documentation, red-team, and live
  E2B acceptance gates.

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

### 2026-07-28 — Step 5 offline implementation and live-gate authorization stop

- What was done: Preserved the existing branch/commit naming instructions in
  their own commit, updated `main`, and created `feat/e2b-sandbox`.
  Renamed the dispatcher hook seam to `PreToolUse` and committed the verified
  refactor. Pinned E2B 2.14.1; implemented the remote stdio transport, pinned
  runtime-template definition and manifest, clean Git-bundle intake,
  branch-backed worktree provisioner, owned task-session lifecycle, and
  opt-in transport/isolation integration tests. The E2B base image probe
  confirmed Node and Git are present while Bun and ripgrep are absent.
- What broke / had to be reworked: A queued-send lifecycle test initially
  exposed a test-observation deadlock and was corrected without changing the
  transport contract. The first live spike would have uploaded the runtime
  into every sandbox, so it was narrowed to a single allowlisted template
  build. Both attempts to run an external source upload were denied pending
  explicit user authorization; no workaround was attempted.
- Decisions made this session: Keep runtime source export limited to
  `package.json`, `bun.lock`, and `src/` during the template build. Live tests
  use that immutable template and upload only disposable fixture repositories.
  Preserve no-retry transport semantics and fail-closed reverse-order cleanup.
- Current status of the step in progress: Step 5 remains in progress. Typecheck
  passes; the focused sandbox suite reports 21 pass and 0 fail; the full
  offline suite reports 115 pass, 3 opt-in tests skipped, and 0 fail; the Step
  0 regression and `git diff --check` pass. Transport/template/session changes
  are intentionally uncommitted because their required live gates have not
  passed.
- Next session should start with: Obtain explicit authorization for the
  allowlisted E2B template upload, build the template, record its immutable
  ID locally, run both live E2B gates, then review and commit each verified
  Step 5 substep.

### 2026-07-28 — Step 5 template build and live-gate stop

- What was done: Received explicit authorization for the allowlisted E2B
  upload. Built the pinned `step-5-v1` runtime template after correcting its
  build-user ordering. The image verified Bun 1.3.14, Git 2.47.3, ripgrep
  14.1.1, and the pinned Tree-sitter WASM assets. Started the focused MCP
  transport gate with the required tagged template reference.
- What broke / had to be reworked: The first template build failed because
  E2B's Bun base image selected its unprivileged `user` before creating
  `/opt/agent`; the template now performs setup as root, transfers ownership,
  and restores `user`. A bare template ID selected E2B's missing `default`
  tag and was corrected to the pinned `step-5-v1` tag. The subsequent
  create-sandbox request returned truncated JSON after about 122 seconds,
  despite creating a running sandbox without returning its handle.
- Decisions made this session: Honor the no-retry stop condition and free-tier
  constraint. A read-only account listing found the exact orphaned sandbox;
  it was explicitly killed, and a second listing confirmed zero running
  sandboxes. No broad isolation suite was started and no transport fallback
  was selected silently.
- Current status of the step in progress: Step 5 remains in progress. The
  template build gate passes, but the real MCP handshake and isolation gates
  have not run because sandbox creation produced an ambiguous provider
  response. Local typecheck, the 21-test focused sandbox suite, and the
  116-pass full offline suite remain green.
- Next session should start with: Review the measured E2B create failure and
  choose whether to add unique-metadata orphan reconciliation and perform one
  bounded retry, investigate the E2B account/service response, or invoke the
  approved architectural fallback discussion. Do not start another sandbox
  without that decision.

### 2026-07-28 — Step 5 manual terminal test suite

- What was done: Added a terminal test guide with six ordered cases covering
  complete local verification, offline template inspection, account hygiene,
  focused live transport, full isolation, and opt-in enforcement. Added named
  package commands for each gate plus a guarded E2B administration CLI that
  can list sandboxes read-only and terminate only an exact validated ID with
  explicit `--yes`.
- What broke / had to be reworked: Nothing. No live sandbox was started.
- Decisions made this session: Keep all routine verification offline. Separate
  the two live gates so free-tier users can stop after the cheaper transport
  proof, and require an empty sandbox listing before and after every live run.
- Current status of the step in progress: Step 5 remains in progress at the
  previously recorded live create-response stop. The exact manual local
  command passes with 118 tests passed, 3 opt-in tests skipped, and 0 failed;
  the focused sandbox suite passes 23 tests.
- Next session should start with: Use
  `docs/testing/step-5-manual-terminal-tests.md`; do not run its live cases
  until the E2B create-response decision is resolved.

### 2026-07-28 — Manual test ripgrep preflight

- What was done: Investigated the two ripgrep failures from a normal macOS
  Terminal run. Added a local dependency preflight to the manual command,
  documented Git/ripgrep prerequisites, and added regression coverage for
  both the satisfied and missing-dependency cases.
- What broke / had to be reworked: The Codex application environment exposes
  its bundled `rg`, while the user's normal Terminal `PATH` did not. Removing
  that bundled path reproduced the exact two attached failures. The tool and
  tests were correct; the manual runner lacked an environment preflight.
- Decisions made this session: Fail immediately with an actionable message
  when Git or ripgrep is absent. Do not skip tool tests, silently substitute
  another search implementation, or install system packages automatically.
- Current status of the step in progress: The preflight regression tests pass,
  the missing-`rg` reproduction now exits immediately with
  `brew install ripgrep`, and the complete local command passes with 120 tests
  passed, 3 live tests skipped, and 0 failed.
- Next session should start with: Install ripgrep in the user's Terminal,
  rerun `bun run test:manual:preflight`, then rerun
  `bun run test:manual:local`. Step 5's live E2B blocker is unchanged.

### 2026-07-28 — Focused E2B transport gate completion

- What was done: Reproduced the user's live template failure, added a template
  ownership regression, created `/workspace/tasks` during the root build
  phase, assigned `/workspace` to the runtime user, rebuilt the pinned
  template, and reran the focused MCP transport gate.
- What broke / had to be reworked: The template owned `/opt/agent` correctly
  but left `/workspace` absent, so the unprivileged runtime user could not
  create the task root. After that fix, the live probe exposed a stale
  assertion: newline-terminated files are canonically returned with a numbered
  trailing empty line. The assertion now matches the established read contract.
- Decisions made this session: Keep the final E2B runtime user unprivileged;
  provision and transfer ownership of the fixed workspace root at image-build
  time instead of elevating sandbox tool execution.
- Current status of the step in progress: The focused E2B gate passes in about
  four seconds, proving the real MCP handshake, exact six-tool discovery,
  remote read, process-loss failure without retry, and cleanup. E2B reports
  zero running sandboxes. The complete local command passes with 120 tests,
  3 live tests skipped, and 0 failed.
- Next session should start with: Run `bun run test:e2b:isolation`, verify the
  final sandbox listing is empty, then proceed through Step 5 review,
  documentation, commit, push, merge, and merged-main verification.

### 2026-07-28 — Full E2B isolation gate completion

- What was done: Corrected the isolation suite's newline-aware positive-control
  assertion, exposed the session-owned MCP PID as read-only state, replaced
  unstable process-command matching with exact-PID fault injection, and ran
  the complete live gate.
- What broke / had to be reworked: The first run stopped on the same stale
  newline expectation already corrected in the transport probe. The second
  reached all six tools and isolation checks but E2B's process listing did not
  preserve the command text used by the test to rediscover the server. The
  session already owned the exact transport PID, so command-text guessing was
  removed.
- Decisions made this session: Use the transport-owned PID for deterministic
  lifecycle fault injection. Do not depend on provider-specific process-list
  formatting.
- Current status of the step in progress: The full E2B isolation test passes
  all 25 assertions: exact six-tool discovery, all tool families, remote-only
  mutation, randomized host-sentinel isolation, positive control, typed path
  rejection, exact-PID process loss without replay, session shutdown, and
  sandbox termination. E2B reports zero running sandboxes. The complete local
  suite passes 120 tests with 3 live tests skipped and 0 failed.
- Next session should start with: Run the required Step 5 review and
  documentation audit, create the remaining scoped commits, push the feature
  branch, merge into updated `main`, reverify all gates, and push `main`.

### 2026-07-28 — Step 5 review and documentation

- What was done: Ran the pre-landing engineering review and documentation
  audit. Added ADR 0011, the Phase 5 implementation record, current README
  architecture/setup guidance, the manual terminal test guide, and the
  in-progress roadmap status. Created the scoped implementation commit.
- What broke / had to be reworked: Review confirmed the observed ambiguous
  create-response path could leave an orphan because the failed call returned
  no handle. Each create request now carries a unique metadata token; create
  failure performs exact-token reconciliation without retrying creation or any
  tool call.
- Decisions made this session: Keep provider-specific process text out of
  lifecycle logic, use exact owned PIDs for fault injection, and use unique
  creation metadata only for cleanup reconciliation.
- Current status of the step in progress: Review is clean after the lifecycle
  fix. The complete offline suite passes 121 tests with 3 live tests skipped;
  the focused sandbox suite passes 24 tests; the final live isolation gate
  passes all 25 assertions; E2B reports zero running sandboxes.
- Next session should start with: Commit the synchronized documentation, push
  the feature branch, merge into updated `main`, reverify the merged result,
  then finalize Step 5 status and push `main`.

### 2026-07-28 — Sandbox branch landing and merged-main verification

- What was done: Corrected the renamed feature-branch references and current
  acceptance counts, pushed `feat/e2b-sandbox`, updated `main`, merged the
  remaining documentation correction as `61af25f`, and pushed verified
  `main`. Created `docs/sandbox-finalization` for the final roadmap status.
- What broke / had to be reworked: `origin/main` already contained the feature
  merge, so local `main` fast-forwarded to that state before merging only the
  newer documentation correction. No code conflict or test failure occurred.
- Decisions made this session: Preserve the reviewed feature commits and use a
  separate documentation-finalization branch rather than edit status directly
  on `main`.
- Current status of the step in progress: Step 5 is complete. On merged
  `main`, the offline suite passes 121 tests with 3 opt-in tests skipped, the
  focused sandbox suite passes 24 tests, the live transport gate passes, the
  live six-tool isolation gate passes all 25 assertions, and E2B reports zero
  running sandboxes.
- Next session should start with: Step 6 planning and engineering review.
  Keep destructive-command, traversal, symlink, and environment defenses in
  Step 6, and resolve ADR 0009 mutation reconciliation before any live model
  receives real mutating tools.

### 2026-07-30 — PreToolUse safety boundary landing

- What was done: Implemented strict model-visible schemas without `repoPath`,
  immutable canonical task-root binding, structured fail-closed PreToolUse
  decisions, and per-session serialization. Rebuilt the E2B runtime around
  separate `agent` and `runner` identities, a root-owned execution wrapper,
  shared task-source permissions, protected linked-worktree Git metadata, and
  disabled internet. Added component-wise symlink rejection, no-follow file
  access, protected paths, controlled shell and Git environments, descendant
  cleanup, internal and host timeouts, reduced Git operations, ADR 0012, the
  implementation plan, manual cases, and offline/live red-team coverage.
- What broke / had to be reworked: Live testing exposed a missing E2B
  `default` template tag, absent template environment propagation, GNU
  `timeout` rejecting millisecond units, a Python network probe that echoed its
  success marker inside a failure traceback, and E2B throwing on `pgrep`'s
  expected exit 1. The implementation now requires a tagged template,
  hardcodes security defaults for the canonical layout, converts milliseconds
  to fractional seconds, checks network stdout separately, and normalizes the
  no-runner-process observation. Review also tightened unknown-field rejection
  and complete existing-file writes.
- Decisions made this session: Regex denials are diagnostics, not confinement.
  Exact root binding, Unix identities and permissions, no-follow typed access,
  process cleanup, and network denial are the boundary. Ordinary task content
  remains deletable; runtime, Git control state, credentials, the host, and
  external systems remain protected. See ADR 0012.
- Current status of the step in progress: Step 6 is complete. `/cso` reports
  no findings at its 8/10 confidence threshold and `bun audit --json` reports
  no advisories. `/review` has no unresolved findings. Typecheck, 138 offline
  tests, 15 focused MCP tests, 28 focused sandbox tests, 4 focused safety
  tests, the Step 0 regression, template dry-run, both live E2B gates, sandbox
  cleanup, and `git diff --check` pass.
- Next session should start with: Implement ADR 0009 mutation recovery on
  `fix/mutation-recovery`. Define write-ahead state or operation-specific
  reconciliation for `edit_file`, `run_shell`, and Git mutation before
  OpenRouter, Step 7, or any live-model access to mutating real tools.

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
