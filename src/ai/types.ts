/**
 * ai/types.ts
 *
 * AIProvider 接口定义。
 * 所有 AI 调用方式（claude -p、Anthropic API、OpenAI 等）都实现这个接口。
 */

export interface AIProviderOptions {
  timeoutMs?: number
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
}

export interface RateLimitInfo {
  tokensLimit: number
  tokensRemaining: number
  requestsLimit: number
  requestsRemaining: number
  resetAt: string
}

export interface AIProvider {
  /** 标识名，用于日志 */
  name: string

  /**
   * 发送 prompt，返回 raw string。
   * 调用方负责 JSON 解析——provider 只管传输。
   */
  call(prompt: string, options?: AIProviderOptions): Promise<string>

  /** 最近一次调用的 token 用量 */
  lastUsage: TokenUsage

  /** 累计 token 用量 */
  totalUsage: TokenUsage

  /** 最新 rate limit 信息（仅 Anthropic API 可用） */
  rateLimit?: RateLimitInfo
}

/**
 * ckg.config.json 里 "ai" 段的类型。
 */
export interface AIConfig {
  provider: 'claude-cli' | 'anthropic-api'
  model?: string        // e.g. "claude-sonnet-4-20250514"
  apiKey?: string        // anthropic-api 需要，claude-cli 不需要
  maxTokens?: number     // anthropic-api 用，默认 4096
  embedding?: {
    provider: 'voyage'
    apiKey?: string     // 或 env VOYAGE_API_KEY
    model?: string      // 默认 voyage-3-lite
  }
}
