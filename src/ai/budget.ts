/**
 * ai/budget.ts
 *
 * Token 预算管理。管线在每次 LLM 调用后检查是否超预算。
 *
 * 用法：
 *   --budget 500000      绝对值：最多用 50 万 token
 *   --budget 50%         百分比：用 API 剩余额度的 50%（需配合 check-quota）
 */

import { TokenUsage, RateLimitInfo } from './types'

export class BudgetManager {
  private maxTokens: number
  private consumed: number = 0

  constructor(maxTokens: number) {
    this.maxTokens = maxTokens
  }

  /** 记录一次调用的消耗 */
  record(usage: TokenUsage): void {
    this.consumed += usage.input_tokens + usage.output_tokens
  }

  /** 是否超预算 */
  get exceeded(): boolean {
    return this.consumed >= this.maxTokens
  }

  /** 剩余可用 token */
  get remaining(): number {
    return Math.max(0, this.maxTokens - this.consumed)
  }

  /** 已用百分比 */
  get percentUsed(): number {
    return this.maxTokens > 0 ? Math.round((this.consumed / this.maxTokens) * 100) : 0
  }

  /** 已消耗 token */
  get used(): number {
    return this.consumed
  }

  /** 格式化用量摘要 */
  summary(): string {
    return `${formatTokens(this.consumed)} / ${formatTokens(this.maxTokens)} (${this.percentUsed}%)`
  }
}

/**
 * 解析 --budget 参数。
 * 返回 BudgetManager 或 null（无预算限制）。
 *
 * @param budgetStr "500000" 或 "50%"
 * @param rateLimit 当前 rate limit 信息（百分比模式需要）
 */
export function parseBudget(budgetStr: string | null, rateLimit?: RateLimitInfo): BudgetManager | null {
  if (!budgetStr) return null

  if (budgetStr.endsWith('%')) {
    const pct = parseInt(budgetStr.slice(0, -1))
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      console.warn(`⚠️ 无效的预算百分比: ${budgetStr}，忽略`)
      return null
    }
    if (!rateLimit || rateLimit.tokensRemaining <= 0) {
      console.warn(`⚠️ 无法获取剩余额度，百分比预算不可用。请使用绝对值（如 --budget 500000）`)
      return null
    }
    const maxTokens = Math.floor(rateLimit.tokensRemaining * (pct / 100))
    console.log(`📊 预算: 剩余额度 ${formatTokens(rateLimit.tokensRemaining)} 的 ${pct}% = ${formatTokens(maxTokens)}`)
    return new BudgetManager(maxTokens)
  }

  const maxTokens = parseInt(budgetStr)
  if (isNaN(maxTokens) || maxTokens <= 0) {
    console.warn(`⚠️ 无效的预算值: ${budgetStr}，忽略`)
    return null
  }

  console.log(`📊 预算: ${formatTokens(maxTokens)}`)
  return new BudgetManager(maxTokens)
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return `${n}`
}
