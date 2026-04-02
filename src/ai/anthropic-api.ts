/**
 * ai/anthropic-api.ts
 *
 * AIProvider 实现：通过 Anthropic Messages API 调用。
 * 走 API key，按 token 计费。
 *
 * 不依赖 @anthropic-ai/sdk，直接用 fetch 调 API，减少依赖。
 */

import { AIProvider, AIProviderOptions, AIConfig, TokenUsage, RateLimitInfo, UnifiedRateLimitInfo } from './types'

const DEFAULT_MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_MAX_TOKENS = 4096
const API_URL = 'https://api.anthropic.com/v1/messages'

export class AnthropicAPIProvider implements AIProvider {
  name = 'anthropic-api'
  lastUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  rateLimit?: RateLimitInfo
  unifiedRateLimit?: UnifiedRateLimitInfo

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

  cleanup(): void { /* no session files to clean */ }

  async call(prompt: string, options?: AIProviderOptions): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? 120000
    const maxRetries = 5
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
          const status = response.status

          // 429 (rate limit) or 529 (overloaded): retry with backoff
          if ((status === 429 || status === 529) && attempt < maxRetries) {
            clearTimeout(timer)
            const retryAfter = response.headers.get('retry-after')
            const waitSec = retryAfter ? parseInt(retryAfter) : Math.min(2 ** attempt * 2, 60)
            const jitter = Math.random() * 1000
            const totalWait = Math.round(waitSec + jitter / 1000)
            console.log(`[rate-limit] ${status} on attempt ${attempt + 1}/${maxRetries + 1}, waiting ${totalWait}s`)
            options?.onRetry?.({ status, attempt: attempt + 1, maxRetries: maxRetries + 1, waitSec: totalWait })
            await new Promise(r => setTimeout(r, waitSec * 1000 + jitter))
            lastError = new Error(`Anthropic API ${status}: ${body}`)
            continue
          }

          throw new Error(`Anthropic API ${status}: ${body}`)
        }

      // 解析 rate limit headers
      this.rateLimit = {
        tokensLimit: parseInt(response.headers.get('anthropic-ratelimit-tokens-limit') ?? '0'),
        tokensRemaining: parseInt(response.headers.get('anthropic-ratelimit-tokens-remaining') ?? '0'),
        requestsLimit: parseInt(response.headers.get('anthropic-ratelimit-requests-limit') ?? '0'),
        requestsRemaining: parseInt(response.headers.get('anthropic-ratelimit-requests-remaining') ?? '0'),
        resetAt: response.headers.get('anthropic-ratelimit-tokens-reset') ?? '',
      }

      // 解析 unified rate limit headers (CLI-style usage tracking)
      const sessionUtil = response.headers.get('anthropic-ratelimit-unified-5h-utilization')
      const sessionReset = response.headers.get('anthropic-ratelimit-unified-5h-reset')
      const weeklyUtil = response.headers.get('anthropic-ratelimit-unified-7d-utilization')
      const weeklyReset = response.headers.get('anthropic-ratelimit-unified-7d-reset')
      const unifiedStatus = response.headers.get('anthropic-ratelimit-unified-status')

      if (sessionUtil || weeklyUtil) {
        this.unifiedRateLimit = {
          session_utilization: parseFloat(sessionUtil ?? '0'),
          session_reset: sessionReset ? new Date(sessionReset).getTime() : 0,
          weekly_utilization: parseFloat(weeklyUtil ?? '0'),
          weekly_reset: weeklyReset ? new Date(weeklyReset).getTime() : 0,
          status: unifiedStatus ?? 'unknown',
          updatedAt: Date.now(),
        }
        // Emit structured line for parent process to parse
        console.log(`__RATELIMIT__${JSON.stringify(this.unifiedRateLimit)}`)
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

    // All retries exhausted
    throw lastError ?? new Error('Anthropic API: max retries exceeded')
  }
}
