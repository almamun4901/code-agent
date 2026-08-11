# Step 9 — Redacted OpenTelemetry and Langfuse

**Implementation status:** runtime, transport, offline coverage, and temporary
self-hosted Langfuse acceptance are complete on `feat/otel-telemetry`; review,
landing, and merged-main reverification remain.

## Scope

Step 9 observes the production runner without becoming a second source of
truth. It creates one `invoke_agent` root span and child spans for every paid
model transport, committed tool attempt, and actual lifecycle-hook invocation.
The runtime uses OpenTelemetry GenAI attributes where the semantic convention
has a matching field.

## Span contract

| Boundary | Span | Safe attributes |
| --- | --- | --- |
| Agent run | `invoke_agent` | run digest, approval mode, terminal outcome |
| Model transport | `chat` | operation, provider, requested/actual model, input/output tokens, call kind |
| Tool dispatch | `execute_tool` | tool name, operation ID, success/outcome, stable error code |
| Hook invocation | `execute_hook` | hook name, registration index, duration, outcome |

Task text, prompts, model content, commands, repository paths, tool arguments,
tool results, notification text, hook context, and raw errors are not accepted
by the attribute allowlist. Span counts are a tested projection of checkpoint
model-call counters, terminal audit tool records, and independently invoked
hooks.

## Transport and failure behavior

- Export uses OTLP/HTTP directly to self-hosted Langfuse with ingestion version
  4 and HTTP Basic project authentication.
- Sampling is always on. Export is batched asynchronously with a bounded queue.
- Final shutdown is bounded to two seconds and all exporter failures are
  ignored by run control flow.
- Missing, partial, oversized, or invalid environment configuration selects a
  no-op implementation.
- The E2B MCP server returns only bounded PreToolUse index/duration/outcome
  observations in result `_meta`; they are excluded from the persisted
  `ToolResult` and converted to host spans under the active tool call.

## Acceptance

- Typecheck and the full offline suite pass.
- In-memory export proves exact model/tool/hook coverage and content redaction.
- A rejecting exporter does not change the operation result.
- A temporary loopback-only self-hosted Langfuse v4 instance received one run
  with the expected root and child counts under one trace and no prohibited
  content. Its containers and named volumes were removed after acceptance.
- Dependency audit, gstack review, documentation audit, branch push/merge,
  merged-main verification, and main push pass before Step 9 is complete.
