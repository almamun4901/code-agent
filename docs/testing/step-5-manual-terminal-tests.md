# Step 5 manual terminal tests

These cases verify the local sandbox code and, when explicitly requested, the
real E2B boundary. Run them from the repository root. Ordinary local tests do
not start an E2B sandbox, even when `.env` contains an API key.

## Prerequisites

- Bun 1.3 or newer
- Git
- ripgrep (`rg`)

Check them before the full suite:

```sh
bun run test:manual:preflight
```

Expected:

```text
Manual test prerequisites found: git, rg.
```

If macOS reports that `rg` is missing, install it with Homebrew:

```sh
brew install ripgrep
```

Then rerun the preflight. The project does not install system packages
automatically.

## Safety rules

- Run the local cases before any live case.
- Run only one live case at a time.
- List running sandboxes before and after every live case.
- Do not retry an ambiguous create, transport, or cleanup failure.
- Never paste or print `E2B_API_KEY`.
- A live case is successful only when the final sandbox listing is empty.

## Case 1 — Complete local regression

```sh
bun run test:manual:local
```

Expected:

- The dependency preflight finds Git and ripgrep.
- TypeScript reports no errors.
- The complete offline test suite passes.
- The focused sandbox suite passes.
- The four-turn fake loop completes with one recovery.
- Git reports no whitespace errors.
- The E2B integration tests are skipped and no sandbox is created.

## Case 2 — Inspect the template without uploading

```sh
bun run e2b:template:check
```

Expected:

- The generated definition pins Bun 1.3.14.
- It installs Git and ripgrep.
- Runtime setup switches to `root`, creates `/opt/agent`, transfers ownership
  to `user`, and restores `user`.
- It copies only `package.json`, `bun.lock`, and `src`.
- This command performs no template build and starts no sandbox.

## Case 3 — Confirm the account starts clean

```sh
bun run e2b:sandboxes:list
```

Expected:

```text
No running E2B sandboxes.
```

If a sandbox is listed, do not start another live test. Verify that it belongs
to this project, then terminate that exact ID:

```sh
bun run e2b:sandbox:kill -- <sandbox-id> --yes
bun run e2b:sandboxes:list
```

The kill command deliberately rejects missing `--yes`, malformed IDs, and
wildcards.

## Case 4 — Focused live MCP transport gate

Cost: one short-lived E2B sandbox. This is the first live test to run.

Prerequisites in `.env`:

```text
E2B_API_KEY=<configured locally>
E2B_TEMPLATE_ID=in0cy2ejtiabcz19wu6v:step-5-v1
```

Run:

```sh
bun run e2b:sandboxes:list
bun run test:e2b:transport
bun run e2b:sandboxes:list
```

Expected:

- A real MCP connection starts inside E2B.
- Discovery returns exactly six tools.
- `read_file` reads the sandbox-only probe.
- Killing the MCP process makes the next call fail promptly without retry.
- The final listing reports no running sandboxes.

Stop immediately if sandbox creation takes unusually long, returns malformed
data, or the final listing is non-empty.

## Case 5 — Full live isolation gate

Cost: one short-lived E2B sandbox. Run only after Case 4 passes.

```sh
bun run e2b:sandboxes:list
bun run test:e2b:isolation
bun run e2b:sandboxes:list
```

Expected:

- All six tools execute through MCP in the E2B task worktree.
- Edit preview/apply, search, symbol extraction, shell, Git status/diff, and
  commit succeed.
- The randomized host-only sentinel is unreachable through `run_shell`.
- An in-sandbox marker remains readable as the positive control.
- Absolute host reads and repository paths outside `/workspace/tasks` are
  rejected with typed errors.
- Remote mutations do not change the host fixture or project.
- Process loss fails promptly without replay.
- The final listing reports no running sandboxes.

## Case 6 — Verify live tests remain opt-in

```sh
RUN_LIVE_E2B_TEST=0 bun test
bun run e2b:sandboxes:list
```

Expected:

- Both E2B integration tests are skipped.
- The sandbox listing remains empty.

## Failure record

For a failed live case, record:

- command and UTC timestamp;
- elapsed time;
- sanitized error text;
- whether E2B listed a running sandbox afterward;
- the exact cleanup result.

Do not record API keys, environment dumps, fixture secrets, or provider
response headers.
