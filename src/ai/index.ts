/**
 * ai/index.ts
 *
 * Factory: create AIProvider from config.
 */

export { AIProvider, AIProviderOptions, AIConfig, TokenUsage, RateLimitInfo, UnifiedRateLimitInfo } from './types'
export { ClaudeCLIProvider } from './claude-cli'
export { AnthropicAPIProvider } from './anthropic-api'
export { CodexCLIProvider } from './codex-cli'

import { AIProvider, AIConfig } from './types'
import { ClaudeCLIProvider } from './claude-cli'
import { AnthropicAPIProvider } from './anthropic-api'
import { CodexCLIProvider } from './codex-cli'

const DEFAULT_CONFIG: AIConfig = {
  provider: 'claude-cli',
}

/**
 * Validate that AI config is usable. Returns error message or null if OK.
 * Use this to fail fast before starting long-running pipelines.
 */
export function validateAIConfig(config?: AIConfig): string | null {
  const c = config ?? DEFAULT_CONFIG
  if (!c || typeof c !== 'object') {
    return 'AI configuration missing. Add "ai" section to ckg.config.json (e.g. {"ai": {"provider": "claude-cli"}}) or set ANTHROPIC_API_KEY env var.'
  }
  if (!c.provider) {
    return 'AI provider not specified. Set "ai.provider" in ckg.config.json to "claude-cli", "anthropic-api", or "codex-cli".'
  }
  if (c.provider === 'anthropic-api' && !c.apiKey && !process.env.ANTHROPIC_API_KEY) {
    return 'Anthropic API key not set. Set "ai.apiKey" in ckg.config.json or ANTHROPIC_API_KEY env var.'
  }
  if (!['claude-cli', 'anthropic-api', 'codex-cli'].includes(c.provider)) {
    return `Unknown AI provider: "${c.provider}". Use "claude-cli", "anthropic-api", or "codex-cli".`
  }
  return null
}

export function createAIProvider(config?: AIConfig): AIProvider {
  const c = config ?? DEFAULT_CONFIG

  const err = validateAIConfig(c)
  if (err) throw new Error(err)

  switch (c.provider) {
    case 'claude-cli':
      return new ClaudeCLIProvider(c)
    case 'anthropic-api':
      return new AnthropicAPIProvider(c)
    case 'codex-cli':
      return new CodexCLIProvider(c)
    default:
      throw new Error(`Unknown AI provider: ${(c as any).provider}`)
  }
}

/**
 * Run a batch of LLM calls with automatic session cleanup on completion.
 * All runners (run, group, localize) should use this instead of manual cleanup.
 */
export async function withAutoCleanup<T>(provider: AIProvider, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } finally {
    provider.cleanup()
  }
}
