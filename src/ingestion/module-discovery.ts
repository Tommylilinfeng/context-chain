/**
 * ingestion/module-discovery.ts
 *
 * Semantic Module Discovery pipeline:
 *   1. Detect function communities via Louvain on CALLS subgraph (hub-removed)
 *   2. Round 1: LLM assigns semantic modules (with signatures + call edges)
 *   3. Round 2: LLM reviews boundary functions, adds/removes module memberships
 *   4. Write SemanticModule nodes + BELONGS_TO edges (many-to-many)
 */

import { Session } from 'neo4j-driver'
import { AIProvider } from '../ai/types'
import {
  ASTCommunity,
  ProposedModule,
  BoundaryFunction,
  BoundaryEdit,
  RefinedModule,
  DiscoveryResult,
  buildStructureDiscoveryPrompt,
  buildBoundaryReviewPrompt,
} from '../prompts/module-discovery'
import { parseJsonSafe, toNum, extractFunctionCode } from './shared'

// ── Community Detection ──────────────────────────────────

interface CommunityRaw {
  communityId: number
  functions: { name: string; filePath: string; lineStart: number; lineEnd: number }[]
}

export async function detectFunctionCommunities(
  session: Session,
  repo: string,
  hubThreshold: number = 20,
): Promise<{ communities: CommunityRaw[]; hubCount: number; totalFunctions: number }> {

  // Get community assignments
  const result = await session.run(
    `MATCH (hub:CodeEntity {entity_type: 'function', repo: $repo})<-[:CALLS]-(caller:CodeEntity {entity_type: 'function', repo: $repo})
     WHERE hub.name <> ':program'
     WITH hub, count(DISTINCT caller) AS inDeg
     WITH collect(CASE WHEN inDeg > $threshold THEN hub END) AS hubNodes

     MATCH (a:CodeEntity {entity_type: 'function', repo: $repo})-[r:CALLS]->(b:CodeEntity {entity_type: 'function', repo: $repo})
     WHERE a.name <> ':program' AND b.name <> ':program'
       AND NOT a IN hubNodes AND NOT b IN hubNodes
     WITH collect(DISTINCT a) + collect(DISTINCT b) AS nodes, collect(r) AS rels

     CALL community_detection.get_subgraph(nodes, rels)
     YIELD node, community_id
     OPTIONAL MATCH (file:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(node)
     RETURN community_id, node.name AS fnName, file.path AS filePath,
            node.line_start AS ls, node.line_end AS le`,
    { repo, threshold: hubThreshold }
  )

  // Group by community
  const communityMap = new Map<number, CommunityRaw['functions']>()
  for (const r of result.records) {
    const cid = toNum(r.get('community_id'))
    const fn = {
      name: r.get('fnName') as string,
      filePath: r.get('filePath') as string,
      lineStart: toNum(r.get('ls')),
      lineEnd: toNum(r.get('le')),
    }
    if (!communityMap.has(cid)) communityMap.set(cid, [])
    communityMap.get(cid)!.push(fn)
  }

  const communities: CommunityRaw[] = []
  communityMap.forEach((functions, communityId) => {
    if (functions.length >= 10) {
      communities.push({ communityId, functions })
    }
  })
  communities.sort((a, b) => b.functions.length - a.functions.length)

  // Hub count
  const hubResult = await session.run(
    `MATCH (hub:CodeEntity {entity_type: 'function', repo: $repo})<-[:CALLS]-(caller:CodeEntity {entity_type: 'function', repo: $repo})
     WHERE hub.name <> ':program'
     WITH hub, count(DISTINCT caller) AS inDeg
     WHERE inDeg > $threshold
     RETURN count(hub) AS cnt`,
    { repo, threshold: hubThreshold }
  )
  const hubCount = toNum(hubResult.records[0]?.get('cnt'))

  const countResult = await session.run(
    `MATCH (f:CodeEntity {entity_type: 'function', repo: $repo}) WHERE f.name <> ':program' RETURN count(f) AS cnt`,
    { repo }
  )
  const totalFunctions = toNum(countResult.records[0]?.get('cnt'))

  return { communities, hubCount, totalFunctions }
}

// ── Enrich communities with signatures + call edges ──────

async function enrichCommunities(
  session: Session,
  repo: string,
  repoPath: string,
  communities: CommunityRaw[],
): Promise<ASTCommunity[]> {

  // Fetch internal call edges per community
  const fnToCommunity = new Map<string, number>()
  for (const c of communities) {
    for (const fn of c.functions) {
      fnToCommunity.set(`${fn.filePath}::${fn.name}`, c.communityId)
    }
  }

  // Get all call edges between community functions
  const edgeResult = await session.run(
    `MATCH (a:CodeEntity {entity_type: 'function', repo: $repo})-[:CALLS]->(b:CodeEntity {entity_type: 'function', repo: $repo})
     MATCH (fa:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(a)
     MATCH (fb:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(b)
     WHERE a.name <> ':program' AND b.name <> ':program'
     RETURN fa.path + '::' + a.name AS callerKey, fb.path + '::' + b.name AS calleeKey`,
    { repo }
  )

  // Group edges by community
  const communityEdges = new Map<number, string[]>()
  for (const r of edgeResult.records) {
    const callerKey = r.get('callerKey') as string
    const calleeKey = r.get('calleeKey') as string
    const callerCid = fnToCommunity.get(callerKey)
    const calleeCid = fnToCommunity.get(calleeKey)
    if (callerCid != null && callerCid === calleeCid) {
      if (!communityEdges.has(callerCid)) communityEdges.set(callerCid, [])
      const callerName = callerKey.split('::').pop()
      const calleeName = calleeKey.split('::').pop()
      communityEdges.get(callerCid)!.push(`${callerName} → ${calleeName}`)
    }
  }

  return communities.map(c => {
    // Directory distribution
    const dirCounts: Record<string, number> = {}
    c.functions.forEach(fn => {
      if (!fn.filePath) return
      const dir = fn.filePath.split('/').slice(0, Math.min(2, fn.filePath.split('/').length - 1)).join('/')
      dirCounts[dir] = (dirCounts[dir] || 0) + 1
    })
    const topDirs = Object.entries(dirCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([d, c]) => `${d}(${c})`)

    // Extract signatures for top functions (by name length — longer names = more descriptive)
    const topFns = [...c.functions]
      .filter(fn => fn.name.length > 4 && !fn.startsWith?.('#'))
      .sort((a, b) => b.name.length - a.name.length)
      .slice(0, 12)

    const signatures = topFns.map(fn => {
      const code = extractFunctionCode(repoPath, fn.filePath, fn.lineStart, fn.lineEnd)
      const sig = code
        ? code.split('\n').slice(0, 2).join(' ').trim().slice(0, 120)
        : `${fn.name}()`
      return { name: fn.name, filePath: fn.filePath, sig }
    })

    // Top call edges (deduplicated)
    const edges = communityEdges.get(c.communityId) || []
    const uniqueEdges = [...new Set(edges)].slice(0, 10)

    return {
      communityId: c.communityId,
      size: c.functions.length,
      topDirs,
      sampleFiles: [...new Set(c.functions.map(fn => fn.filePath?.split('/').pop()).filter(Boolean))].slice(0, 8) as string[],
      signatures,
      topCallEdges: uniqueEdges,
    }
  })
}

// ── Round 1: Structure Discovery ─────────────────────────

async function runRound1(
  ai: AIProvider,
  communities: ASTCommunity[],
  communityRaw: CommunityRaw[],
  repo: string,
  onProgress?: (msg: string) => void,
): Promise<{ modules: ProposedModule[]; tokens: number }> {
  onProgress?.(`Round 1: Analyzing ${communities.length} communities...`)

  const prompt = buildStructureDiscoveryPrompt(communities, repo)
  const raw = await ai.call(prompt)
  const tokens = (ai.lastUsage.input_tokens ?? 0) + (ai.lastUsage.output_tokens ?? 0)
  const parsed = parseJsonSafe<{ modules: any[] }>(raw, { modules: [] })

  if (!parsed.modules || !Array.isArray(parsed.modules)) {
    throw new Error('Round 1: LLM did not return valid modules array')
  }

  // Build community → function keys map
  const communityFnKeys = new Map<number, string[]>()
  for (const c of communityRaw) {
    communityFnKeys.set(c.communityId, c.functions.map(fn => `${fn.filePath}::${fn.name}`))
  }

  const modules: ProposedModule[] = parsed.modules.map((m: any, i: number) => {
    const sourceCommunities: number[] = Array.isArray(m.sourceCommunities) ? m.sourceCommunities : []
    // Collect all function keys from source communities
    const functionKeys: string[] = []
    for (const cid of sourceCommunities) {
      const keys = communityFnKeys.get(cid) || []
      functionKeys.push(...keys)
    }

    return {
      moduleId: m.moduleId || `mod_${i + 1}`,
      name: m.name || 'Unknown',
      description: m.description || '',
      sourceCommunities,
      functionKeys: [...new Set(functionKeys)],
      confidence: m.confidence ?? 0.5,
    }
  })

  onProgress?.(`Round 1 complete: ${modules.length} modules proposed (${tokens.toLocaleString()} tokens)`)
  return { modules, tokens }
}

// ── Identify boundary functions ──────────────────────────

async function findBoundaryFunctions(
  session: Session,
  repo: string,
  repoPath: string,
  modules: ProposedModule[],
  maxBoundaryFns: number = 200,
): Promise<BoundaryFunction[]> {

  // Build function → modules map
  const fnToModules = new Map<string, string[]>()
  for (const mod of modules) {
    for (const key of mod.functionKeys) {
      if (!fnToModules.has(key)) fnToModules.set(key, [])
      fnToModules.get(key)!.push(mod.moduleId)
    }
  }

  // Get all cross-module call edges
  const edgeResult = await session.run(
    `MATCH (a:CodeEntity {entity_type: 'function', repo: $repo})-[:CALLS]->(b:CodeEntity {entity_type: 'function', repo: $repo})
     MATCH (fa:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(a)
     MATCH (fb:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(b)
     WHERE a.name <> ':program' AND b.name <> ':program'
     RETURN fa.path + '::' + a.name AS callerKey, fb.path + '::' + b.name AS calleeKey`,
    { repo }
  )

  // For each function, count callers per module
  const callerDist = new Map<string, Record<string, number>>()
  for (const r of edgeResult.records) {
    const callerKey = r.get('callerKey') as string
    const calleeKey = r.get('calleeKey') as string
    const callerModules = fnToModules.get(callerKey) || []

    if (!callerDist.has(calleeKey)) callerDist.set(calleeKey, {})
    const dist = callerDist.get(calleeKey)!
    for (const modId of callerModules) {
      dist[modId] = (dist[modId] || 0) + 1
    }
  }

  // Score functions: high out-ratio = callers from many different modules
  const scored: { key: string; score: number; dist: Record<string, number>; currentModules: string[] }[] = []
  for (const [key, dist] of callerDist.entries()) {
    const currentModules = fnToModules.get(key) || []
    if (currentModules.length === 0) continue

    const modulesCalling = Object.keys(dist).length
    const currentModuleCallers = currentModules.reduce((s, m) => s + (dist[m] || 0), 0)
    const totalCallers = Object.values(dist).reduce((s, v) => s + v, 0)
    const outRatio = totalCallers > 0 ? 1 - (currentModuleCallers / totalCallers) : 0

    // Boundary score: high if called by many modules outside its own
    if (modulesCalling >= 2 && outRatio > 0.3) {
      scored.push({ key, score: outRatio * modulesCalling, dist, currentModules })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, maxBoundaryFns)

  // Enrich with signatures
  const boundary: BoundaryFunction[] = []
  for (const s of top) {
    const sep = s.key.lastIndexOf('::')
    const filePath = s.key.slice(0, sep)
    const fnName = s.key.slice(sep + 2)

    // Get line range from graph
    const fnResult = await session.run(
      `MATCH (f:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function', name: $fnName, repo: $repo})
       RETURN fn.line_start AS ls, fn.line_end AS le LIMIT 1`,
      { filePath, fnName, repo }
    )
    let sig = `${fnName}()`
    if (fnResult.records.length > 0) {
      const ls = toNum(fnResult.records[0].get('ls'))
      const le = toNum(fnResult.records[0].get('le'))
      const code = extractFunctionCode(repoPath, filePath, ls, le)
      if (code) sig = code.split('\n').slice(0, 2).join(' ').trim().slice(0, 120)
    }

    boundary.push({
      key: s.key,
      currentModules: s.currentModules,
      signature: sig,
      callerDistribution: s.dist,
    })
  }

  return boundary
}

// ── Round 2: Boundary Review ─────────────────────────────

async function runRound2(
  ai: AIProvider,
  modules: ProposedModule[],
  boundaryFunctions: BoundaryFunction[],
  onProgress?: (msg: string) => void,
): Promise<{ edits: BoundaryEdit[]; tokens: number }> {
  if (boundaryFunctions.length === 0) {
    onProgress?.('Round 2: No boundary functions to review')
    return { edits: [], tokens: 0 }
  }

  onProgress?.(`Round 2: Reviewing ${boundaryFunctions.length} boundary functions across ${modules.length} modules...`)

  const moduleSummaries = modules.map(m => ({
    moduleId: m.moduleId,
    name: m.name,
    description: m.description,
    functionCount: m.functionKeys.length,
  }))

  // Batch if too many boundary functions
  const BATCH_SIZE = 80
  const allEdits: BoundaryEdit[] = []
  let totalTokens = 0

  for (let i = 0; i < boundaryFunctions.length; i += BATCH_SIZE) {
    const batch = boundaryFunctions.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(boundaryFunctions.length / BATCH_SIZE)
    if (totalBatches > 1) onProgress?.(`  Batch ${batchNum}/${totalBatches} (${batch.length} functions)...`)

    const prompt = buildBoundaryReviewPrompt(moduleSummaries, batch)
    const raw = await ai.call(prompt)
    totalTokens += (ai.lastUsage.input_tokens ?? 0) + (ai.lastUsage.output_tokens ?? 0)

    const parsed = parseJsonSafe<{ edits: any[] }>(raw, { edits: [] })
    if (parsed.edits && Array.isArray(parsed.edits)) {
      for (const e of parsed.edits) {
        if (e.functionKey && (e.addTo?.length > 0 || e.removeFrom?.length > 0)) {
          allEdits.push({
            functionKey: e.functionKey,
            addTo: Array.isArray(e.addTo) ? e.addTo : [],
            removeFrom: Array.isArray(e.removeFrom) ? e.removeFrom : [],
            reasoning: e.reasoning || '',
          })
        }
      }
    }
  }

  onProgress?.(`Round 2 complete: ${allEdits.length} edits proposed (${totalTokens.toLocaleString()} tokens)`)
  return { edits: allEdits, tokens: totalTokens }
}

// ── Apply edits to modules ───────────────────────────────

function applyEdits(modules: ProposedModule[], edits: BoundaryEdit[]): RefinedModule[] {
  // Build mutable function → modules map
  const fnToModules = new Map<string, Set<string>>()
  for (const mod of modules) {
    for (const key of mod.functionKeys) {
      if (!fnToModules.has(key)) fnToModules.set(key, new Set())
      fnToModules.get(key)!.add(mod.moduleId)
    }
  }

  // Apply edits
  let appliedCount = 0
  for (const edit of edits) {
    const current = fnToModules.get(edit.functionKey)
    if (!current) continue

    for (const modId of edit.addTo) {
      if (modules.some(m => m.moduleId === modId)) {
        current.add(modId)
        appliedCount++
      }
    }
    for (const modId of edit.removeFrom) {
      // Don't remove if it would leave the function with no modules
      if (current.size > 1) {
        current.delete(modId)
        appliedCount++
      }
    }
  }

  // Rebuild modules with updated function lists
  const moduleKeySet = new Map<string, Set<string>>()
  for (const mod of modules) {
    moduleKeySet.set(mod.moduleId, new Set())
  }
  for (const [fnKey, modIds] of fnToModules.entries()) {
    for (const modId of modIds) {
      moduleKeySet.get(modId)?.add(fnKey)
    }
  }

  return modules.map(mod => ({
    moduleId: mod.moduleId,
    name: mod.name,
    description: mod.description,
    functionKeys: [...(moduleKeySet.get(mod.moduleId) || mod.functionKeys)],
    confidence: mod.confidence,
  }))
}

// ── Write to Graph ───────────────────────────────────────

export async function writeModulesToGraph(
  session: Session,
  modules: RefinedModule[],
  repo: string,
): Promise<{ modulesWritten: number; edgesWritten: number }> {
  const now = new Date().toISOString()

  // Clear existing modules for this repo
  await session.run(
    `MATCH (sm:SemanticModule {repo: $repo}) DETACH DELETE sm`,
    { repo }
  )

  let modulesWritten = 0
  let edgesWritten = 0

  for (const mod of modules) {
    // Create module node
    await session.run(
      `CREATE (sm:SemanticModule {
        id: $id, name: $name, description: $description,
        repo: $repo, confidence: $confidence,
        function_count: $fnCount, created_at: $now,
        source: 'module_discovery'
      })`,
      {
        id: mod.moduleId, name: mod.name, description: mod.description,
        repo, confidence: mod.confidence,
        fnCount: mod.functionKeys.length, now,
      }
    )
    modulesWritten++

    // Create BELONGS_TO edges in batches
    const BATCH = 50
    for (let i = 0; i < mod.functionKeys.length; i += BATCH) {
      const batch = mod.functionKeys.slice(i, i + BATCH)
      const pairs = batch.map(key => {
        const sep = key.lastIndexOf('::')
        return { filePath: key.slice(0, sep), fnName: key.slice(sep + 2) }
      })

      const result = await session.run(
        `UNWIND $pairs AS p
         MATCH (fn:CodeEntity {entity_type: 'function', name: p.fnName, repo: $repo})
         MATCH (f:CodeEntity {entity_type: 'file', path: p.filePath})-[:CONTAINS]->(fn)
         MATCH (sm:SemanticModule {id: $moduleId})
         MERGE (fn)-[:BELONGS_TO]->(sm)
         RETURN count(*) AS cnt`,
        { pairs, repo, moduleId: mod.moduleId }
      )
      edgesWritten += toNum(result.records[0]?.get('cnt'))
    }
  }

  return { modulesWritten, edgesWritten }
}

// ── Main Pipeline ────────────────────────────────────────

export interface DiscoverModulesOpts {
  dbSession: Session
  ai: AIProvider
  repo: string
  repoPath: string
  hubThreshold?: number
  maxBoundaryFns?: number
  dryRun?: boolean
  onProgress?: (msg: string) => void
}

export async function discoverModules(opts: DiscoverModulesOpts): Promise<DiscoveryResult> {
  const {
    dbSession, ai, repo, repoPath,
    hubThreshold = 20, maxBoundaryFns = 150,
    dryRun = false, onProgress,
  } = opts
  const startTime = Date.now()

  // Step 0: Community detection
  onProgress?.('Detecting function communities...')
  const { communities: rawCommunities, hubCount, totalFunctions } = await detectFunctionCommunities(
    dbSession, repo, hubThreshold
  )
  onProgress?.(`Found ${rawCommunities.length} communities (${hubCount} hub functions excluded, ${totalFunctions} total)`)

  if (rawCommunities.length === 0) {
    throw new Error('No communities detected. Check that the repo has function CALLS edges.')
  }

  // Step 0.5: Enrich with signatures + call edges
  onProgress?.('Enriching communities with signatures and call edges...')
  const communities = await enrichCommunities(dbSession, repo, repoPath, rawCommunities)

  // Step 1: Structure Discovery
  const { modules: proposedModules, tokens: r1Tokens } = await runRound1(
    ai, communities, rawCommunities, repo, onProgress
  )

  // Step 1.5: Find boundary functions
  onProgress?.('Identifying boundary functions...')
  const boundaryFunctions = await findBoundaryFunctions(
    dbSession, repo, repoPath, proposedModules, maxBoundaryFns
  )
  onProgress?.(`Found ${boundaryFunctions.length} boundary functions for review`)

  // Step 2: Boundary Review
  const { edits, tokens: r2Tokens } = await runRound2(
    ai, proposedModules, boundaryFunctions, onProgress
  )

  // Apply edits
  const refined = applyEdits(proposedModules, edits)

  // Step 3: Write to graph
  if (!dryRun) {
    onProgress?.('Writing modules to graph...')
    const { modulesWritten, edgesWritten } = await writeModulesToGraph(dbSession, refined, repo)
    onProgress?.(`Written ${modulesWritten} modules, ${edgesWritten} BELONGS_TO edges`)
  } else {
    onProgress?.('[DRY RUN] Skipping graph write')
  }

  return {
    modules: refined,
    boundaryEdits: edits,
    stats: {
      communitiesDetected: rawCommunities.length,
      initialModules: proposedModules.length,
      finalModules: refined.length,
      boundaryFunctionsReviewed: boundaryFunctions.length,
      editsApplied: edits.length,
      round1Tokens: r1Tokens,
      round2Tokens: r2Tokens,
      totalTokens: r1Tokens + r2Tokens,
      durationMs: Date.now() - startTime,
    },
  }
}
