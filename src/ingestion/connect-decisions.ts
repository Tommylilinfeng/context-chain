/**
 * ingestion/connect-decisions.ts
 *
 * Building block: decision relationship connection.
 *
 * Core idea: use PENDING_COMPARISON edges to track which decision pairs have not been compared yet.
 * - After new decisions are written → createPendingEdges() creates PENDING edges
 * - Decision content updated → invalidateDecisionEdges() invalidates old edges + rebuilds PENDING edges
 * - connectDecisions() processes PENDING edges → creates relationship edges where found, deletes PENDING where not
 *
 * The graph converges to a clean state: only meaningful relationship edges remain.
 *
 * Usage:
 *   import { createPendingEdges, connectDecisions } from './connect-decisions'
 *
 *   // After pipeline writes decisions:
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

export interface BatchProgressEvent {
  batchIndex: number
  status: 'running' | 'done' | 'error'
  decisionsInBatch: number
  groupsFound: number
  edgesCreated: number
  pendingRemaining: number
}

export interface ConnectDecisionsOptions {
  dbSession: Session
  ai: AIProvider
  budget?: BudgetManager | null
  /** Max decision summaries per batch (default 50) */
  batchCapacity?: number
  /** LLM concurrency (default 2) */
  concurrency?: number
  verbose?: boolean
  /** Called after each batch completes (for SSE progress) */
  onBatchProgress?: (event: BatchProgressEvent) => void
  /** Called after each group within a batch is analyzed (for real-time SSE updates) */
  onGroupDone?: (info: { batchIndex: number; groupIndex: number; totalGroups: number; edgesFound: number; reason: string }) => void
  /** External abort signal */
  abortSignal?: { aborted: boolean }
  /** Comparison mode: 'summary' uses only summaries for grouping, 'content' uses full text (default 'content') */
  mode?: 'summary' | 'content'
}

export interface ConnectDecisionsResult {
  /** Number of PENDING_COMPARISON edges processed */
  pendingProcessed: number
  /** Number of relationship edges created */
  edgesCreated: number
  /** Number of batches run */
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

// ── Batch Plan ──────────────────────────────────────────

export interface BatchPlan {
  optimalK: number
  oldPerBatch: number
  totalBatches: number
  newDecisions: number
  oldDecisions: number
  batchSize: number
}

/**
 * Compute optimal batch composition for decision grouping.
 *
 * @param M - number of already-compared (old) decisions
 * @param K - number of new (uncompared) decisions
 * @param B - batch capacity (decisions per batch)
 */
export function computeBatchPlan(M: number, K: number, B: number): BatchPlan {
  if (K === 0 || B < 2) {
    return { optimalK: 0, oldPerBatch: B, totalBatches: 0, newDecisions: K, oldDecisions: M, batchSize: B }
  }

  // Special case: no old decisions — just batch all new decisions together
  if (M === 0) {
    const batches = Math.ceil(K / B)
    return { optimalK: Math.min(K, B), oldPerBatch: 0, totalBatches: batches, newDecisions: K, oldDecisions: 0, batchSize: B }
  }

  let bestK = 1
  let bestT = Infinity

  for (let k = 1; k <= Math.min(K, B - 1); k++) {
    const rounds = Math.ceil(M / (B - k))
    const groups = Math.ceil(K / k)
    const T = rounds * groups
    if (T < bestT) { bestT = T; bestK = k }
  }

  return {
    optimalK: bestK,
    oldPerBatch: B - bestK,
    totalBatches: bestT,
    newDecisions: K,
    oldDecisions: M,
    batchSize: B,
  }
}

// ── createPendingEdges ──────────────────────────────────

/**
 * Called after new decisions are written.
 * Creates PENDING_COMPARISON edges between each new decision and all existing active decisions
 * (if no edge exists between them yet).
 *
 * @returns number of PENDING_COMPARISON edges created
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
      // Find all active decisions with no edge to newId
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
      if (verbose) console.log(`  ⚠️ createPendingEdges failed (${newId}): ${err.message}`)
    }
  }

  if (verbose && totalCreated > 0) {
    console.log(`  📌 ${totalCreated}  PENDING_COMPARISON edges created`)
  }

  return totalCreated
}

// ── invalidateDecisionEdges ─────────────────────────────

/**
 * Called after decision content is updated.
 * Deletes all relationship and PENDING edges, then rebuilds PENDING edges.
 * Resets to "not compared with anyone" state.
 *
 * @returns number of old edges deleted
 */
export async function invalidateDecisionEdges(
  session: Session,
  decisionId: string,
  options?: { verbose?: boolean }
): Promise<number> {
  const verbose = options?.verbose ?? true
  const now = new Date().toISOString()

  // 1. Delete all relationship and PENDING edges
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

  // 2. Rebuild PENDING edges (with all active decisions)
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
    console.log(`  🔄 ${decisionId}: ${deleted}  old edges invalidated, PENDING rebuilt`)
  }

  return deleted
}

// ── connectDecisions（核心）──────────────────────────────

/**
 * Process all PENDING_COMPARISON edges.
 *
 * 1. Find all decisions involved in PENDING edges
 * 2. Split into batches by batchCapacity
 * 3. Each batch: LLM grouping → per-group LLM relationship → write edges
 * 4. Delete all PENDING edges in batch (regardless of result)
 * 5. Iterate until no PENDING edges remain or budget exhausted
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
    onBatchProgress,
    onGroupDone,
    abortSignal,
    mode = 'content',
  } = opts

  if (verbose) console.log('\n🔗 Connecting decisions...')

  let totalPendingProcessed = 0
  let totalEdgesCreated = 0
  let batchesRun = 0

  // Iterate through PENDING edges
  while (true) {
    // Check abort signal
    if (abortSignal?.aborted) {
      if (verbose) console.log(`  ⏹️ Abort requested, stopping`)
      break
    }

    // Check budget
    if (budget?.exceeded) {
      if (verbose) console.log(`  ⚠️ Budget exhausted, stopping`)
      break
    }

    // 1. Find decision IDs with PENDING edges
    if (verbose) console.log(`\n  🔍 Looking for decisions with PENDING edges (limit ${batchCapacity})...`)
    const pendingDecisionIds = await getPendingDecisionIds(session, batchCapacity)
    if (verbose) console.log(`  🔍 Found ${pendingDecisionIds.length} decision(s)`)

    if (pendingDecisionIds.length < 2) {
      if (verbose) console.log(`  ○ No PENDING edges to process (need ≥ 2, got ${pendingDecisionIds.length})`)
      break
    }

    if (verbose) {
      const pendingCount = await countPendingEdges(session)
      console.log(`\n  📦 Batch ${batchesRun + 1}: ${pendingDecisionIds.length}  decisions (${pendingCount}  PENDING edges remaining)`)
    }

    // 2. Load decision details
    const decisions = await getDecisionRecords(session, pendingDecisionIds)
    if (decisions.length < 2) break

    // 3. Get CPG hints
    const cpgHints = await getCPGHints(session, decisions)
    if (cpgHints.length > 0 && verbose) {
      console.log(`    📁 ${cpgHints.length}  CPG call hints loaded`)
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
        console.log(`    ✓ ${groups.length}  related decision groups`)
        for (const g of groups) {
          console.log(`      • [${g.group.length} ] ${g.reason}`)
        }
      }
    } catch (err: any) {
      if (verbose) console.log(`    ⚠️ Grouping failed: ${err.message}`)
    }

    // Check abort after grouping LLM call
    if (abortSignal?.aborted) {
      // Still delete PENDING edges for this batch to avoid re-processing
      await deletePendingEdgesAmong(session, pendingDecisionIds)
      batchesRun++
      if (verbose) console.log(`  ⏹️ Abort after grouping, skipping deep analysis`)
      break
    }

    // 5. Per-group LLM deep analysis
    let batchEdges = 0

    if (groups.length > 0) {
      const groupResults = await runWithConcurrency(
        groups,
        concurrency,
        async (group) => {
          if (budget?.exceeded || abortSignal?.aborted) return []

          // Build decision content (summary mode uses summary as content for speed)
          const groupDecisions: DecisionFullContent[] = []
          for (const id of group.group) {
            const d = decisions.find(dd => dd.id === id)
            if (d) {
              groupDecisions.push({
                id: d.id,
                function: d.functionName,
                file: d.filePath,
                summary: d.summary,
                content: mode === 'summary' ? d.summary : d.content,
                keywords: d.keywords,
              })
            }
          }
          if (groupDecisions.length < 2) return []

          try {
            const relPrompt = buildRelationshipPrompt(groupDecisions, group.reason)
            if (verbose) console.log(`      → Analyzing group [${groupDecisions.length}]: ${group.reason.slice(0, 80)}`)
            const rawRel = await ai.call(relPrompt)
            if (budget) budget.record(ai.lastUsage)
            const result = parseJsonSafe<{ edges: any[] }>(rawRel, { edges: [] })
            const edges = Array.isArray(result.edges) ? result.edges : []
            if (verbose) console.log(`        ${edges.length} edge(s) found`)
            if (onGroupDone) {
              onGroupDone({
                batchIndex: batchesRun,
                groupIndex: groups.indexOf(group),
                totalGroups: groups.length,
                edgesFound: edges.length,
                reason: group.reason.slice(0, 120),
              })
            }
            return edges
          } catch (err: any) {
            if (verbose) console.log(`    ⚠️ Group analysis failed: ${err.message}`)
            return []
          }
        }
      )

      // Write relationship edges
      for (const edges of groupResults) {
        for (const edge of edges) {
          const edgeType = String(edge.type).toUpperCase()
          if (!RELATIONSHIP_TYPES.includes(edgeType as any)) {
            if (verbose) console.log(`      ⚠️ Skipping unknown edge type: ${edgeType}`)
            continue
          }
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
          } catch (err: any) {
            if (verbose) console.log(`      ⚠️ Edge write failed (${edge.from} → ${edge.to}): ${err.message}`)
          }
        }
      }
    }

    // 6. 删除 batch 内所有 PENDING_COMPARISON 边
    //    Delete all — relationships have own edges, deleted PENDING means "already compared"
    const pendingDeleted = await deletePendingEdgesAmong(session, pendingDecisionIds)

    totalPendingProcessed += pendingDeleted
    totalEdgesCreated += batchEdges
    batchesRun++

    if (verbose) {
      console.log(`    📝 ${batchEdges}  relationship edges, ${pendingDeleted}  PENDING edges processed`)
    }

    // Fire progress callback
    if (onBatchProgress) {
      const remaining = await countPendingEdges(session)
      onBatchProgress({
        batchIndex: batchesRun - 1,
        status: 'done',
        decisionsInBatch: pendingDecisionIds.length,
        groupsFound: groups.length,
        edgesCreated: batchEdges,
        pendingRemaining: remaining,
      })
    }
  }

  if (verbose && batchesRun > 0) {
    console.log(`\n  ✅ Connection complete: ${batchesRun}  batches, ${totalEdgesCreated}  relationship edges, ${totalPendingProcessed}  PENDING processed`)
  }

  return {
    pendingProcessed: totalPendingProcessed,
    edgesCreated: totalEdgesCreated,
    batchesRun,
  }
}

// ── Internal Helpers ────────────────────────────────────

/**
 * Get decision IDs with PENDING edges, up to limit.
 * Prioritize decisions with the most PENDING edges.
 */
async function getPendingDecisionIds(session: Session, limit: number): Promise<string[]> {
  try {
    const safeLimit = Math.max(1, Math.floor(limit))
    // Simple query — Memgraph has issues with WITH+count+ORDER BY+LIMIT combo
    const result = await session.run(
      `MATCH (d:DecisionContext)-[:PENDING_COMPARISON]-()
       RETURN DISTINCT d.id AS id
       LIMIT ${safeLimit}`
    )
    const ids = result.records.map(r => r.get('id') as string)
    if (ids.length === 0) {
      console.log('  [debug] getPendingDecisionIds: 0 results')
    }
    return ids
  } catch (err: any) {
    console.error('getPendingDecisionIds error:', err.message)
    return []
  }
}

/** Total PENDING edge count (for logging) */
async function countPendingEdges(session: Session): Promise<number> {
  try {
    const result = await session.run(
      `MATCH ()-[r:PENDING_COMPARISON]->() RETURN count(r) AS cnt`
    )
    return toNum(result.records[0]?.get('cnt'))
  } catch (err: any) {
    console.error('countPendingEdges error:', err.message)
    return 0
  }
}

/** Load full decision records */
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
  } catch (err: any) {
    console.error('getDecisionRecords error:', err.message)
    return []
  }
}

/** Query CALLS edges between anchored functions in batch (CPG hints) */
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
  } catch (err: any) {
    console.error('getCPGHints error:', err.message)
    return []
  }
}

/** Delete all PENDING_COMPARISON edges among a set of decisions */
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
  } catch (err: any) {
    console.error('deletePendingEdgesAmong error:', err.message)
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
 * Query current PENDING edge status. Used by Dashboard.
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
