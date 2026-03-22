/**
 * ai/anthropic-api.ts
 *
 * AIProvider 实现：通过 Anthropic Messages API 调用。
 * 走 API key，按 token 计费。
 *
 * 不依赖 @anthropic-ai/sdk，直接用 fetch 调 API，减少依赖。
 */

import { AIProvider, AIProviderOptions, AIConfig, TokenUsage, RateLimitInfo } from './types'

const DEFAULT_MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_MAX_TOKENS = 4096
const API_URL = 'https://api.anthropic.com/v1/messages'

export class AnthropicAPIProvider implements AIProvider {
  name = 'anthropic-api'
  lastUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  rateLimit?: RateLimitInfo

  private apiKey: string
  private model: string
  private maxTokens: number

  constructor(config: AIConfig) {
    const key = config.apiKey ?? process.env.ANTHROPIC_API_KEY
    if (!key) {
      throw new Error(
        'Anthropic API key 未设置。在 ckg.config.json 的 ai.apiKey 里填，或设置环境变量 ANTHROPIC_API_KEY'
      )
    }
    this.apiKey = key
    this.model = config.model ?? DEFAULT_MODEL
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  }

  async call(prompt: string, options?: AIProviderOptions): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? 120000

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`Anthropic API ${response.status}: ${body}`)
      }

      // 解析 rate limit headers
      this.rateLimit = {
        tokensLimit: parseInt(response.headers.get('anthropic-ratelimit-tokens-limit') ?? '0'),
        tokensRemaining: parseInt(response.headers.get('anthropic-ratelimit-tokens-remaining') ?? '0'),
        requestsLimit: parseInt(response.headers.get('anthropic-ratelimit-requests-limit') ?? '0'),
        requestsRemaining: parseInt(response.headers.get('anthropic-ratelimit-requests-remaining') ?? '0'),
        resetAt: response.headers.get('anthropic-ratelimit-tokens-reset') ?? '',
      }

      const data = await response.json() as {
        content: { type: string; text?: string }[]
        usage?: { input_tokens: number; output_tokens: number }
      }

      // 追踪 token 用量
      if (data.usage) {
        this.lastUsage = { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens }
        this.totalUsage.input_tokens += data.usage.input_tokens
        this.totalUsage.output_tokens += data.usage.output_tokens
      }

      const text = data.content
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('\n')

      // 跟 claude-cli 保持一致：去掉 markdown code fence
      const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
      return cleaned
    } finally {
      clearTimeout(timer)
    }
  }
}
