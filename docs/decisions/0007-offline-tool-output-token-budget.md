# 0007 — Use an offline o200k_base proxy for tool-output budgets

**Date:** 2026-07-26
**Status:** accepted

## Context

Step 2 requires every tool result to be capped at 4,000 tokens. Exact token
counts vary by model, and Anthropic's current exact counter is a remote,
model-specific API. Calling it from every local tool would add network,
provider, latency, and availability dependencies to a deterministic tool
layer.

## Decision

Define an injectable output-token codec and use a pinned offline
`o200k_base` implementation for Step 2. It is a deterministic,
model-independent proxy chosen because the target architecture includes
current GPT/Codex models and because mature TypeScript implementations can
encode and decode truncation boundaries locally. Report the codec name in
truncation metadata and do not describe the count as Anthropic billing usage.

## Alternatives considered

- **Anthropic token-counting API** — exact for the configured Claude model,
  but rejected because it makes every tool result depend on the network and a
  provider credential.
- **`cl100k_base`** — also deterministic, but represents an older model
  generation than the GPT/Codex family named in the target architecture.
- **Characters divided by four** — small, but cannot enforce a real encoded
  upper bound and handles code and non-ASCII text inconsistently.

## Consequences

- Offline tests can prove an exact 4,000-token cap under one pinned codec.
- Counts can differ from Claude or Gemini tokenization.
- The codec seam allows a later router/model layer to inject a provider-aware
  counter without changing any tool implementation.

## Revisit when

When OpenRouter lands or if the eval shows provider inputs exceeding the
intended budget despite the proxy cap.
