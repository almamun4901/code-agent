# Phase 4 Plan — MCP Transport over stdio

**Status:** complete; verified 2026-07-28.

## Outcome

Expose the unchanged six-tool dispatcher through a persistent MCP stdio
connection. A direct `dispatchTool()` call and an `McpToolClient.call()` return
the same JSON-canonical `ToolResult` for successful operations, tool failures,
mutations, containment failures, and overflowing results.

## Architecture

```text
McpToolClient.call(ToolCall)
        |
        | JSON-RPC over stdin/stdout
        v
createMcpToolServer(context)
        |
        +--> Zod wire-shape validation
        +--> dispatchTool()
               +--> runtime validation
               +--> development-root containment
               +--> policy seam
               +--> tool execution
               +--> 4,000-token finalization
        |
        v
one text block: JSON.stringify(ToolResult)
isError: !ToolResult.success
```

`src/mcp/schemas.ts` owns discovery and wire-result schemas.
`src/mcp/server.ts` registers exactly the six Step 2 tools.
`src/mcp/client.ts` owns the persistent connection, 60-second request timeout,
strict result decoding, and coalesced shutdown.
`src/mcp/stdio-server.ts` validates `--development-root` before accepting calls
and keeps diagnostics off stdout.

## Wire and failure contract

- `validateToolCall()` remains the semantic authority.
- Tool execution failures return canonical `ToolResult` values with
  `isError: true`.
- Spawn, initialization, EOF, request-timeout, protocol, and malformed-result
  failures throw.
- No disconnected call is retried because a mutation may already have run.
- Result parity compares `JSON.parse(JSON.stringify(directResult))` with the
  decoded MCP value.
- MCP SDK v1 normalizes invalid tool requests into `isError` call results; the
  typed client rejects their non-`ToolResult` payloads and keeps the connection
  usable.

## Acceptance matrix

- Exact discovery for six unique tools, complete annotations, strict object
  schemas, and four Git operation branches.
- Unknown tools and malformed inputs fail without killing the connection.
- Success parity for ranged reads, edit preview/apply, ripgrep match/empty,
  symbol extraction, shell stdout/stderr/nonzero, and Git clean/dirty/diff.
- Failure parity for missing/stale/invalid/unsupported inputs, bad working
  directories, shell timeout, Git failure, invalid timeout, and outside-root
  repositories.
- Mutating edit, shell, commit, and push paths use separate identical
  repositories and compare final bytes and Git state.
- Overflow parity preserves codec, token count, marker, and the 4,000-token
  serialized cap.
- Malformed server results throw; concurrent and repeated close leave no child;
  missing configuration writes only stderr; child loss rejects a tool call
  within two seconds.

## Verification evidence

- `bun run typecheck`: pass.
- `bun test`: 95 pass, 1 explicit live test skipped, 0 fail.
- `bun run loop-fake.ts`: four turns, three completed tasks, one recovery.
- `git diff --check`: pass.
- Gstack `/review`: seven findings fixed across schema discovery, validation
  authority, mutation parity, malformed results, and lifecycle behavior; no
  unresolved findings.

## Explicitly deferred

- StreamableHTTP/SSE and MCP v2.
- E2B execution and host-isolation claims.
- PreToolUse policy, mutation reconciliation, and live-model tool exposure.
- Retries, concurrency queues, telemetry, TUI, packaging, and external host
  configuration.
