/**
 * ai/types.ts
 *
 * AIProvider interface definition.
 * All AI providers (claude -p, Anthropic API, etc.) implement this interface.
 */

export interface AIProviderOptions {
  timeoutMs?: number
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface RateLimitInfo {
  tokensLimit: number
  tokensRemaining: number
  requestsLimit: number
  requestsRemaining: number
  resetAt: string
}

/** Unified rate limit info from anthropic-ratelimit-unified-* headers */
export interface UnifiedRateLimitInfo {
  session_utilization: number
  session_reset: number
  weekly_utilization: number
  weekly_reset: number
  status: string
  updatedAt: number
}

export interface AIProvider {
  /** Display name for logging */
  name: string

  /**
   * Send prompt, return raw string.
   * Caller handles JSON parsing — provider handles transport.
   */
  call(prompt: string, options?: AIProviderOptions): Promise<string>

  /** Clean up sessions created by this provider (e.g. claude -p session files) */
  cleanup(): void

  /** Token usage from last call */
  lastUsage: TokenUsage

  /** Cumulative token usage */
  totalUsage: TokenUsage

  /** Latest rate limit info (Anthropic API only) */
  rateLimit?: RateLimitInfo

  /** Unified rate limit info (CLI-style usage tracking) */
  unifiedRateLimit?: UnifiedRateLimitInfo
}

/**
 * ckg.config.json 里 "ai" 段的类型。
 */
export interface AIConfig {
  provider: 'claude-cli' | 'anthropic-api' | 'codex-cli'
  model?: string        // e.g. "claude-sonnet-4-20250514"
  apiKey?: string        // anthropic-api 需要，claude-cli 不需要
  maxTokens?: number     // anthropic-api 用，默认 4096
  embedding?: {
    provider: 'voyage'
    apiKey?: string     // 或 env VOYAGE_API_KEY
    model?: string      // 默认 voyage-3-lite
  }
}
