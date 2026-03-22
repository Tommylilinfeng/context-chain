/**
 * ingestion/connect-decisions.ts
 *
 * 独立积木块：决策关系连接。
 *
 * 核心思路：用 PENDING_COMPARISON 边追踪"哪些决策对还没比较过"。
 * - 新决策写入后 → createPendingEdges() 建 PENDING 边
 * - 决策内容更新 → invalidateDecisionEdges() 失效旧边 + 重建 PENDING 边
 * - connectDecisions() 消化 PENDING 边 → 有关系的建关系边，没关系的删 PENDING
 *
 * 图谱的终态是干净的：只剩有意义的关系边，没有垃圾。
 *
 * 用法：
 *   import { createPendingEdges, connectDecisions } from './connect-decisions'
 *
 *   // Pipeline 写完决策后：
 *   await createPendingEdges(session, newIds)
 *   await connectDecisions({ dbSession: session, ai, budget })
 */

import { Session } from 'neo4j-driver'
import { AIProvider } from '../ai'
import { BudgetManager } from '../ai/budget'
import {
  buildGroupingPrompt,
  buildRelationshipPrompt,
  DecisionSummaryForGrouping,
  DecisionFullContent,
} from '../prompts/cold-start'
import { parseJsonSafe, runWithConcurrency } from './shared'

// ── Types ───────────────────────────────────────────────

export interface ConnectDecisionsOptions {
  dbSession: Session
  ai: AIProvider
  budget?: BudgetManager | null
  /** 一个 batch 最多放多少个 decision summary（默认 50） */
  batchCapacity?: number
  /** LLM 并发数（默认 2） */
  concurrency?: number
  verbose?: boolean
}

export interface ConnectDecisionsResult {
  /** 消化了多少条 PENDING_COMPARISON 边 */
  pendingProcessed: number
  /** 建了多少条关系边 */
  edgesCreated: number
  /** 跑了多少个 batch */
  batchesRun: number
}

interface DecisionRecord {
  id: string
  functionName: string
  filePath: string
  summary: string
  content: string
  keywords: string[]
}

const RELATIONSHIP_TYPES = ['CAUSED_BY', 'DEPENDS_ON', 'CONFLICTS_WITH', 'CO_DECIDED'] as const

// ── createPendingEdges ──────────────────────────────────

/**
 * 新决策写入后调用。
 * 为每个新决策，跟所有已有 active 决策之间建 PENDING_COMPARISON 边
 * （如果它们之间还没有任何边的话）。
 *
 * @returns 建了多少条 PENDING_COMPARISON 边
 */
export async function createPendingEdges(
  session: Session,
  newDecisionIds: string[],
  options?: { verbose?: boolean }
): Promise<number> {
  if (newDecisionIds.length === 0) return 0
  const verbose = options?.verbose ?? true
  const now = new Date().toISOString()

  let totalCreated = 0

  for (const newId of newDecisionIds) {
    try {
      // 找所有跟 newId 之间没有任何边的 active 决策
      const result = await session.run(
        `MATCH (new:DecisionContext {id: $newId})
         MATCH (existing:DecisionContext {staleness: 'active'})
         WHERE existing.id <> $newId
           AND NOT EXISTS {
             MATCH (new)-[:CAUSED_BY|DEPENDS_ON|CONFLICTS_WITH|CO_DECIDED|PENDING_COMPARISON]-(existing)
           }
         CREATE (new)-[:PENDING_COMPARISON {created_at: $now}]->(existing)
         RETURN count(existing) AS cnt`,
        { newId, now }
      )
      const cnt = toNum(result.records[0]?.get('cnt'))
      totalCreated += cnt
    } catch (err: any) {
      if (verbose) console.log(`  ⚠️ createPendingEdges 失败 (${newId}): ${err.message}`)
    }
  }

  if (verbose && totalCreated > 0) {
    console.log(`  📌 ${totalCreated} 条 PENDING_COMPARISON 边已创建`)
  }

  return totalCreated
}

// ── invalidateDecisionEdges ─────────────────────────────

/**
 * 决策内容被更新后调用。
 * 删除该决策的所有关系边和 PENDING 边，然后重建 PENDING 边。
 * 让它回到"跟所有人都没比较过"的状态。
 *
 * @returns 删了多少条旧边
 */
export async function invalidateDecisionEdges(
  session: Session,
  decisionId: string,
  options?: { verbose?: boolean }
): Promise<number> {
  const verbose = options?.verbose ?? true
  const now = new Date().toISOString()

  // 1. 删除所有关系边和 PENDING 边
  let deleted = 0
  try {
    const result = await session.run(
      `MATCH (d:DecisionContext {id: $id})-[r:CAUSED_BY|DEPENDS_ON|CONFLICTS_WITH|CO_DECIDED|PENDING_COMPARISON]-()
       DELETE r
       RETURN count(r) AS cnt`,
      { id: decisionId }
    )
    deleted = toNum(result.records[0]?.get('cnt'))
  } catch {}

  // 2. 重建 PENDING 边（跟所有 active 决策）
  try {
    await session.run(
      `MATCH (d:DecisionContext {id: $id})
       MATCH (other:DecisionContext {staleness: 'active'})
       WHERE other.id <> $id
       CREATE (d)-[:PENDING_COMPARISON {created_at: $now}]->(other)`,
      { id: decisionId, now }
    )
  } catch {}

  if (verbose && deleted > 0) {
    console.log(`  🔄 ${decisionId}: ${deleted} 条旧边已失效，PENDING 已重建`)
  }

  return deleted
}

// ── connectDecisions（核心）──────────────────────────────

/**
 * 消化所有 PENDING_COMPARISON 边。
 *
 * 1. 查所有 PENDING_COMPARISON 边涉及的决策
 * 2. 按 batchCapacity 分 batch
 * 3. 每个 batch：LLM grouping → 每组 LLM relationship → 写关系边
 * 4. 删除 batch 内所有 PENDING_COMPARISON 边（有没有关系都删）
 * 5. 迭代直到没有 PENDING 边或预算耗尽
 */
export async function connectDecisions(
  opts: ConnectDecisionsOptions
): Promise<ConnectDecisionsResult> {
  const {
    dbSession: session,
    ai,
    budget = null,
    batchCapacity = 50,
    concurrency = 2,
    verbose = true,
  } = opts

  if (verbose) console.log('\n🔗 决策关系连接...')

  let totalPendingProcessed = 0
  let totalEdgesCreated = 0
  let batchesRun = 0

  // 迭代消化 PENDING 边
  while (true) {
    // 检查预算
    if (budget?.exceeded) {
      if (verbose) console.log(`  ⚠️ 预算已用完，停止`)
      break
    }

    // 1. 查涉及 PENDING 边的决策 ID
    const pendingDecisionIds = await getPendingDecisionIds(session, batchCapacity)

    if (pendingDecisionIds.length < 2) {
      if (verbose && batchesRun === 0) console.log(`  ○ 没有待处理的 PENDING 边`)
      break
    }

    if (verbose) {
      const pendingCount = await countPendingEdges(session)
      console.log(`\n  📦 Batch ${batchesRun + 1}: ${pendingDecisionIds.length} 个决策 (${pendingCount} 条 PENDING 边剩余)`)
    }

    // 2. 读决策详情
    const decisions = await getDecisionRecords(session, pendingDecisionIds)
    if (decisions.length < 2) break

    // 3. 获取 CPG hints
    const cpgHints = await getCPGHints(session, decisions)
    if (cpgHints.length > 0 && verbose) {
      console.log(`    📁 ${cpgHints.length} 条 CPG 调用关系提示`)
    }

    // 4. LLM grouping
    const summaries: DecisionSummaryForGrouping[] = decisions.map(d => ({
      id: d.id,
      function: d.functionName,
      file: d.filePath,
      summary: d.summary,
      keywords: d.keywords,
    }))

    let groups: { group: string[]; reason: string }[] = []
    try {
      const groupPrompt = buildGroupingPrompt(summaries, cpgHints)
      const rawGroups = await ai.call(groupPrompt)
      if (budget) budget.record(ai.lastUsage)
      groups = parseJsonSafe<{ group: string[]; reason: string }[]>(rawGroups, [])
      if (!Array.isArray(groups)) groups = []

      if (verbose && groups.length > 0) {
        console.log(`    ✓ ${groups.length} 组关联决策`)
        for (const g of groups) {
          console.log(`      • [${g.group.length} 个] ${g.reason}`)
        }
      }
    } catch (err: any) {
      if (verbose) console.log(`    ⚠️ Grouping 失败: ${err.message}`)
    }

    // 5. 每组 LLM deep analysis
    let batchEdges = 0

    if (groups.length > 0) {
      const groupResults = await runWithConcurrency(
        groups,
        concurrency,
        async (group) => {
          if (budget?.exceeded) return []

          // 组装完整内容
          const groupDecisions: DecisionFullContent[] = []
          for (const id of group.group) {
            const d = decisions.find(dd => dd.id === id)
            if (d) {
              groupDecisions.push({
                id: d.id,
                function: d.functionName,
                file: d.filePath,
                summary: d.summary,
                content: d.content,
                keywords: d.keywords,
              })
            }
          }
          if (groupDecisions.length < 2) return []

          try {
            const relPrompt = buildRelationshipPrompt(groupDecisions, group.reason)
            const rawRel = await ai.call(relPrompt)
            if (budget) budget.record(ai.lastUsage)
            const result = parseJsonSafe<{ edges: any[] }>(rawRel, { edges: [] })
            return Array.isArray(result.edges) ? result.edges : []
          } catch (err: any) {
            if (verbose) console.log(`    ⚠️ 组分析失败: ${err.message}`)
            return []
          }
        }
      )

      // 写入关系边
      for (const edges of groupResults) {
        for (const edge of edges) {
          const edgeType = String(edge.type).toUpperCase()
          if (!RELATIONSHIP_TYPES.includes(edgeType as any)) continue
          if (!edge.from || !edge.to) continue

          try {
            await session.run(
              `MATCH (a:DecisionContext {id: $from})
               MATCH (b:DecisionContext {id: $to})
               MERGE (a)-[r:${edgeType}]->(b)
               SET r.reason = $reason, r.created_at = $now`,
              {
                from: edge.from,
                to: edge.to,
                reason: String(edge.reason ?? ''),
                now: new Date().toISOString(),
              }
            )
            batchEdges++
          } catch {}
        }
      }
    }

    // 6. 删除 batch 内所有 PENDING_COMPARISON 边
    //    不管有没有关系都删——有关系的已经建了关系边，没关系的删了就代表"比较过了"
    const pendingDeleted = await deletePendingEdgesAmong(session, pendingDecisionIds)

    totalPendingProcessed += pendingDeleted
    totalEdgesCreated += batchEdges
    batchesRun++

    if (verbose) {
      console.log(`    📝 ${batchEdges} 条关系边, ${pendingDeleted} 条 PENDING 边已消化`)
    }
  }

  if (verbose && batchesRun > 0) {
    console.log(`\n  ✅ 关系连接完成: ${batchesRun} 批次, ${totalEdgesCreated} 条关系边, ${totalPendingProcessed} 条 PENDING 已消化`)
  }

  return {
    pendingProcessed: totalPendingProcessed,
    edgesCreated: totalEdgesCreated,
    batchesRun,
  }
}

// ── Internal Helpers ────────────────────────────────────

/**
 * 拿涉及 PENDING 边的决策 ID，数量不超过 limit。
 * 优先选 PENDING 边最多的决策（最需要处理的）。
 */
async function getPendingDecisionIds(session: Session, limit: number): Promise<string[]> {
  try {
    const result = await session.run(
      `MATCH (d:DecisionContext)-[r:PENDING_COMPARISON]-()
       WITH d, count(r) AS pendingCount
       ORDER BY pendingCount DESC
       LIMIT $limit
       RETURN d.id AS id`,
      { limit }
    )
    return result.records.map(r => r.get('id') as string)
  } catch {
    return []
  }
}

/** 总 PENDING 边数（用于日志） */
async function countPendingEdges(session: Session): Promise<number> {
  try {
    const result = await session.run(
      `MATCH ()-[r:PENDING_COMPARISON]->() RETURN count(r) AS cnt`
    )
    return toNum(result.records[0]?.get('cnt'))
  } catch {
    return 0
  }
}

/** 读决策的完整信息 */
async function getDecisionRecords(session: Session, ids: string[]): Promise<DecisionRecord[]> {
  if (ids.length === 0) return []

  try {
    const result = await session.run(
      `MATCH (d:DecisionContext)
       WHERE d.id IN $ids
       OPTIONAL MATCH (d)-[:ANCHORED_TO|APPROXIMATE_TO]->(ce:CodeEntity)
       RETURN d.id AS id,
              d.summary AS summary,
              d.content AS content,
              d.keywords AS keywords,
              collect(DISTINCT ce.name)[0] AS fnName,
              collect(DISTINCT ce.path)[0] AS filePath`,
      { ids }
    )

    return result.records.map(r => ({
      id: r.get('id') as string,
      functionName: (r.get('fnName') as string) ?? '',
      filePath: (r.get('filePath') as string) ?? '',
      summary: (r.get('summary') as string) ?? '',
      content: (r.get('content') as string) ?? '',
      keywords: (r.get('keywords') as string[]) ?? [],
    }))
  } catch {
    return []
  }
}

/** 查 batch 内决策锚定函数之间的 CALLS 边（CPG 提示） */
async function getCPGHints(session: Session, decisions: DecisionRecord[]): Promise<string[]> {
  const fnNames = decisions.map(d => d.functionName).filter(Boolean)
  if (fnNames.length < 2) return []

  try {
    const result = await session.run(
      `MATCH (caller:CodeEntity {entity_type: 'function'})-[:CALLS]->(callee:CodeEntity {entity_type: 'function'})
       WHERE caller.name IN $names AND callee.name IN $names AND caller.name <> callee.name
       RETURN DISTINCT caller.name + ' CALLS ' + callee.name AS hint
       LIMIT 50`,
      { names: fnNames }
    )
    return result.records.map(r => r.get('hint') as string)
  } catch {
    return []
  }
}

/** 删除一组决策之间的所有 PENDING_COMPARISON 边 */
async function deletePendingEdgesAmong(session: Session, ids: string[]): Promise<number> {
  if (ids.length < 2) return 0

  try {
    const result = await session.run(
      `MATCH (a:DecisionContext)-[r:PENDING_COMPARISON]-(b:DecisionContext)
       WHERE a.id IN $ids AND b.id IN $ids
       DELETE r
       RETURN count(r) AS cnt`,
      { ids }
    )
    return toNum(result.records[0]?.get('cnt'))
  } catch {
    return 0
  }
}

// ── Utility ─────────────────────────────────────────────

function toNum(val: any): number {
  if (val === null || val === undefined) return 0
  if (typeof val === 'number') return val
  if (typeof val?.toNumber === 'function') return val.toNumber()
  return parseInt(String(val)) || 0
}

// ── Status Query (for Dashboard) ────────────────────────

/**
 * 查询当前 PENDING 边状态。供 Dashboard 使用。
 */
export async function getPendingStatus(session: Session): Promise<{
  totalPendingEdges: number
  decisionsWithPending: number
  topPendingDecisions: { id: string; summary: string; pendingCount: number }[]
}> {
  const totalResult = await session.run(
    `MATCH ()-[r:PENDING_COMPARISON]->() RETURN count(r) AS cnt`
  )
  const totalPendingEdges = toNum(totalResult.records[0]?.get('cnt'))

  const decisionCountResult = await session.run(
    `MATCH (d:DecisionContext)-[:PENDING_COMPARISON]-()
     RETURN count(DISTINCT d) AS cnt`
  )
  const decisionsWithPending = toNum(decisionCountResult.records[0]?.get('cnt'))

  const topResult = await session.run(
    `MATCH (d:DecisionContext)-[r:PENDING_COMPARISON]-()
     WITH d, count(r) AS pendingCount
     ORDER BY pendingCount DESC
     LIMIT 10
     RETURN d.id AS id, d.summary AS summary, pendingCount`
  )
  const topPendingDecisions = topResult.records.map(r => ({
    id: r.get('id') as string,
    summary: (r.get('summary') as string) ?? '',
    pendingCount: toNum(r.get('pendingCount')),
  }))

  return { totalPendingEdges, decisionsWithPending, topPendingDecisions }
}
