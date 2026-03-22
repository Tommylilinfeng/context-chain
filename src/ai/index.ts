/**
 * ai/index.ts
 *
 * 工厂函数：根据 config 创建对应的 AIProvider。
 */

export { AIProvider, AIProviderOptions, AIConfig, TokenUsage, RateLimitInfo } from './types'
export { ClaudeCLIProvider } from './claude-cli'
export { AnthropicAPIProvider } from './anthropic-api'

import { AIProvider, AIConfig } from './types'
import { ClaudeCLIProvider } from './claude-cli'
import { AnthropicAPIProvider } from './anthropic-api'

const DEFAULT_CONFIG: AIConfig = {
  provider: 'claude-cli',
}

export function createAIProvider(config?: AIConfig): AIProvider {
  const c = config ?? DEFAULT_CONFIG

  switch (c.provider) {
    case 'claude-cli':
      return new ClaudeCLIProvider(c)
    case 'anthropic-api':
      return new AnthropicAPIProvider(c)
    default:
      throw new Error(`未知的 AI provider: ${(c as any).provider}`)
  }
}
