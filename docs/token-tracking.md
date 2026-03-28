# Token Tracking: API vs Claude CLI

Context Chain supports two AI providers with fundamentally different token accounting models. This document explains how each provider reports token usage and how the run history dashboard interprets the data.

## Provider Overview

| | `anthropic-api` | `claude-cli` (`claude -p`) |
|---|---|---|
| Authentication | API key (pay-per-token) | Claude Max subscription |
| Token billing | Direct — you pay for every token | Included in subscription |
| Cache control | Full control (up to 4 breakpoints) | No control — CLI manages internally |

## Token Fields

Each run history record stores the following token fields:

```
inputTokens             Non-cached input tokens (our prompt content)
outputTokens            Model response tokens
totalTokens             inputTokens + outputTokens
cacheCreationTokens     Tokens written to KV cache (optional)
cacheReadTokens         Tokens read from KV cache (optional)
```

### Why `totalTokens` excludes cache tokens

`totalTokens = inputTokens + outputTokens` — it intentionally does **not** include `cacheCreationTokens` or `cacheReadTokens`.

For the `claude-cli` provider, `cache_creation_input_tokens` reported by `claude -p` includes Claude Code's own system prompt (~6,000 tokens). This system prompt is injected by the CLI and is not part of our analysis content. Including it would inflate token counts by ~6,000 per function call, making the numbers misleading.

The `cacheCreationTokens` and `cacheReadTokens` fields are still recorded for diagnostics and cache hit rate analysis.

## anthropic-api Provider

When using the Anthropic Messages API directly:

```
POST /v1/messages
{
  "system": [{ "text": "...", "cache_control": {"type": "ephemeral"} }],
  "messages": [{ "role": "user", "content": "..." }]
}
```

**Token accounting:**
- `input_tokens` — all non-cached input tokens (system + user message content beyond cache)
- `output_tokens` — model response
- `cache_creation_input_tokens` — tokens written to cache on this request
- `cache_read_input_tokens` — tokens served from cache (90% cheaper)

**Cache behavior:**
- You control where cache breakpoints go via `cache_control` on content blocks
- Up to 4 breakpoints per request
- Prefix matching: the API caches everything from the start up to the breakpoint
- Cache TTL: 5 minutes (default) or 1 hour
- Cache read cost: 0.1x base input price; cache write cost: 1.25x base input price

**Optimization opportunity:** Place stable analysis instructions in the `system` message with `cache_control`, and function-specific content in the `user` message. The instructions (~300 tokens) get cached across all function analysis calls.

## claude-cli Provider (claude -p)

When using `claude -p --output-format json`:

```bash
cat prompt.txt | claude -p --tools "" --output-format json
```

The CLI wraps our prompt in its own request structure:

```
[Claude Code system prompt + project context ~11,000 tokens]  ← injected by CLI, not our content
[Our user message prompt]                                      ← our analysis instructions + function code
```

**Token accounting:**
- `input_tokens` — non-cached input (typically 2-3 tokens, almost everything goes to cache)
- `output_tokens` — model response
- `cache_creation_input_tokens` — our prompt content (~300-5,000 tokens depending on function size)
- `cache_read_input_tokens` — CLI system prompt + project context (~11,000 tokens, constant)

**Cache behavior (verified 2026-03-27):**
- CLI automatically caches its system prompt + project context (CLAUDE.md etc.) as one block (~11,367 tokens)
- This `cache_read` is **constant** across all `claude -p` invocations regardless of user message content
- Our user message goes to `cache_creation` (cached with 1h TTL per message block)
- User message prefix caching does **not** work — the CLI caches complete message blocks, not token prefixes within a message
- Only an **identical** user message hits cache (verified: same prompt → `cache_creation=0, cache_read=16102`)
- Each `claude -p` invocation creates a new session ID, but this does not prevent system prompt cache hits

**Why the dashboard doesn't show cache rate for CLI:**

The `cache_read` reported by CLI is entirely the system prompt overhead (~11,000 tokens) — not our content. Showing it as "cache hit rate" is misleading because it reflects CLI internals, not our prompt caching strategy. For CLI runs, the dashboard shows `-` in the cache column.

## Prompt Structure for Cache Optimization

The analysis prompt (`buildDefaultPrompt` in `analyze-function.ts`) is structured with stable content first:

```
[Stable prefix — identical across all function analyses]
  You are doing a deep analysis...
  ## Instructions
  A design decision explains: ...
  Return ONLY a raw JSON array...

---

[Variable suffix — different per function]
  ## Target function: createOrder (file: orderStore.ts)
  ```
  function createOrder() { ... }
  ```
  ## Callers: ...
  ## Callees: ...
```

This structure is designed for the `anthropic-api` provider: the stable prefix can be placed in a `system` message with `cache_control`, and the variable suffix in the `user` message. This would cache the instructions (~300 tokens) across all function analysis calls.

For `claude-cli`, this structure has no cache benefit (the CLI doesn't support user message prefix caching), but it doesn't hurt either.

## Dashboard Display

The History page (`/history`) shows:

- **Input** — prompt tokens sent to the model (excludes CLI system prompt overhead)
  - CLI: `cache_creation_input_tokens + input_tokens` (our prompt content only)
  - API: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (full prompt)
- **Output** — model response tokens
- **Cache** — prompt cache hit rate (API provider only)
  - `cache_read / (input + cache_creation + cache_read)`, computed from our content only
  - CLI runs show `-` because `cache_read` reflects CLI system prompt, not our content
- **Decisions** — decisions created or edges found per run

`analyze-batch` records (batch summaries) are excluded from all stats to avoid double-counting with individual `analyze` records.

Each `RunRecord` includes a `provider` field (`claude-cli`, `anthropic-api`, `codex-cli`) so the dashboard can apply provider-specific display logic.
