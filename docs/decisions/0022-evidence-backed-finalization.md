# 0022 — Bind completion to durable verification and Git delivery

**Date:** 2026-08-11
**Status:** accepted

## Context

The execution loop previously treated a fully checked model-authored plan as
completion. That did not prove required commands passed, visual claims were
checked in a browser, every tool observation was correlated, or the delivered
Git result matched the verified worktree. Delivery can also fail after model
work is finished, when another paid model call cannot improve the outcome.

## Decision

Checkpoint v4 owns a closed approved verification contract, hash-chained audit
cursor, `finalizing` lifecycle, evidence, and completion receipt. The runner
stops model work after evidence passes, resumes Git delivery without another
model call, binds the exact delivered tree and audit records, persists verified
completion, and only then cleans up E2B.

Command evidence must exactly match its approved command, directory, and
timeout. Visual proposals require bounded loopback-only Playwright/Chromium
checks with host-validated screenshots. `.agent/audit.jsonl` is a redacted
projection that binds the exact Git identity and viewport case used by each
check; the checkpoint remains execution truth and Step 9 may export only this
validated projection. Viewport limits are run-wide, and screenshot delivery is
bounded before host allocation.

## Alternatives considered

- **Keep `completed` plus an outer verification flag** — rejected because two
  completion states can contradict each other during recovery.
- **Deliver Git results inside the model loop** — rejected because delivery is
  trusted host orchestration and must resume without model spend.
- **Accept manual or generic plugin evidence** — rejected because completion
  would again depend on unverifiable claims.
- **Persist raw tool output** — rejected because it increases secret and source
  retention without strengthening the required terminal facts.

## Consequences

- Success requires all requirements to bind to one clean Git tree and the
  delivery receipt to independently identify that tree.
- Delivery failure leaves `finalizing` state and preserves the sandbox lease.
- Browser verification adds pinned Playwright 1.55.0/Chromium, screenshot
  delivery, process recovery, and artifact integrity checks.
- Audit records are bounded, redacted, mode 0600, hash-chained, and committed
  only through the checkpoint cursor. Corruption and overflow fail closed.
- Pre-v4 terminal runs remain `legacy_unverified`; active legacy execution
  cannot be upgraded by inventing evidence.

## Revisit when

Revisit if multiple processes must own one repository run, verification needs
a new machine-verifiable type, E2B loses loopback browser support, or a sandbox
provider offers an equivalent atomic delivery and evidence receipt.
