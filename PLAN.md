# Project Plan — Terminal-Native Coding Agent

## 1. Goal

Build a plan/act/observe/recover coding agent with a terminal harness, sandboxed
tool execution, lifecycle hooks, and full observability — end to end from
`agent run <repo> "<task>"` to an opened pull request. Measure it against
mini-swe-agent on a 30-task SWE-bench Pro Python subset.

**Definition of done for the whole capstone:**
`outputs/skill-terminal-coding-agent.md` exists, runs end to end on a fresh
repo, returns a PR URL plus a trace bundle, and `eval/results.jsonl` contains
pass@1 / turns-per-task / $-per-task comparisons against the baseline.

**Rubric weighting** (drives how much time each phase below deserves):


| Weight | Criterion                                                                     |
| ------ | ----------------------------------------------------------------------------- |
| 25     | SWE-bench Pro pass@1 vs mini-swe-agent baseline                               |
| 20     | Architecture clarity (plan/act/observe separation, hook surface, tool schema) |
| 20     | Safety (sandbox escape tests, destructive-command guard vs red-team)          |
| 20     | Observability (100% tool calls spanned, token accounting per turn)            |
| 15     | Developer UX (cold-start < 2s, crash recovery, clean Ctrl-C)                  |


---



## 2. Target architecture

This is the end state the build order converges on. Every step below either
adds a layer to this diagram or hardens one that already exists.

```text
  user CLI  ->  harness (Bun + Ink TUI)
                  |
                  v
           plan / act / observe loop  <--->  Claude Sonnet 4.7 / GPT-5.4-Codex / Gemini 3 Pro
                  |                          (via OpenRouter, model-agnostic)
                  v
           tool dispatcher (MCP StreamableHTTP client)
                  |
     +------------+------------+----------+
     v            v            v          v
  read/edit    ripgrep     tree-sitter   git/run
     |            |            |          |
     +------------+------------+----------+
                  |
                  v
           E2B / Daytona sandbox  (worktree isolated)
                  |
                  v
           hooks: Pre/Post, Session, Prompt, Compact
                  |
                  v
           OpenTelemetry -> Langfuse (spans, tokens, $)
                  |
                  v
           PR via GitHub app
```

**Layer responsibilities:**


| Layer                 | Responsibility                                                                    | Must NOT do                                                        |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Harness (Bun + Ink)   | Render plan/tool-stream/budget panes, handle CLI args, handle Ctrl-C              | Contain business logic — it's a view over loop state               |
| Plan/act/observe loop | Own the turn state machine, call the model, call the dispatcher                   | Talk to the sandbox directly                                       |
| Model layer           | Translate loop requests into provider calls, normalize responses across providers | Know about tools, sandboxes, or hooks                              |
| Tool dispatcher       | Route typed tool calls over MCP to the tool server                                | Execute anything itself                                            |
| Tool server           | Implement the 6 tools, truncate output, run inside sandbox context                | Be reachable from outside the sandbox                              |
| Sandbox (E2B/Daytona) | Isolate all execution and the git worktree from the host                          | Persist state the harness doesn't explicitly save                  |
| Hooks                 | Intercept lifecycle events for policy/telemetry/guardrails                        | Contain core agent logic — they're extension points, not the spine |
| Telemetry             | Span everything, export to Langfuse                                               | Block or slow the loop (async export)                              |
| GitHub App            | Open the final PR                                                                 | Run until the loop reports success                                 |


**Why the loop sits between the model and the dispatcher, not the harness:**
the harness should be swappable (TUI today, a web UI or headless CI mode
later) without touching agent logic. This is also why the rubric scores
"architecture clarity" on the plan/act/observe *separation* specifically —
it's checking that these boundaries are real, not just visually diagrammed.

---



## 3. Build order and dependency graph

The spec's own "Build It" numbering (1–8) is architecturally correct but
sequences by *component*, which means you'd be integrating the model, the
sandbox, and the TUI simultaneously before any single piece is proven. The
order below sequences by *what needs to be true before the next thing is
debuggable*, deferring the two hardest external dependencies (sandbox, MCP
transport) until the logic they wrap is already trustworthy.

```text
0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10
        └──────────────┘
        (2 and 3 can interleave)
```


| #   | Step                      | Depends on | What it proves                                                        | Definition of done                                                                                                                                                                                                                             | Est. hours |
| --- | ------------------------- | ---------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 0   | Fake loop                 | —          | The plan/act/observe/recover state machine shape is right             | Hardcoded plan → hardcoded tool call → hardcoded observation cycles N times in a plain script, no deps                                                                                                                                         | 2          |
| 1   | Real model, fake tools    | 0          | Model can rewrite full plan state each turn; tool-call parsing works  | Single hardcoded model (Claude API direct, no OpenRouter yet) drives 3+ real turns against a fake `read_file` tool that returns canned strings                                                                                                 | 4          |
| 2   | Real tools, no sandbox    | 1          | The 6 tools work correctly against a real repo, truncation is correct | `read_file`, `edit_file`, `ripgrep`, `tree_sitter_symbols`, `run_shell`, `git` run locally, each capped at 4k tokens/call, verified against a repo with a file that overflows the cap                                                          | 6          |
| 3   | Plan schema + persistence | 2          | Crash recovery actually works                                         | Zod-validated TodoWrite schema; `.agent/state.json` written every turn; repeated `kill -9` mid-turn + restart resumes from the last committed plan without replaying committed reads                                                            | 6          |
| 4   | MCP transport (stdio)     | 2          | Tool dispatch works transport-agnostically                            | Same 6 tools from step 2, now called over MCP stdio instead of direct function calls, identical behavior verified                                                                                                                              | 4          |
| 5   | Sandbox (E2B)             | 4          | Isolation is structural, not a permission check                       | Tools execute inside E2B; worktree created per task; a probe test confirms host filesystem is unreachable from inside a tool call                                                                                                              | 5          |
| 6   | PreToolUse safety hook    | 5          | The destructive-command guard actually holds under attack             | `rm -rf` outside worktree blocked; symlink-escape attempt blocked; `..`-traversal blocked; each has a written red-team test case                                                                                                               | 4          |
| 7   | TUI (Ink)                 | 3, 4, 5    | The harness is a pure view over already-stable state                  | Split view (plan / tool stream / budget) renders live; cold start < 2s; Ctrl-C fires `SessionEnd` and exits cleanly mid-tool                                                                                                                   | 4          |
| 8   | Remaining hooks + budget  | 6          | All lifecycle extension points and cost ceilings are enforced         | All 8 hook types wired (`PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Notification`, `Stop`, `PreCompact`); 3 ceilings enforced (50 turns, 200k context, $5/task); `PreCompact` fires and summarizes at 150k | 6          |
| 9   | Telemetry                 | 8          | Observability is complete, not sampled                                | OTel spans on every model call, tool call, and hook invocation with `gen_ai.*` attributes; exported to self-hosted Langfuse; 100% tool-call span coverage verified by counting                                                                 | 3          |
| 10  | Eval + PR posting         | all        | The whole system produces the deliverable                             | 30-task SWE-bench Pro Python run vs mini-swe-agent; `eval/results.jsonl` written; successful task opens a real PR via GitHub App with plan + diff summary in the body                                                                          | 6          |


Total: ~47h against a 35h budget — this is intentional headroom, not a
target to hit exactly. Steps 2 and 6 are the likeliest to overrun (tool edge
cases, red-team iteration); steps 0, 3, and 9 are likeliest to go faster than
estimated. Re-budget after step 2, once you have real signal on your pace.

---



## 4. Explicitly out of scope for v1

Deferring these isn't laziness — each one is a real axis of complexity that
the build order above depends on *not* having yet, so that debugging any
single step never means debugging two unknowns at once.


| Deferred                            | Reason                                                                                             | Revisit when                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| OpenRouter / model-agnostic routing | Adds a normalization layer before deterministic tool, transport, sandbox, and policy behavior are proven | After steps 5–6, before the first live-model real-tool run or Step 7             |
| StreamableHTTP transport            | stdio is simpler to debug locally, no server process to manage                                     | Exercise 5 explicitly compares them — do it as that exercise, not before         |
| Daytona                             | E2B has a more mature JS SDK; two sandbox backends is an abstraction with no second data point yet | Only if E2B blocks on something Daytona solves                                   |
| Multi-agent reviewer sub-agent      | Exercise 2 in the spec; adds a whole second loop                                                   | After step 10, as an exercise, with its own pass-rate measurement                |
| tree-sitter for all 17 languages    | Start with 2–3 languages actually present in your 30-task subset                                   | Expand once the eval set's language mix is known                                 |


---



## 5. Risk register

Things likely to actually cost time, and the mitigation baked into the build
order above.


| Risk                                                                 | Where it bites | Mitigation                                                                                                          |
| -------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| SWE-bench Pro task environments don't reproduce cleanly              | Step 10        | Dry-run a single task through the eval harness *before* committing to the full 30                                   |
| E2B default sandbox image lacks ripgrep / tree-sitter binaries       | Step 5         | Verify binaries in the sandbox image before step 5, not during                                                      |
| Model doesn't reliably emit valid tool-call JSON                     | Step 1         | Build the schema-validation + one-retry-then-abort logic into `loop.ts` from step 1, not bolted on later            |
| Cost of iterating with a frontier model during development           | Steps 1–9      | Use Haiku or a cheap model for all dev-loop debugging; reserve Sonnet/Opus for the actual step-10 eval run          |
| PreToolUse guard has a bypass (symlinks, absolute paths, env tricks) | Step 6         | Red-team test cases written alongside the hook, not after; this is 20% of the rubric — budget real time here        |
| Context/plan drift over long sessions                                | Step 8         | `PreCompact` is a hook, not an afterthought — test it explicitly at the 150k boundary with a synthetic long session |
| Crash recovery replays an interrupted mutating tool                  | Steps 5–6      | Before the first live-model real-tool run, add idempotency keys, write-ahead journaling, or operation-specific reconciliation; ADR 0009 makes this a blocking revisit |


---



## 6. How this plan is maintained

- `PLAN.md` (this file) — written now, edited only when scope or ordering
  actually changes. Update the Status column below when a step completes.
- `PROGRESS.md` — updated every session; fine-grained "what's next," current
  blockers, what broke.
- `docs/decisions/` — one file per non-obvious choice (model provider,
  sandbox choice, transport ordering), written at decision time.
- Every roadmap step starts by pulling `main` with `--ff-only`, then creates a
  dedicated branch from that updated base.
- Each explicit substep is verified and committed independently. The completed
  step branch is pushed only after its full definition of done, gstack review,
  and documentation audit pass.
- A step is complete only after its branch is merged into an updated `main`,
  the merged result is reverified, and `main` is pushed. `AGENTS.md` and
  `CLAUDE.md` contain the authoritative operational sequence.



## 7. Status tracker


| Step                          | Status                                                |
| ----------------------------- | ----------------------------------------------------- |
| 0 — Fake loop                 | complete                                              |
| 1 — Real model, fake tools    | complete                                              |
| 2 — Real tools, no sandbox    | complete                                              |
| 3 — Plan schema + persistence | complete                                              |
| 4 — MCP transport (stdio)     | complete                                              |
| 5 — Sandbox (E2B)             | in progress — acceptance gates pass; landing pending |
| 6 — PreToolUse safety hook    | not started                                           |
| 7 — TUI (Ink)                 | not started                                           |
| 8 — Remaining hooks + budget  | not started                                           |
| 9 — Telemetry                 | not started                                           |
| 10 — Eval + PR posting        | not started                                           |
