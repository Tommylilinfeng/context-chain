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
[Claude Code system prompt ~6,000 tokens]    ← injected by CLI, not our content
[Our user message prompt]                     ← our analysis instructions + function code
```

**Token accounting:**
- `input_tokens` — non-cached input (typically 2-3 tokens, almost everything goes to cache)
- `output_tokens` — model response
- `cache_creation_input_tokens` — includes Claude Code system prompt + our prompt (~6,000-7,000 tokens)
- `cache_read_input_tokens` — typically 0 for analysis (see below)

**Cache behavior:**
- Claude Code automatically caches its own system prompt block
- The CLI does **not** place `cache_control` breakpoints on the user message
- System prompt cache **does** hit across `claude -p` invocations (verified: `cache_read=6150`)
- User message prefix cache does **not** work — even with identical prefixes, the CLI only caches at the message-block level, not token-prefix level
- Each `claude -p` invocation creates a new session ID, but this does not prevent system prompt cache hits

**Why cache_read is usually 0 for analysis:**

Each function analysis has a unique user message (different function code, callers, callees). Since the CLI only caches complete message blocks — not token prefixes within a message — the user message never hits cache. Only the system prompt block can be cached, and it shows up as `cache_creation` on the first call (creating the cache entry) but as `cache_read` on identical subsequent calls.

In batch analysis with `concurrency >= 2`, parallel calls may each create their own cache entry for the system prompt, resulting in `cache_creation` on every call and `cache_read = 0`.

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

- **Total Tokens** — sum of `totalTokens` (input + output only)
- **Avg Tokens / Analysis** — average `totalTokens` for `type=analyze` records
- **Cache Hit Rate** — `cacheReadTokens / (cacheReadTokens + cacheCreationTokens + inputTokens)`, only shown when cache reads exist
- **Per-run cache column** — individual cache hit % per row

`analyze-batch` records (batch summaries) are excluded from all stats to avoid double-counting with individual `analyze` records.
