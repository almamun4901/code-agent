# How to manually verify the Step 6 safety boundary

This guide verifies the Step 6 PreToolUse safety boundary from the repository
root. It starts with local checks that do not contact E2B, then builds and
tests the real E2B runtime only when you explicitly run the live commands.

The live tests create short-lived, billable E2B resources. Run one live case
at a time. A live case passes only when its assertions pass and the final
sandbox listing is empty.

## What these cases prove

| ID | Boundary | Required result |
|---|---|---|
| S6-01 | Offline regression | Typecheck, tests, sandbox unit tests, and Step 0 regression pass |
| S6-02 | Policy diagnostics | Obvious attacks return stable policy codes and the next safe tool works |
| S6-03 | Template definition | The image defines separate `agent` and `runner` identities and an immutable runtime |
| S6-04 | Template build | E2B builds the exact `step-6-v1` runtime from the filtered source payload |
| S6-05 | MCP transport | The six-tool MCP connection works and fails promptly after process loss |
| S6-06 | Tool surface | Model-visible schemas omit `repoPath`; Git exposes only status, diff, and commit |
| S6-07 | Runtime isolation | Shell commands run as `runner` and cannot alter `/opt/agent` or Git metadata |
| S6-08 | Filesystem containment | Traversal and symlink attempts have no outside side effects |
| S6-09 | Network isolation | Direct and encoded HTTP, TCP, and DNS attempts cannot reach external hosts |
| S6-10 | Environment isolation | Provider, E2B, GitHub, and process-injection variables are absent |
| S6-11 | Process cleanup | Background and double-fork-style runner processes do not survive |
| S6-12 | Legitimate work | Editing, searching, symbol extraction, Git status/diff, and commit still work |
| S6-13 | Host isolation | Sandbox mutations do not change the host fixture or project |
| S6-14 | Lifecycle cleanup | The sandbox is gone after success, failure, or process loss |
| S6-15 | Opt-in behavior | Ordinary test runs skip live E2B tests and create no sandbox |

## Prerequisites

- Bun 1.3 or newer
- Git
- ripgrep (`rg`)
- An E2B account and API key for S6-04 through S6-15
- Permission to upload the filtered runtime payload to E2B

Run the local prerequisite check:

```sh
bun run test:manual:preflight
```

Expected:

```text
Manual test prerequisites found: git, rg.
```

If macOS reports that `rg` is missing:

```sh
brew install ripgrep
```

Do not print or paste your E2B API key into test evidence. Keep it only in the
ignored local `.env` file:

```text
E2B_API_KEY=<configured locally>
E2B_TEMPLATE_NAME=terminal-coding-agent-tools:step-6-v1
```

## Safety rules

- Run S6-01 through S6-03 before uploading or starting a sandbox.
- Run only one live case at a time.
- List running sandboxes before and after every live case.
- Do not retry an ambiguous create, transport, or cleanup failure.
- Do not use wildcard or guessed sandbox IDs for cleanup.
- Do not capture environment dumps, credentials, or provider response headers.
- Stop if the template name is not exactly
  `terminal-coding-agent-tools:step-6-v1`.

## S6-01 — Run the complete local regression

This command does not build an E2B template or create a sandbox.

```sh
bun run test:manual:local
```

Pass criteria:

- The prerequisite check finds Git and ripgrep.
- TypeScript reports no errors.
- The complete offline suite passes.
- The focused sandbox suite passes.
- The Step 0 fake loop completes in four turns with one recovery.
- `git diff --check` reports no whitespace errors.
- Live Anthropic and E2B tests are skipped.

## S6-02 — Run the focused policy and red-team suite

```sh
bun run test:safety
```

Pass criteria:

- `rm -rf /` and recursive deletion through `..` return
  `SHELL_DESTRUCTIVE_OUTSIDE_ROOT`.
- `curl`, `wget`, and `nc` return `SHELL_EGRESS_UTILITY`.
- direct `/opt/agent` mutation returns `SHELL_RUNTIME_MUTATION`.
- direct `.git` mutation returns `SHELL_GIT_CONTROL_MUTATION`.
- device writes return `SHELL_DEVICE_WRITE`.
- null bytes return `SHELL_NULL_BYTE`.
- traversal returns `INVALID_PATH`.
- symlink reads and writes return `SYMLINK_PATH`.
- Git push returns `INVALID_TOOL_CALL`.
- Every protected file remains unchanged.
- A safe `read_file` or Git status call succeeds after each rejection.
- Encoded interpreter commands may pass the lexical policy, demonstrating
  that lexical checks are not treated as the security boundary.

Expected summary:

```text
4 pass
0 fail
```

## S6-03 — Inspect the template without uploading

```sh
bun run e2b:template:check
```

Pass criteria:

- The base image is `oven/bun:1.3.14`.
- The image installs Git, ripgrep, Node, Python, sudo, `setpriv`, `timeout`,
  and process cleanup tools.
- The image creates `agent`, `runner`, and the shared `task` group.
- `/opt/agent` becomes root-owned and read-only.
- `/workspace/tasks` is owned by `agent:task` with mode `0750`.
- `/usr/local/sbin/agent-run-shell` is root-owned with mode `0555`.
- sudo permits `agent` to invoke only that fixed wrapper.
- the final image user is `agent`.
- only `package.json`, `bun.lock`, and `src/` are copied into the image.
- the command exits without contacting E2B.

## S6-04 — Build the Step 6 E2B template

Running this command uploads `package.json`, `bun.lock`, and `src/` to E2B.
It excludes `.env`, `.git`, `.agent`, dependencies, tests, documentation,
outputs, and evaluation data.

First confirm the account has no running sandboxes:

```sh
bun run e2b:sandboxes:list
```

Expected:

```text
No running E2B sandboxes.
```

Build with an explicit name so a stale local setting cannot select an older
template:

```sh
E2B_TEMPLATE_NAME=terminal-coding-agent-tools:step-6-v1 \
  bun run e2b:template:build
```

Pass criteria:

- the build succeeds;
- the final JSON contains `templateId`, `templateRef`, `buildId`, and the
  exact Step 6 name;
- the runtime checks find Bun, Git, ripgrep, and the pinned Tree-sitter WASM
  files;
- no secret appears in the build log.

Copy the returned tagged `templateRef` into `E2B_TEMPLATE_ID` in the ignored
local `.env`. Do not copy the bare `templateId`; E2B resolves an untagged ID
as `:default`, but this project builds the `:step-6-v1` tag.

```text
E2B_TEMPLATE_ID=<returned-template-ref>
```

Do not commit `.env`.

## S6-05 — Verify live MCP transport

Cost: one short-lived sandbox.

```sh
bun run e2b:sandboxes:list
bun run test:e2b:transport
bun run e2b:sandboxes:list
```

Pass criteria:

- the first and final listings report no running sandboxes;
- a secure, network-disabled sandbox starts from the Step 6 template;
- MCP discovery returns exactly `read_file`, `edit_file`, `ripgrep`,
  `tree_sitter_symbols`, `run_shell`, and `git`;
- `read_file` returns the sandbox-only probe;
- killing the MCP process makes the next request fail promptly;
- the test reports one pass and zero failures.

If the final listing is not empty, stop and follow
[Cleanup after a failed live case](#cleanup-after-a-failed-live-case).

## S6-06 through S6-14 — Run the full live safety gate

Cost: one short-lived sandbox. Run this only after S6-05 passes.

```sh
bun run e2b:sandboxes:list
bun run test:e2b:safety
bun run e2b:sandboxes:list
```

The safety command and `bun run test:e2b:isolation` currently execute the
same full live suite. Run one, not both.

### S6-06 — Tool surface

Pass criteria:

- discovery returns exactly six tools;
- no tool schema contains `repoPath`;
- Git exposes exactly `status`, `diff`, and `commit`;
- Git push is absent.

### S6-07 — Runtime and Git control isolation

Pass criteria:

- `run_shell` reports the identity as `runner`;
- a write beside the task root fails;
- encoded writes to `/opt/agent/package.json` and the worktree `.git` marker
  fail structurally even though they bypass lexical checks;
- both protected-file hashes remain unchanged.

### S6-08 — Traversal and symlink containment

Pass criteria:

- an absolute host path returns `INVALID_PATH`;
- a symlinked file returns `SYMLINK_PATH` for reads and edits;
- the outside file remains byte-for-byte unchanged;
- the normal in-worktree marker remains readable afterward.

### S6-09 — Network isolation

Pass criteria:

- direct `curl` receives `SHELL_EGRESS_UTILITY`;
- encoded Bun, Node, and Python HTTP attempts do not print
  `NETWORK_REACHED`;
- raw TCP and DNS attempts do not print `NETWORK_REACHED`;
- every encoded attempt times out or exits nonzero.

### S6-10 — Environment isolation

Pass criteria:

- the shell environment contains no Anthropic, OpenAI, E2B, GitHub, API-key,
  or token variable;
- `GIT_CONFIG*`, `NODE_OPTIONS`, `BUN_OPTIONS`, `LD_PRELOAD`, and
  `PYTHONPATH` are absent.

### S6-11 — Process cleanup

Pass criteria:

- a background `sleep` command returns normally;
- a nested background shell returns normally;
- `pgrep -u runner` finds no process after either command.

### S6-12 — Legitimate work remains available

Pass criteria:

- `read_file` reads the fixture;
- edit preview returns a base version and apply succeeds;
- ripgrep finds the changed line;
- Tree-sitter finds the `Greeter` symbol;
- an ordinary shell write creates an in-worktree marker;
- Git status reports dirty state;
- Git diff contains the edit;
- typed Git commit succeeds and returns a commit SHA.

### S6-13 — Host isolation

Pass criteria:

- the host-only randomized sentinel is not visible in the sandbox;
- the host fixture file remains unchanged;
- the project worktree status is identical before and after the test.

### S6-14 — Lifecycle cleanup

Pass criteria:

- killing the MCP process makes the next request fail promptly;
- closing the task session makes reconnecting to its sandbox fail;
- the final account listing reports no running sandbox.

Expected test summary:

```text
1 pass
0 fail
```

## S6-15 — Verify that live tests remain opt-in

```sh
RUN_LIVE_ANTHROPIC_TEST=0 RUN_LIVE_E2B_TEST=0 bun test
bun run e2b:sandboxes:list
```

Pass criteria:

- the ordinary suite skips the live Anthropic and E2B cases;
- no E2B sandbox is created;
- the final listing reports no running sandbox.

## Cleanup after a failed live case

If a sandbox remains, first verify that its template ID matches the Step 6
template. Then terminate that exact sandbox ID:

```sh
bun run e2b:sandbox:kill -- <exact-sandbox-id> --yes
bun run e2b:sandboxes:list
```

The second command must print:

```text
No running E2B sandboxes.
```

The cleanup command deliberately rejects a missing `--yes`, malformed IDs,
wildcards, and bulk deletion. If creation returned an ambiguous error and no
sandbox ID is available, list the account before taking further action. Do not
rerun the failed case while any sandbox is still running.

## Evidence record

Record one row per case:

| Case | UTC timestamp | Result | Elapsed time | Sandbox before | Sandbox after | Sanitized note |
|---|---|---|---|---|---|---|
| S6-01 |  | PASS / FAIL |  | N/A | N/A |  |
| S6-02 |  | PASS / FAIL |  | N/A | N/A |  |
| S6-03 |  | PASS / FAIL |  | N/A | N/A |  |
| S6-04 |  | PASS / FAIL |  | empty | empty | Template/build IDs only |
| S6-05 |  | PASS / FAIL |  |  |  |  |
| S6-06–S6-14 |  | PASS / FAIL |  |  |  |  |
| S6-15 |  | PASS / FAIL |  |  |  |  |

For a failure, attach:

- the command and UTC timestamp;
- elapsed time;
- sanitized error text;
- the failed assertion or missing expected observation;
- the exact sandbox ID, if one exists;
- the cleanup command and result.

Never record API keys, full environment output, randomized sentinel contents,
fixture secrets, or provider response headers.
