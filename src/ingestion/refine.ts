/**
 * ingestion/refine.ts
 *
 * 后台精炼管线：提升图谱质量。
 *
 * 子任务：
 *   1. staleness  — 检测代码已变化的决策，标记 stale
 *   2. anchors    — APPROXIMATE_TO → ANCHORED_TO 升级
 *   3. keywords   — 全量关键词归一化
 *   4. edges      — 同文件决策对关系边补全
 *   5. gaps       — 空洞检测：有函数无决策的区域
 *
 * 用法：
 *   npm run refine                         → 全部
 *   npm run refine -- --only staleness,anchors
 */

import { Session } from 'neo4j-driver'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import { createAIProvider } from '../ai'
import { loadState } from './state'
import { getChangedFiles, getHeadCommit } from './git-utils'
import { AIProvider } from '../ai/types'
import { parseBudget, BudgetManager } from '../ai/budget'
import { normalizeKeywords as normalizeKeywordsModule } from './normalize-keywords'
import { connectDecisions, createPendingEdges } from './connect-decisions'
import fs from 'fs'
import path from 'path'

// ── CLI ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null }
const onlyStr = getArg('--only')
const budgetStr = getArg('--budget')
const onlyTasks = onlyStr ? onlyStr.split(',').map(s => s.trim()) : null
const ALL_TASKS = ['staleness', 'anchors', 'keywords', 'edges', 'gaps']

function shouldRun(task: string): boolean {
  return !onlyTasks || onlyTasks.includes(task)
}

// ── 1. Staleness 检测 ────────────────────────────────────

async function detectStaleness(session: Session, config: ReturnType<typeof loadConfig>): Promise<number> {
  console.log('\n🔍 [1/5] Staleness 检测...')
  const state = loadState()
  let marked = 0

  for (const repo of config.repos) {
    let headCommit: string
    try {
      headCommit = getHeadCommit(repo.path)
    } catch {
      console.log(`  ⚠️ ${repo.name}: 无法读取 git HEAD，跳过`)
      continue
    }

    // 找出自上次分析后变化的文件
    const changedFiles = new Set<string>()
    for (const [key, fileState] of Object.entries(state.files)) {
      if (!key.startsWith(`${repo.name}:`)) continue
      const filePath = key.slice(repo.name.length + 1)
      try {
        const changed = getChangedFiles(repo.path, fileState.lastCommit)
        if (changed.includes('__ALL__') || changed.some(cf => filePath.includes(cf) || cf.includes(filePath))) {
          changedFiles.add(filePath)
        }
      } catch {
        changedFiles.add(filePath) // 保守策略：查不到就当变了
      }
    }

    if (changedFiles.size === 0) {
      console.log(`  ✓ ${repo.name}: 无变化文件`)
      continue
    }

    // 标记变化文件上的决策为 stale
    for (const filePath of changedFiles) {
      try {
        const result = await session.run(
          `MATCH (d:DecisionContext {staleness: 'active'})-[:ANCHORED_TO|APPROXIMATE_TO]->(ce:CodeEntity {repo: $repo})
           WHERE ce.path = $filePath OR ce.path ENDS WITH $fileName
           SET d.staleness = 'stale'
           RETURN count(d) AS cnt`,
          { repo: repo.name, filePath, fileName: path.basename(filePath) }
        )
        const cnt = result.records[0]?.get('cnt')
        const num = typeof cnt === 'number' ? cnt : cnt?.toNumber?.() ?? 0
        if (num > 0) {
          marked += num
          console.log(`  📌 ${repo.name}:${filePath} → ${num} 条决策标记为 stale`)
        }
      } catch {}
    }
  }

  // 孤儿决策：没有任何锚点边的决策
  try {
    const orphanResult = await session.run(
      `MATCH (d:DecisionContext {staleness: 'active'})
       WHERE NOT EXISTS { MATCH (d)-[:ANCHORED_TO|APPROXIMATE_TO]->() }
       SET d.staleness = 'stale'
       RETURN count(d) AS cnt`
    )
    const orphans = orphanResult.records[0]?.get('cnt')
    const orphanNum = typeof orphans === 'number' ? orphans : orphans?.toNumber?.() ?? 0
    if (orphanNum > 0) {
      marked += orphanNum
      console.log(`  📌 ${orphanNum} 条孤儿决策（无锚点）标记为 stale`)
    }
  } catch {}

  console.log(`  ✅ 共 ${marked} 条决策标记为 stale`)
  return marked
}

// ── 2. 锚点精度提升 ─────────────────────────────────────

async function upgradeAnchors(session: Session): Promise<number> {
  console.log('\n🎯 [2/5] 锚点精度提升...')

  const result = await session.run(
    `MATCH (d:DecisionContext)-[r:APPROXIMATE_TO]->(f:CodeEntity {entity_type: 'file'})
     MATCH (f)-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
     WHERE fn.name <> ':program'
       AND (d.summary CONTAINS fn.name OR ANY(k IN d.keywords WHERE k = fn.name))
     RETURN d.id AS dcId, fn.name AS fnName, fn.id AS fnId, f.path AS filePath`
  )

  let upgraded = 0
  for (const r of result.records) {
    try {
      // 创建精确锚定
      await session.run(
        `MATCH (d:DecisionContext {id: $dcId})
         MATCH (fn:CodeEntity {id: $fnId})
         MERGE (d)-[:ANCHORED_TO]->(fn)`,
        { dcId: r.get('dcId'), fnId: r.get('fnId') }
      )
      // 删除模糊锚定
      await session.run(
        `MATCH (d:DecisionContext {id: $dcId})-[r:APPROXIMATE_TO]->(f:CodeEntity {path: $filePath})
         DELETE r`,
        { dcId: r.get('dcId'), filePath: r.get('filePath') }
      )
      upgraded++
      console.log(`  ↑ ${r.get('dcId')} → ANCHORED_TO ${r.get('fnName')}`)
    } catch {}
  }

  console.log(`  ✅ ${upgraded} 条锚点升级`)
  return upgraded
}

// ── 3. 关键词归一化（委托给独立积木块）────────────────────

async function runNormalizeKeywords(session: Session, ai: AIProvider): Promise<number> {
  console.log('\n🏷️  [3/5] 关键词归一化...')
  const result = await normalizeKeywordsModule(session, ai, { verbose: true })
  return result.normalized
}

// ── 4. 决策边补全（委托给独立积木块）────────────────────

async function runCompleteEdges(session: Session, ai: AIProvider, budget: BudgetManager | null): Promise<number> {
  console.log('\n🔗 [4/5] 决策边补全...')

  // connectDecisions 会消化所有 PENDING_COMPARISON 边
  // 如果图谱里还没有 PENDING 边（比如老决策从未跑过 createPendingEdges），
  // 先给所有 active 决策之间建 PENDING 边
  try {
    const allActiveResult = await session.run(
      `MATCH (d:DecisionContext {staleness: 'active'}) RETURN d.id AS id`
    )
    const allActiveIds = allActiveResult.records.map(r => r.get('id') as string)

    if (allActiveIds.length >= 2) {
      await createPendingEdges(session, allActiveIds, { verbose: false })
    }
  } catch {}

  const result = await connectDecisions({ dbSession: session, ai, budget, verbose: true })
  console.log(`  ✅ ${result.edgesCreated} 条关系边补全`)
  return result.edgesCreated
}

// ── 5. 空洞检测 ──────────────────────────────────────────

interface GapReport {
  timestamp: string
  uncoveredFunctions: { name: string; path: string; repo: string; callerCount: number }[]
  stats: { totalFunctions: number; coveredFunctions: number; coverageRate: string }
}

async function detectGaps(session: Session): Promise<GapReport> {
  console.log('\n🕳️  [5/5] 空洞检测...')

  // 总函数数
  const totalResult = await session.run(
    `MATCH (fn:CodeEntity {entity_type: 'function'})
     WHERE fn.name <> ':program'
     RETURN count(fn) AS total`
  )
  const totalFn = totalResult.records[0]?.get('total')
  const total = typeof totalFn === 'number' ? totalFn : totalFn?.toNumber?.() ?? 0

  // 有决策覆盖的函数
  const coveredResult = await session.run(
    `MATCH (d:DecisionContext {staleness: 'active'})-[:ANCHORED_TO]->(fn:CodeEntity {entity_type: 'function'})
     RETURN count(DISTINCT fn) AS covered`
  )
  const coveredFn = coveredResult.records[0]?.get('covered')
  const covered = typeof coveredFn === 'number' ? coveredFn : coveredFn?.toNumber?.() ?? 0

  // 高调用量但无决策的函数（热函数空洞）
  const hotGapResult = await session.run(
    `MATCH (caller:CodeEntity)-[:CALLS]->(fn:CodeEntity {entity_type: 'function'})
     WHERE fn.name <> ':program'
       AND NOT EXISTS {
         MATCH (d:DecisionContext {staleness: 'active'})-[:ANCHORED_TO]->(fn)
       }
     WITH fn, count(caller) AS callerCount
     WHERE callerCount >= 3
     MATCH (f:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(fn)
     RETURN fn.name AS name, f.path AS path, fn.repo AS repo, callerCount
     ORDER BY callerCount DESC
     LIMIT 30`
  )

  const uncovered = hotGapResult.records.map(r => ({
    name: r.get('name') as string,
    path: r.get('path') as string,
    repo: r.get('repo') as string,
    callerCount: typeof r.get('callerCount') === 'number' ? r.get('callerCount') : r.get('callerCount')?.toNumber?.() ?? 0,
  }))

  const rate = total > 0 ? ((covered / total) * 100).toFixed(1) : '0'
  const report: GapReport = {
    timestamp: new Date().toISOString(),
    uncoveredFunctions: uncovered,
    stats: { totalFunctions: total, coveredFunctions: covered, coverageRate: `${rate}%` },
  }

  // 写报告
  const reportPath = path.resolve(__dirname, '../../data/coverage-report.json')
  const dir = path.dirname(reportPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))

  console.log(`  📊 覆盖率: ${covered}/${total} 函数 (${rate}%)`)
  if (uncovered.length > 0) {
    console.log(`  🕳️  ${uncovered.length} 个高调用量函数缺少决策:`)
    for (const fn of uncovered.slice(0, 10)) {
      console.log(`    • ${fn.name} (${fn.callerCount} callers)  ${fn.path}`)
    }
    if (uncovered.length > 10) console.log(`    ... 共 ${uncovered.length} 个，详见 data/coverage-report.json`)
  }

  console.log(`  ✅ 报告写入 data/coverage-report.json`)
  return report
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const config = loadConfig()
  await verifyConnectivity()
  const session = await getSession()

  const tasksToRun = ALL_TASKS.filter(shouldRun)
  console.log(`\n🔧 精炼管线启动 — 任务: ${tasksToRun.join(', ')}`)
  const startTime = Date.now()

  try {
    // 1. Staleness
    if (shouldRun('staleness')) {
      await detectStaleness(session, config)
    }

    // 2. Anchors
    if (shouldRun('anchors')) {
      await upgradeAnchors(session)
    }

    // 3-4 需要 AI provider
    if (shouldRun('keywords') || shouldRun('edges')) {
      const ai = createAIProvider(config.ai)
      const budget = parseBudget(budgetStr, ai.rateLimit)

      if (shouldRun('keywords')) {
        await runNormalizeKeywords(session, ai)
        if (budget) { budget.record(ai.lastUsage); console.log(`    📊 预算: ${budget.summary()}`) }
      }

      if (shouldRun('edges')) {
        if (budget?.exceeded) {
          console.log(`  ⚠️ 预算已用完，跳过边补全`)
        } else {
          await runCompleteEdges(session, ai, budget)
        }
      }

      const { totalUsage } = ai
      console.log(`\n    📊 Token 用量: input ${totalUsage.input_tokens.toLocaleString()} + output ${totalUsage.output_tokens.toLocaleString()}`)
    }

    // 5. Gaps
    if (shouldRun('gaps')) {
      await detectGaps(session)
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`\n✅ 精炼管线完成 (${elapsed}s)\n`)

  } finally {
    await session.close()
    await closeDriver()
  }
}

main().catch(err => {
  console.error('❌ 精炼管线失败:', err.message)
  closeDriver()
  process.exit(1)
})
