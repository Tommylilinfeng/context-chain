/**
 * core/batch-grouping.ts
 *
 * 链式分析 (Chain Analysis) — 按调用关系分组的批量分析策略。
 *
 *   1. 贪心集合覆盖选中心函数（coverage 最大）
 *   2. 中心 + level-1 callers/callees 作为 target
 *   3. level-2 作为 context-only（不产生 decision）
 *   4. 孤立函数退回线性分组
 *   5. 每个 batch 预估 token，超过 context window 上限自动拆分
 */

import { Session } from 'neo4j-driver'
import { BatchFunctionInput } from './analyze-function'

// ── Types ────────────────────────────────────────────────

export interface RelationshipBatch {
  functions: BatchFunctionInput[]
  /** Center function key (filePath::name) — null for linear fallback batches */
  centerKey: string | null
  /** Level-2 context-only function keys */
  contextOnlyKeys: Set<string>
  /** Edges among all functions in this batch (targets + context) */
  internalEdges: { caller: string; callee: string }[]
  /** Which target keys have existing decisions (populated later) */
  existingDecisionKeys: Set<string>
  mode: 'chain' | 'linear'
}

export interface BatchFormationStats {
  totalFunctions: number
  chainBatches: number
  linearBatches: number
  chainFunctions: number
  orphanFunctions: number
  edgeCount: number
  avgDensity: number
  centersChosen: string[]
  splitsDueToSize: number
}

type FnKey = string // "filePath::functionName"

// ── Constants ────────────────────────────────────────────

/** Estimated tokens per function (code + overhead). Used for context window budgeting. */
const EST_TOKENS_PER_TARGET = 1200
/** Estimated tokens per context-only function snippet */
const EST_TOKENS_PER_CONTEXT = 800
/** Stable prefix + instructions overhead */
const EST_PROMPT_OVERHEAD = 2000
/** Default context window budget (tokens). Conservative — leaves room for output. */
const DEFAULT_MAX_TOKENS = 100_000

// ── Graph Query ──────────────────────────────────────────

async function fetchCallEdges(
  session: Session, repo: string, candidateKeys: Set<FnKey>
): Promise<{ directed: Map<FnKey, Set<FnKey>>; undirected: Map<FnKey, Set<FnKey>>; edges: { caller: FnKey; callee: FnKey }[] }> {
  const result = await session.run(
    `MATCH (caller:CodeEntity {entity_type: 'function', repo: $repo})-[:CALLS]->(callee:CodeEntity {entity_type: 'function', repo: $repo})
     MATCH (cf:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(caller)
     MATCH (ef:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(callee)
     WHERE caller.name <> ':program' AND callee.name <> ':program'
     RETURN cf.path + '::' + caller.name AS callerKey, ef.path + '::' + callee.name AS calleeKey`,
    { repo }
  )

  const directed = new Map<FnKey, Set<FnKey>>()
  const undirected = new Map<FnKey, Set<FnKey>>()
  const edges: { caller: FnKey; callee: FnKey }[] = []

  for (const record of result.records) {
    const callerKey = record.get('callerKey') as string
    const calleeKey = record.get('calleeKey') as string
    if (!candidateKeys.has(callerKey) || !candidateKeys.has(calleeKey)) continue
    if (callerKey === calleeKey) continue

    edges.push({ caller: callerKey, callee: calleeKey })

    if (!directed.has(callerKey)) directed.set(callerKey, new Set())
    directed.get(callerKey)!.add(calleeKey)

    if (!undirected.has(callerKey)) undirected.set(callerKey, new Set())
    if (!undirected.has(calleeKey)) undirected.set(calleeKey, new Set())
    undirected.get(callerKey)!.add(calleeKey)
    undirected.get(calleeKey)!.add(callerKey)
  }

  return { directed, undirected, edges }
}

// ── Seed Selection (Greedy Set Cover) ────────────────────

function selectCenters(
  candidateKeys: FnKey[],
  undirected: Map<FnKey, Set<FnKey>>,
  maxBatchSize: number,
  hubThreshold: number,
): { centers: FnKey[]; orphans: FnKey[] } {
  const uncovered = new Set(candidateKeys)
  const centers: FnKey[] = []

  while (uncovered.size > 0) {
    let bestKey: FnKey | null = null
    let bestCoverage = 0

    for (const key of uncovered) {
      const neighbors = undirected.get(key) ?? new Set()
      if (neighbors.size > hubThreshold) continue

      let coverage = 1
      for (const n of neighbors) {
        if (uncovered.has(n)) coverage++
      }

      const fitsInBatch = coverage <= maxBatchSize
      const adjustedCoverage = fitsInBatch ? coverage : coverage * 0.5

      if (adjustedCoverage > bestCoverage) {
        bestCoverage = adjustedCoverage
        bestKey = key
      }
    }

    if (!bestKey || bestCoverage < 2) break

    centers.push(bestKey)
    const neighbors = undirected.get(bestKey) ?? new Set()
    uncovered.delete(bestKey)
    for (const n of neighbors) {
      uncovered.delete(n)
    }
  }

  return { centers, orphans: [...uncovered] }
}

// ── Chain Batch Formation ────────────────────────────────

function buildChainBatch(
  centerKey: FnKey,
  fnMap: Map<FnKey, BatchFunctionInput>,
  undirected: Map<FnKey, Set<FnKey>>,
  directed: Map<FnKey, Set<FnKey>>,
  allEdges: { caller: FnKey; callee: FnKey }[],
  maxBatchSize: number,
  alreadyAssigned: Set<FnKey>,
): RelationshipBatch | null {
  const centerFn = fnMap.get(centerKey)
  if (!centerFn) return null

  const level1Neighbors = undirected.get(centerKey) ?? new Set<FnKey>()
  const level1Keys: FnKey[] = []
  for (const n of level1Neighbors) {
    if (fnMap.has(n) && !alreadyAssigned.has(n)) {
      level1Keys.push(n)
    }
    if (level1Keys.length >= maxBatchSize - 1) break
  }

  const targetKeys = new Set<FnKey>([centerKey, ...level1Keys])

  const contextOnlyKeys = new Set<FnKey>()
  for (const l1Key of level1Keys) {
    const l1Neighbors = undirected.get(l1Key) ?? new Set<FnKey>()
    for (const n of l1Neighbors) {
      if (!targetKeys.has(n) && fnMap.has(n)) {
        contextOnlyKeys.add(n)
      }
    }
  }

  const functions: BatchFunctionInput[] = []
  for (const key of targetKeys) {
    const fn = fnMap.get(key)
    if (fn) functions.push(fn)
  }

  const allKeys = new Set([...targetKeys, ...contextOnlyKeys])
  const internalEdges = allEdges.filter(e => allKeys.has(e.caller) && allKeys.has(e.callee))

  return {
    functions,
    centerKey,
    contextOnlyKeys,
    internalEdges,
    existingDecisionKeys: new Set(),
    mode: 'chain',
  }
}

// ── Cost/Benefit Check ───────────────────────────────────

function isChainWorthIt(
  centerKey: FnKey,
  undirected: Map<FnKey, Set<FnKey>>,
  available: Set<FnKey>,
  minTargets: number = 3,
): boolean {
  const neighbors = undirected.get(centerKey) ?? new Set<FnKey>()
  let availableNeighbors = 0
  for (const n of neighbors) {
    if (available.has(n)) availableNeighbors++
  }
  return (1 + availableNeighbors) >= minTargets
}

// ── Context Window Budget Check ──────────────────────────

/**
 * Estimate token cost of a chain batch.
 * If it exceeds maxTokens, trim level-1 targets and context-only until it fits.
 */
function trimBatchToFit(
  batch: RelationshipBatch,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): { batch: RelationshipBatch; wasTrimmed: boolean } {
  const targetCount = batch.functions.length
  const contextCount = batch.contextOnlyKeys.size
  const estimated = EST_PROMPT_OVERHEAD + targetCount * EST_TOKENS_PER_TARGET + contextCount * EST_TOKENS_PER_CONTEXT

  if (estimated <= maxTokens) return { batch, wasTrimmed: false }

  // First: trim context-only (cheapest to remove)
  const tokenBudget = maxTokens - EST_PROMPT_OVERHEAD
  let remainingBudget = tokenBudget - targetCount * EST_TOKENS_PER_TARGET

  if (remainingBudget < 0) {
    // Even targets alone exceed budget — trim targets
    const maxTargets = Math.max(2, Math.floor(tokenBudget / EST_TOKENS_PER_TARGET))
    const trimmedFns = batch.functions.slice(0, maxTargets)
    const trimmedTargetKeys = new Set(trimmedFns.map(f => `${f.filePath}::${f.functionName}`))
    return {
      batch: {
        ...batch,
        functions: trimmedFns,
        contextOnlyKeys: new Set(),
        internalEdges: batch.internalEdges.filter(e => trimmedTargetKeys.has(e.caller) || trimmedTargetKeys.has(e.callee)),
      },
      wasTrimmed: true,
    }
  }

  // Trim context-only to fit
  const maxContext = Math.floor(remainingBudget / EST_TOKENS_PER_CONTEXT)
  const trimmedContext = new Set([...batch.contextOnlyKeys].slice(0, maxContext))
  const allKeys = new Set([...batch.functions.map(f => `${f.filePath}::${f.functionName}`), ...trimmedContext])

  return {
    batch: {
      ...batch,
      contextOnlyKeys: trimmedContext,
      internalEdges: batch.internalEdges.filter(e => allKeys.has(e.caller) && allKeys.has(e.callee)),
    },
    wasTrimmed: true,
  }
}

// ── Main Entry Point ─────────────────────────────────────

export async function buildRelationshipBatches(
  session: Session,
  functions: { name: string; filePath: string; lineStart: number; lineEnd: number }[],
  repo: string,
  maxBatchSize: number,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): Promise<{ batches: RelationshipBatch[]; stats: BatchFormationStats }> {
  const fnMap = new Map<FnKey, BatchFunctionInput>()
  const candidateKeys: FnKey[] = []
  for (const fn of functions) {
    const key = `${fn.filePath}::${fn.name}`
    fnMap.set(key, { functionName: fn.name, filePath: fn.filePath, lineStart: fn.lineStart, lineEnd: fn.lineEnd })
    candidateKeys.push(key)
  }

  const candidateSet = new Set(candidateKeys)
  const { directed, undirected, edges } = await fetchCallEdges(session, repo, candidateSet)
  const edgeCount = edges.length

  const hubThreshold = maxBatchSize * 3
  const { centers } = selectCenters(candidateKeys, undirected, maxBatchSize, hubThreshold)

  const batches: RelationshipBatch[] = []
  const assigned = new Set<FnKey>()
  const centersChosen: string[] = []
  let splitsDueToSize = 0

  for (const centerKey of centers) {
    if (assigned.has(centerKey)) continue
    if (!isChainWorthIt(centerKey, undirected, new Set(candidateKeys.filter(k => !assigned.has(k))))) {
      continue
    }

    const rawBatch = buildChainBatch(centerKey, fnMap, undirected, directed, edges, maxBatchSize, assigned)
    if (!rawBatch || rawBatch.functions.length < 2) continue

    // Trim to fit context window
    const { batch, wasTrimmed } = trimBatchToFit(rawBatch, maxTokens)
    if (wasTrimmed) splitsDueToSize++

    batches.push(batch)
    centersChosen.push(centerKey)
    for (const fn of batch.functions) {
      assigned.add(`${fn.filePath}::${fn.functionName}`)
    }
  }

  // Orphans + unassigned → linear fallback
  const unassigned = candidateKeys.filter(k => !assigned.has(k))
  const linearBatchSize = Math.min(maxBatchSize, 5) // linear batches use smaller size
  for (let i = 0; i < unassigned.length; i += linearBatchSize) {
    const chunk = unassigned.slice(i, i + linearBatchSize)
    const fns = chunk.map(k => fnMap.get(k)!).filter(Boolean)
    if (fns.length > 0) {
      batches.push({
        functions: fns,
        centerKey: null,
        contextOnlyKeys: new Set(),
        internalEdges: [],
        existingDecisionKeys: new Set(),
        mode: 'linear',
      })
    }
  }

  const chainBatches = batches.filter(b => b.mode === 'chain').length
  const linearBatches = batches.filter(b => b.mode === 'linear').length
  const chainFunctions = batches.filter(b => b.mode === 'chain').reduce((s, b) => s + b.functions.length, 0)

  return {
    batches,
    stats: {
      totalFunctions: functions.length,
      chainBatches,
      linearBatches,
      chainFunctions,
      orphanFunctions: unassigned.length,
      edgeCount,
      avgDensity: functions.length > 0 ? edgeCount / functions.length : 0,
      centersChosen,
      splitsDueToSize,
    },
  }
}
