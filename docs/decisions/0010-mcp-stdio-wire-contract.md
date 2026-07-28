# 0010 — Use stable MCP v1 over stdio with canonical JSON results

**Date:** 2026-07-28
**Status:** accepted

## Context

Step 4 needs a transport boundary around the existing six-tool dispatcher
without changing tool behavior, validation, containment, policy, or the
4,000-token result cap. MCP SDK v2 is still beta, and duplicating a capped
result in both text and structured content would enlarge every response and
create two possible sources of truth.

The stable v1.30 SDK also publishes only object-shaped Zod schemas. A top-level
discriminated union is advertised as an empty object even though runtime
validation still works.

## Decision

Pin `@modelcontextprotocol/sdk` to `1.30.0` and use one persistent stdio
connection. Each successful handler invocation returns exactly one text block
containing `JSON.stringify(ToolResult)` and sets `isError` to
`!ToolResult.success`; `structuredContent` is omitted.

The dispatcher remains the authority for semantic validation. MCP discovery
schemas enforce the typed wire shape, while the Git schema uses an
object-shaped wrapper that validates the same discriminated union and carries
its four exact branches into discovery metadata.

Client requests use the SDK's 60-second timeout. Tool failures return canonical
`ToolResult` values. Transport, handshake, EOF, request-timeout, protocol, and
malformed-result failures throw, and mutating calls are never retried.

## Alternatives considered

- **MCP SDK v2 beta** — rejected because transport work does not need a
  breaking-change-prone beta surface.
- **Duplicate `ToolResult` in `structuredContent`** — rejected because it
  spends the result budget twice and permits representation drift.
- **Spawn a server for every call** — rejected because startup and handshake
  overhead would become part of every tool invocation.
- **Retry disconnected mutations** — rejected because the remote outcome is
  ambiguous after connection loss.

## Consequences

- Direct and MCP calls compare after JSON canonicalization because JavaScript
  `undefined` metadata cannot cross the wire.
- SDK-normalized unknown-tool and malformed-argument failures appear as MCP
  `isError` results to a raw SDK client; the typed client rejects them because
  they are not valid `ToolResult` JSON.
- The stdio child requires an absolute existing `--development-root`, and
  stdout is reserved for protocol messages.
- The Git discovery wrapper is a documented SDK v1 compatibility measure.
- This adds no sandbox or security claim beyond existing development-root
  containment. ADR 0009 still blocks live-model mutation exposure.

## Revisit when

Reconsider the wrapper and text-only policy when MCP SDK v2 is stable and its
object/union discovery plus structured-output behavior have been verified
against the same direct-versus-transport parity suite.
