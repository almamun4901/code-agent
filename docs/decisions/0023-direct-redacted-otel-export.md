# 0023 — Export redacted OpenTelemetry directly to self-hosted Langfuse

**Date:** 2026-08-11
**Status:** accepted

## Context

Step 9 requires complete model, tool, and hook span coverage without making
telemetry part of execution truth. The runtime already has exact authoritative
boundaries and durable checkpoint/audit counts. Adding automatic
instrumentation, a collector, or the Langfuse SDK would introduce more moving
parts and wider content-capture defaults than this single-process CLI needs.

## Decision

Create spans manually at the model transport, tool dispatch, and lifecycle-hook
boundaries. Export them with the OpenTelemetry OTLP/HTTP exporter directly to a
self-hosted Langfuse `/api/public/otel/v1/traces` endpoint, using always-on SDK
sampling and a bounded batch processor. Telemetry accepts only a closed
attribute allowlist and is disabled unless explicitly configured.

## Alternatives considered

- **Langfuse SDK** — passed over because direct OpenTelemetry already supplies
  the required spans and avoids a second observation API and content defaults.
- **OpenTelemetry Collector** — passed over for v1 because one local producer
  and one self-hosted destination do not justify another deployed service.
- **Automatic instrumentation** — passed over because it would add noisy spans
  without proving coverage at the agent's authoritative semantic boundaries.
- **Telemetry-derived completion/accounting** — rejected because asynchronous
  traces can be missing or delayed; checkpoint and audit state remain truth.

## Consequences

The implementation is small, provider-neutral, and testable by comparing span
counts with checkpoint model calls and audit tool records. Sandbox PreToolUse
reports only hook index, duration, and outcome through MCP result metadata; the
host creates the span while commands, paths, arguments, results, and raw errors
remain excluded. Export and shutdown failures cannot change a run result.

Operators must provide a self-hosted Langfuse URL and project keys. Direct
export has no collector-side retry or routing layer; the SDK's bounded batch
queue is the only buffer.

## Revisit when

Add a collector if two independent telemetry destinations are required, if
offline buffering must survive process exit, or if fleet-wide routing and
tail-based sampling become operational requirements.
