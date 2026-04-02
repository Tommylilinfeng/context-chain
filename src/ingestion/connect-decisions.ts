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
} from '../prompts/grouping'
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
  /** Max decision summaries per batch (default 200, no upper limit) */
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
  /** Anchor decisions per pass — fixed for KV cache hits */
  anchorSize: number
  /** Rotating decisions per round */
  rotateSize: number
  /** Total LLM grouping rounds across all passes */
  totalRounds: number
  /** Number of passes (each pass retires one anchor set) */
  totalPasses: number
  /** Total decisions in pool */
  poolSize: number
  batchSize: number
  /** Whether plan detected incremental mode */
  incremental: boolean
}

/**
 * Compute batch plan for anchor/rotate KV-cache strategy.
 *
 * Each pass: fix anchor decisions, rotate remaining through in chunks.
 * After a pass, anchor decisions are fully compared → removed from pool.
 * Repeat until pool exhausted.
 *
 * In incremental mode (anchorOverride provided), the anchor is the small set
 * of changed decisions — often just 1 pass is needed.
 *
 * @param N - total decisions needing comparison (with PENDING edges)
 * @param B - batch capacity (decisions per batch)
 * @param anchorOverride - explicit anchor size (for incremental mode); omit for default B/2
 */
export function computeBatchPlan(N: number, B: number, anchorOverride?: number): BatchPlan {
  if (N < 2 || B < 2) {
    return { anchorSize: 0, rotateSize: 0, totalRounds: 0, totalPasses: 0, poolSize: N, batchSize: B, incremental: false }
  }

  const incremental = anchorOverride !== undefined && anchorOverride < Math.floor(B / 2)
  const anchorSize = anchorOverride ?? Math.floor(B / 2)
  const rotateSize = B - anchorSize

  let totalRounds = 0
  let totalPasses = 0
  let P = N

  while (P >= 2) {
    // For incremental first pass, use the override; subsequent passes use B/2
    const a = totalPasses === 0
      ? Math.min(anchorSize, P)
      : Math.min(Math.floor(B / 2), P)
    const r = totalPasses === 0 ? rotateSize : B - a
    const remaining = P - a
    if (remaining === 0) {
      totalRounds += 1
      totalPasses += 1
      break
    }
    totalRounds += Math.ceil(remaining / r)
    totalPasses += 1
    P = remaining
  }

  return { anchorSize, rotateSize, totalRounds, totalPasses, poolSize: N, batchSize: B, incremental }
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
  options?: { verbose?: boolean; excludeIds?: string[] }
): Promise<number> {
  if (newDecisionIds.length === 0) return 0
  const verbose = options?.verbose ?? true
  const excludeIds = options?.excludeIds ?? []
  const now = new Date().toISOString()

  let totalCreated = 0

  for (const newId of newDecisionIds) {
    try {
      // Find all active decisions with no edge to newId
      // excludeIds: skip PENDING edges between decisions already analyzed together (e.g. cluster batch)
      const excludeFilter = excludeIds.length > 0 ? ' AND NOT existing.id IN $excludeIds' : ''
      const result = await session.run(
        `MATCH (new:DecisionContext {id: $newId})
         MATCH (existing:DecisionContext {staleness: 'active'})
         WHERE existing.id <> $newId${excludeFilter}
           AND NOT EXISTS {
             MATCH (new)-[:CAUSED_BY|DEPENDS_ON|CONFLICTS_WITH|CO_DECIDED|PENDING_COMPARISON]-(existing)
           }
         CREATE (new)-[:PENDING_COMPARISON {created_at: $now}]->(existing)
         RETURN count(existing) AS cnt`,
        { newId, now, excludeIds }
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
 * Process all PENDING_COMPARISON edges using anchor/rotate KV-cache strategy.
 *
 * Each pass:
 *   1. Select anchor (B/2 decisions) — fixed across all rounds for KV cache hits
 *   2. Rotate remaining decisions through in chunks of B/2
 *   3. Each round: LLM grouping → per-group LLM relationship → write edges → delete PENDING
 *   4. After all remaining are rotated, anchor is fully compared → removed from pool
 *   5. Repeat with shrunk pool until done
 */
export async function connectDecisions(
  opts: ConnectDecisionsOptions
): Promise<ConnectDecisionsResult> {
  const {
    dbSession: session,
    ai,
    budget = null,
    batchCapacity = 200,
    concurrency = 2,
    verbose = true,
    onBatchProgress,
    onGroupDone,
    abortSignal,
    mode = 'content',
  } = opts

  if (verbose) console.log('\n🔗 Connecting decisions (anchor/rotate cache strategy)...')

  let totalPendingProcessed = 0
  let totalEdgesCreated = 0
  let batchesRun = 0
  let passIndex = 0

  // Outer loop: each pass selects a new anchor set
  while (true) {
    if (abortSignal?.aborted) {
      if (verbose) console.log(`  ⏹️ Abort requested, stopping`)
      break
    }
    if (budget?.exceeded) {
      if (verbose) console.log(`  ⚠️ Budget exhausted, stopping`)
      break
    }

    // Get all decisions with PENDING edges, sorted by count desc
    const poolInfo = await getPendingDecisionsSorted(session)
    if (poolInfo.length < 2) {
      if (verbose) console.log(`  ○ No PENDING edges to process (pool size: ${poolInfo.length})`)
      break
    }

    // Detect anchor size: incremental (small changed set) vs full (B/2)
    const detection = detectAnchorSize(poolInfo, batchCapacity)
    const effectiveAnchorSize = detection.anchorSize
    const rotateSize = batchCapacity - effectiveAnchorSize

    // Split: anchor (fixed for cache) + rest (to rotate through)
    const anchor = poolInfo.slice(0, effectiveAnchorSize).map(p => p.id)
    const rest = poolInfo.slice(effectiveAnchorSize).map(p => p.id)

    passIndex++
    if (verbose) {
      const pendingCount = await countPendingEdges(session)
      const modeLabel = detection.mode === 'incremental'
        ? `incremental (${anchor.length} changed)`
        : `full (B/2=${effectiveAnchorSize})`
      console.log(`\n  🔄 Pass ${passIndex} [${modeLabel}]: anchor=${anchor.length}, remaining=${rest.length}, pool=${poolInfo.length} (${pendingCount} PENDING edges)`)
    }

    // If all fit in one batch, just process together
    if (rest.length === 0) {
      const result = await processOneBatch({
        session, ai, budget, concurrency, verbose, mode,
        batchIds: anchor, batchesRun, onBatchProgress, onGroupDone, abortSignal,
      })
      totalPendingProcessed += result.pendingDeleted
      totalEdgesCreated += result.edgesCreated
      batchesRun++
      break
    }

    // Inner loop: rotate rest through in chunks, anchor stays fixed
    for (let i = 0; i < rest.length; i += rotateSize) {
      if (abortSignal?.aborted) {
        if (verbose) console.log(`  ⏹️ Abort requested mid-pass`)
        break
      }
      if (budget?.exceeded) {
        if (verbose) console.log(`  ⚠️ Budget exhausted mid-pass`)
        break
      }

      const chunk = rest.slice(i, i + rotateSize)
      const batchIds = [...anchor, ...chunk]

      if (verbose) {
        const roundInPass = Math.floor(i / rotateSize) + 1
        const totalRoundsInPass = Math.ceil(rest.length / rotateSize)
        console.log(`\n  📦 Pass ${passIndex} Round ${roundInPass}/${totalRoundsInPass}: ${anchor.length} anchor + ${chunk.length} rotate = ${batchIds.length} decisions`)
      }

      const result = await processOneBatch({
        session, ai, budget, concurrency, verbose, mode,
        batchIds, batchesRun, onBatchProgress, onGroupDone, abortSignal,
      })
      totalPendingProcessed += result.pendingDeleted
      totalEdgesCreated += result.edgesCreated
      batchesRun++
    }

    // Anchor is now fully compared with all others.
    // Delete any remaining PENDING edges among anchor (should be covered, but be safe).
    await deletePendingEdgesAmong(session, anchor)

    if (verbose) {
      console.log(`  ✓ Pass ${passIndex} done: anchor ${anchor.length} decisions retired from pool`)
    }
  }

  if (verbose && batchesRun > 0) {
    console.log(`\n  ✅ Connection complete: ${passIndex} passes, ${batchesRun} rounds, ${totalEdgesCreated} relationship edges, ${totalPendingProcessed} PENDING processed`)
  }

  return {
    pendingProcessed: totalPendingProcessed,
    edgesCreated: totalEdgesCreated,
    batchesRun,
  }
}

// ── processOneBatch (extracted for anchor/rotate reuse) ──

interface ProcessBatchOpts {
  session: Session
  ai: AIProvider
  budget: BudgetManager | null
  concurrency: number
  verbose: boolean
  mode: 'summary' | 'content'
  batchIds: string[]
  batchesRun: number
  onBatchProgress?: ConnectDecisionsOptions['onBatchProgress']
  onGroupDone?: ConnectDecisionsOptions['onGroupDone']
  abortSignal?: { aborted: boolean }
}

async function processOneBatch(opts: ProcessBatchOpts): Promise<{ edgesCreated: number; pendingDeleted: number }> {
  const { session, ai, budget, concurrency, verbose, mode, batchIds, batchesRun, onBatchProgress, onGroupDone, abortSignal } = opts

  // Load decision details
  const decisions = await getDecisionRecords(session, batchIds)
  if (decisions.length < 2) return { edgesCreated: 0, pendingDeleted: 0 }

  // Get CPG hints
  const cpgHints = await getCPGHints(session, decisions)
  if (cpgHints.length > 0 && verbose) {
    console.log(`    📁 ${cpgHints.length} CPG call hints loaded`)
  }

  // LLM grouping
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
      console.log(`    ✓ ${groups.length} related decision groups`)
      for (const g of groups) {
        console.log(`      • [${g.group.length}] ${g.reason}`)
      }
    }
  } catch (err: any) {
    if (verbose) console.log(`    ⚠️ Grouping failed: ${err.message}`)
  }

  // Check abort after grouping LLM call
  if (abortSignal?.aborted) {
    const pendingDeleted = await deletePendingEdgesAmong(session, batchIds)
    if (verbose) console.log(`  ⏹️ Abort after grouping, skipping deep analysis`)
    return { edgesCreated: 0, pendingDeleted }
  }

  // Per-group LLM deep analysis
  let batchEdges = 0

  if (groups.length > 0) {
    const groupResults = await runWithConcurrency(
      groups,
      concurrency,
      async (group) => {
        if (budget?.exceeded || abortSignal?.aborted) return []

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

  // Delete PENDING edges among batch members
  const pendingDeleted = await deletePendingEdgesAmong(session, batchIds)

  if (verbose) {
    console.log(`    📝 ${batchEdges} relationship edges, ${pendingDeleted} PENDING edges processed`)
  }

  // Fire progress callback
  if (onBatchProgress) {
    const remaining = await countPendingEdges(session)
    onBatchProgress({
      batchIndex: batchesRun,
      status: 'done',
      decisionsInBatch: batchIds.length,
      groupsFound: groups.length,
      edgesCreated: batchEdges,
      pendingRemaining: remaining,
    })
  }

  return { edgesCreated: batchEdges, pendingDeleted }
}

// ── Internal Helpers ────────────────────────────────────

interface PendingDecisionInfo {
  id: string
  pendingCount: number
}

/**
 * Get ALL decisions with PENDING edges, sorted by PENDING count descending.
 * High-count decisions are natural anchors (incremental: the changed set).
 */
async function getPendingDecisionsSorted(session: Session): Promise<PendingDecisionInfo[]> {
  try {
    const result = await session.run(
      `MATCH (d:DecisionContext)-[r:PENDING_COMPARISON]-()
       RETURN d.id AS id, count(r) AS cnt
       ORDER BY cnt DESC`
    )
    const items = result.records.map(r => ({
      id: r.get('id') as string,
      pendingCount: toNum(r.get('cnt')),
    }))
    if (items.length === 0) {
      console.log('  [debug] getPendingDecisionsSorted: 0 results')
    }
    return items
  } catch (err: any) {
    console.error('getPendingDecisionsSorted error:', err.message)
    return []
  }
}

/**
 * Detect anchor size from PENDING count distribution.
 *
 * Incremental case: K changed decisions have count ≈ N, the rest have count ≈ K.
 *   → anchor = the K high-count decisions (often << B/2), rotate = B - K per round.
 *
 * Full case: all decisions have similar counts.
 *   → anchor = B/2 (default split).
 */
function detectAnchorSize(pool: PendingDecisionInfo[], batchCapacity: number): { anchorSize: number; mode: 'incremental' | 'full' } {
  const defaultAnchor = Math.floor(batchCapacity / 2)

  if (pool.length <= batchCapacity) {
    // Everything fits in one batch, anchor = all
    return { anchorSize: pool.length, mode: 'full' }
  }

  const maxCount = pool[0].pendingCount
  const minCount = pool[pool.length - 1].pendingCount

  // If top count is >3× bottom count, there's an incremental cluster
  if (maxCount > 3 * minCount && minCount > 0) {
    const threshold = (maxCount + minCount) / 2
    let clusterSize = 0
    for (const p of pool) {
      if (p.pendingCount >= threshold) clusterSize++
      else break // sorted desc, so we can break early
    }
    // Only use incremental mode if cluster is smaller than default anchor
    // (otherwise B/2 is already good enough)
    if (clusterSize > 0 && clusterSize < defaultAnchor) {
      return { anchorSize: clusterSize, mode: 'incremental' }
    }
  }

  return { anchorSize: defaultAnchor, mode: 'full' }
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
