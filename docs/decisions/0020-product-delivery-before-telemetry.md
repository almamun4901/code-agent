# 0020 — Product delivery before telemetry

**Date:** 2026-08-02
**Status:** accepted

## Context

A live calculator dogfood run completed 34 model calls and 26 tool calls,
reported 20 passing tests, and then cleaned its E2B sandbox. The local source
repository still contained only its original README because the runtime had no
trusted result-return channel. The same run exposed two more usability gaps:
the model began mutating before the user could approve visual choices, and the
final completed plan mixed real tool evidence with unmeasured claims. A shell-
created mode-0644 file also caused typed `edit_file` apply to fail under the
separate `agent` identity; the model recovered through another shell mutation.

Step 9 telemetry would make these events easier to inspect, but asynchronous
traces cannot deliver the result, authorize mutations, or serve as completion
truth.

## Decision

Insert three productization gates before telemetry: safe Git result delivery,
durable human plan approval before mutations, and trusted completion evidence
with a host-readable audit surface. Step 9 exports a redacted projection of
that durable state; it does not replace it.

## Alternatives considered

- **Proceed directly to telemetry** — improves diagnosis but leaves successful
  work unavailable and design choices unreviewable until after implementation.
- **Wait for Step 10 GitHub PR posting** — delivers only GitHub-backed tasks and
  makes local-only repositories unusable.
- **Allow the model to edit the host repository directly** — returns files but
  removes the structural isolation that E2B and the host/sandbox trust boundary
  were designed to provide.

## Consequences

The roadmap expands by an estimated 20–34 focused hours. Normal interactive
runs gain a pause/revise/approve phase, while evaluation keeps an explicit
auto-approve mode. E2B cleanup becomes conditional on a durable host receipt.
Completion and telemetry must reference the same correlated tool and Git
evidence. The split `agent`/`runner` design remains, but repository artifacts
must be writable through the shared task group so typed edits cannot be
bypassed accidentally.

## Revisit when

Revisit if a different sandbox provider supplies an authenticated, atomic Git
result channel with equivalent base-revision validation, or if the product
intentionally drops either local-only repositories or interactive operation.
