/**
 * ingestion/normalize-keywords.ts
 *
 * 独立积木块：全局关键词归一化。
 *
 * 从图谱拉所有 active 决策的唯一 keywords，一次 LLM 调用找同义词，
 * 然后把 alias 都补上 canonical 形式。
 *
 * 应在 connect-decisions 之前调用——归一化后的关键词让分组更精准。
 *
 * 用法：
 *   import { normalizeKeywords } from './normalize-keywords'
 *   const result = await normalizeKeywords(session, ai)
 */

import { Session } from 'neo4j-driver'
import { AIProvider } from '../ai'
import { buildKeywordNormalizationPrompt } from '../prompts/cold-start'
import { parseJsonSafe } from './shared'

// ── Types ───────────────────────────────────────────────

export interface NormalizeKeywordsResult {
  /** 应用了多少条归一化（每个 alias→canonical 算一条） */
  normalized: number
  /** canonical 词列表 */
  terms: string[]
  /** 图谱中唯一关键词总数 */
  totalUniqueKeywords: number
}

// ── Main ────────────────────────────────────────────────

/**
 * 全局关键词归一化。
 *
 * 1. 从图谱拉全量 active 决策的唯一 keywords
 * 2. 如果少于 5 个，跳过（不值得跑 LLM）
 * 3. 一次 LLM 调用 → {canonical, aliases}[]
 * 4. 对包含 alias 的决策，补上 canonical
 */
export async function normalizeKeywords(
  session: Session,
  ai: AIProvider,
  options?: { verbose?: boolean }
): Promise<NormalizeKeywordsResult> {
  const verbose = options?.verbose ?? true

  if (verbose) console.log('\n🏷️  关键词归一化...')

  // 1. 拉全量唯一关键词
  const kwResult = await session.run(
    `MATCH (d:DecisionContext {staleness: 'active'})
     WHERE d.keywords IS NOT NULL
     UNWIND d.keywords AS kw
     RETURN DISTINCT kw ORDER BY kw`
  )
  const allKeywords = kwResult.records.map(r => r.get('kw') as string)

  if (allKeywords.length < 5) {
    if (verbose) console.log(`  ○ 关键词太少 (${allKeywords.length})，跳过`)
    return { normalized: 0, terms: [], totalUniqueKeywords: allKeywords.length }
  }

  if (verbose) console.log(`  📊 共 ${allKeywords.length} 个唯一关键词`)

  // 2. LLM 调用
  const prompt = buildKeywordNormalizationPrompt(allKeywords)
  const raw = await ai.call(prompt, { timeoutMs: 60000 })
  const normalizations = parseJsonSafe<{ canonical: string; aliases: string[] }[]>(raw, [])

  if (!Array.isArray(normalizations) || normalizations.length === 0) {
    if (verbose) console.log(`  ○ 无需归一化`)
    return { normalized: 0, terms: [], totalUniqueKeywords: allKeywords.length }
  }

  // 3. 应用归一化
  let normalized = 0
  for (const norm of normalizations) {
    if (!norm.canonical || !Array.isArray(norm.aliases)) continue
    for (const alias of norm.aliases) {
      try {
        const updateResult = await session.run(
          `MATCH (d:DecisionContext)
           WHERE ANY(k IN d.keywords WHERE k = $alias)
             AND NOT ANY(k IN d.keywords WHERE k = $canonical)
           SET d.keywords = d.keywords + [$canonical]
           RETURN count(d) AS cnt`,
          { alias, canonical: norm.canonical }
        )
        const cnt = updateResult.records[0]?.get('cnt')
        const num = typeof cnt === 'number' ? cnt : cnt?.toNumber?.() ?? 0
        if (num > 0) normalized++
      } catch {}
    }
  }

  const terms = normalizations.map(n => n.canonical)
  if (verbose) {
    console.log(`  ✅ ${normalized} 条归一化应用`)
    console.log(`    Terms: ${terms.join(', ')}`)
  }

  return { normalized, terms, totalUniqueKeywords: allKeywords.length }
}
