/**
 * scripts/check-quota.ts
 *
 * 查询当前 API 余额和 rate limit 信息。
 * 用于规划管线预算。
 *
 * 运行：npm run quota
 */

import { loadConfig } from '../src/config'
import { AnthropicAPIProvider } from '../src/ai/anthropic-api'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return `${n}`
}

async function main() {
  const config = loadConfig()

  // Anthropic API 余额
  if (config.ai?.provider === 'anthropic-api' || config.ai?.apiKey || process.env.ANTHROPIC_API_KEY) {
    console.log('\n📊 Anthropic API 余额\n')

    try {
      const provider = new AnthropicAPIProvider({
        provider: 'anthropic-api',
        apiKey: config.ai?.apiKey,
        model: config.ai?.model,
        maxTokens: 10,  // 最小请求
      })

      // 发一个最小请求来获取 rate limit headers
      await provider.call('Hi', { timeoutMs: 15000 })

      const rl = provider.rateLimit
      if (rl && rl.tokensLimit > 0) {
        console.log(`  Token limit:        ${formatTokens(rl.tokensLimit)} / window`)
        console.log(`  Tokens remaining:   ${formatTokens(rl.tokensRemaining)}`)
        console.log(`  Requests limit:     ${rl.requestsLimit}`)
        console.log(`  Requests remaining: ${rl.requestsRemaining}`)
        if (rl.resetAt) console.log(`  Reset at:           ${rl.resetAt}`)

        const used = rl.tokensLimit - rl.tokensRemaining
        const usedPct = rl.tokensLimit > 0 ? Math.round((used / rl.tokensLimit) * 100) : 0
        console.log(`\n  已用: ${formatTokens(used)} (${usedPct}%)`)

        console.log(`\n  建议预算:`)
        for (const pct of [50, 30, 10]) {
          const budget = Math.floor(rl.tokensRemaining * (pct / 100))
          console.log(`    ${pct}% = ${formatTokens(budget)} tokens  (--budget ${budget})`)
        }
      } else {
        console.log('  ⚠️ 未获取到 rate limit 信息')
        console.log('  （可能是免费层或 headers 不可用）')
      }

      // 显示本次探测消耗
      console.log(`\n  📎 本次探测消耗: ${provider.totalUsage.input_tokens + provider.totalUsage.output_tokens} tokens`)

    } catch (err: any) {
      console.log(`  ❌ API 调用失败: ${err.message}`)
      if (err.message.includes('key')) {
        console.log('  请设置 ANTHROPIC_API_KEY 或在 ckg.config.json 配置 ai.apiKey')
      }
    }
  } else {
    console.log('\n📊 Anthropic API')
    console.log('  未配置 API key，跳过')
  }

  // Claude CLI 信息
  if (config.ai?.provider === 'claude-cli' || !config.ai?.provider) {
    console.log('\n📊 Claude CLI (Max subscription)')
    console.log('  Claude CLI 走订阅额度，无法通过 API 查询剩余量')
    console.log('  建议：用 --budget 设置绝对 token 上限控制管线消耗')
    console.log('  例如: npm run cold-start:v2 -- --goal "..." --budget 500000')
  }

  // Voyage embedding 信息
  if (config.ai?.embedding) {
    console.log('\n📊 Voyage Embedding')
    console.log(`  Provider: ${config.ai.embedding.provider}`)
    console.log(`  Model: ${config.ai.embedding.model ?? 'voyage-3-lite'}`)
    console.log('  余额查询：请登录 dash.voyageai.com')
  }

  console.log()
}

main().catch(err => {
  console.error('❌ 查询失败:', err.message)
  process.exit(1)
})
