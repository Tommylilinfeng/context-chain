/**
 * ingestion/submodule-discovery.ts
 *
 * File-level sub-module discovery within a module.
 * Same philosophy as module-discovery: exports as signal, files as unit.
 *
 * ═══════════════════════════════════════════════════════════
 * Pipeline (per module)
 * ═══════════════════════════════════════════════════════════
 *
 *   Phase 1 — Chunk Analysis (parallel LLM):
 *     1. Query graph for files belonging to this module
 *     2. Scan exports from filesystem for each file
 *     3. Chunk files, N concurrent LLM calls → sub-module candidates
 *
 *   Phase 2 — Merge (single LLM):
 *     4. Deduplicate + unify sub-module definitions
 *
 *   Phase 3 — Assign (single LLM):
 *     5. Assign every file to exactly one sub-module
 *
 *   Phase 4 — Write (no LLM):
 *     6. Create SubModule nodes + CHILD_OF edges + function BELONGS_TO edges
 *
 * ═══════════════════════════════════════════════════════════
 */

import * as fs from 'fs'
import * as path from 'path'
import { Session } from 'neo4j-driver'
import { AIProvider } from '../ai/types'
import {
  FileExportGroup,
  DiscoveredSubModule,
  buildSubModuleChunkPrompt,
  buildSubModuleMergePrompt,
  buildSubModuleAssignPrompt,
} from '../prompts/submodule-discovery'
import { parseJsonSafe, toNum, runWithConcurrency } from './shared'
import { NOISE_FILTER } from './noise-filter'

// ── Types ──────────────────────────────────────────────

export interface SubModuleDiscoveryOpts {
  dbSession: Session
  ai: AIProvider
  repo: string
  repoPath: string
  moduleIds: string[]
  concurrency?: number
  dryRun?: boolean
  onProgress?: (msg: string) => void
}

export interface SubModuleDiscoveryResult {
  moduleId: string
  moduleName: string
  subModules: DiscoveredSubModule[]
  stats: {
    totalFiles: number
    totalExports: number
    tokens: number
    durationMs: number
  }
}

// ── File Export Scanning ────────────────────────────────

function extractExportNames(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const names: string[] = []
  const regex = /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|abstract\s+class|interface|type|enum)\s+(\w+)/g
  let m
  while ((m = regex.exec(content)) !== null) names.push(m[1])
  return [...new Set(names)]
}

// ── Graph Queries ──────────────────────────────────────

async function getModuleFiles(
  session: Session,
  repo: string,
  moduleId: string,
): Promise<{ files: string[]; moduleName: string; moduleDescription: string }> {
  const modRes = await session.run(
    `MATCH (sm:SemanticModule {id: $moduleId, repo: $repo})
     RETURN sm.name AS name, sm.description AS desc`,
    { moduleId, repo },
  )
  const moduleName = modRes.records[0]?.get('name') ?? moduleId
  const moduleDescription = modRes.records[0]?.get('desc') ?? ''

  const res = await session.run(
    `MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm:SemanticModule {id: $moduleId, repo: $repo})
     WHERE ${NOISE_FILTER}
     MATCH (f:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(fn)
     RETURN DISTINCT f.path AS filePath
     ORDER BY f.path`,
    { moduleId, repo },
  )
  const files = res.records.map(r => r.get('filePath') as string)
  return { files, moduleName, moduleDescription }
}

// ── Chunk Splitting ─────────────────────────────────────

function buildFileExportGroups(filePaths: string[], repoPath: string): FileExportGroup[] {
  const groups: FileExportGroup[] = []
  for (const rel of filePaths) {
    const abs = path.join(repoPath, rel)
    try {
      const exports = extractExportNames(abs)
      groups.push({ path: rel, exports })
    } catch {
      groups.push({ path: rel, exports: [] })
    }
  }
  return groups
}

function splitFilesIntoChunks(files: FileExportGroup[], n: number): FileExportGroup[][] {
  const totalExports = files.reduce((s, f) => s + Math.max(f.exports.length, 1), 0)
  const targetPerChunk = Math.ceil(totalExports / n)

  const chunks: FileExportGroup[][] = []
  let current: FileExportGroup[] = []
  let currentSize = 0

  for (const f of files) {
    const fSize = Math.max(f.exports.length, 1)
    current.push(f)
    currentSize += fSize
    if (currentSize >= targetPerChunk && chunks.length < n - 1) {
      chunks.push(current)
      current = []
      currentSize = 0
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

// ── Per-Module Pipeline ─────────────────────────────────

async function discoverForModule(
  session: Session,
  ai: AIProvider,
  repo: string,
  repoPath: string,
  moduleId: string,
  concurrency: number,
  dryRun: boolean,
  onProgress: (msg: string) => void,
): Promise<SubModuleDiscoveryResult> {
  const startTime = Date.now()
  let totalTokens = 0

  // 1. Get files from graph
  const { files: filePaths, moduleName, moduleDescription } = await getModuleFiles(session, repo, moduleId)
  onProgress(`  ${moduleName}: ${filePaths.length} files`)

  if (filePaths.length === 0) {
    return {
      moduleId, moduleName, subModules: [],
      stats: { totalFiles: 0, totalExports: 0, tokens: 0, durationMs: Date.now() - startTime },
    }
  }

  // 2. Scan exports
  const allFiles = buildFileExportGroups(filePaths, repoPath)
  const totalExports = allFiles.reduce((s, f) => s + f.exports.length, 0)
  onProgress(`  ${moduleName}: ${totalExports} exports across ${allFiles.length} files`)

  // Build summary for all files (shared context)
  const allFileSummary = allFiles.map(f =>
    `${f.path} (${f.exports.length} exports)`
  ).join('\n')

  // 3. Determine chunk count: ~100-150 files per chunk
  const numChunks = Math.max(1, Math.ceil(allFiles.length / 120))

  let subModuleDefs: { subModuleId: string; name: string; description: string; keyExports: string[] }[]

  if (numChunks === 1) {
    // Small module: single-pass chunk + merge combined
    onProgress(`  ${moduleName}: single-pass analysis...`)
    const prompt = buildSubModuleChunkPrompt(allFiles, 0, 1, allFileSummary, moduleName, moduleDescription)
    const raw = await ai.call(prompt, { timeoutMs: 300000 })
    const tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
    totalTokens += tokens
    onProgress(`  ${moduleName}: chunk done (${tokens.toLocaleString()} tokens)`)

    const parsed = parseJsonSafe<{ subModules: any[] }>(raw, { subModules: [] })
    subModuleDefs = (parsed.subModules ?? []).map((s: any, i: number) => ({
      subModuleId: s.subModuleId || s.name?.toLowerCase().replace(/[^a-z0-9]+/g, '_') || `sub_${i}`,
      name: s.name || `Sub ${i}`,
      description: s.description || '',
      keyExports: Array.isArray(s.keyExports) ? s.keyExports : [],
    }))
  } else {
    // Large module: chunk → merge
    const chunks = splitFilesIntoChunks(allFiles, numChunks)
    onProgress(`  ${moduleName}: ${chunks.length} chunks (concurrency=${concurrency})...`)

    // Phase 1: parallel chunk analysis
    const chunkResults = await runWithConcurrency(
      chunks.map((chunk, i) => ({ chunk, i })),
      concurrency,
      async ({ chunk, i }) => {
        const prompt = buildSubModuleChunkPrompt(chunk, i, chunks.length, allFileSummary, moduleName, moduleDescription)
        const raw = await ai.call(prompt, { timeoutMs: 300000 })
        const tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
        totalTokens += tokens
        onProgress(`    ✓ Chunk ${i + 1}/${chunks.length}: ${chunk.length} files (${tokens.toLocaleString()} tokens)`)
        return raw
      },
    )

    // Phase 2: merge
    onProgress(`  ${moduleName}: merging...`)
    const mergePrompt = buildSubModuleMergePrompt(chunkResults, moduleName, moduleDescription, allFiles.length)
    const mergeRaw = await ai.call(mergePrompt, { timeoutMs: 300000 })
    const mergeTokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
    totalTokens += mergeTokens

    const merged = parseJsonSafe<{ subModules: any[] }>(mergeRaw, { subModules: [] })
    subModuleDefs = (merged.subModules ?? []).map((s: any, i: number) => ({
      subModuleId: s.subModuleId || `sub_${i}`,
      name: s.name || `Sub ${i}`,
      description: s.description || '',
      keyExports: Array.isArray(s.keyExports) ? s.keyExports : [],
    }))
    onProgress(`  ${moduleName}: merged → ${subModuleDefs.length} sub-modules (${mergeTokens.toLocaleString()} tokens)`)
  }

  if (subModuleDefs.length === 0) {
    // Module is cohesive enough — promote it as its own single sub-module
    onProgress(`  ${moduleName}: cohesive, promoting as single sub-module`)
    subModuleDefs = [{
      subModuleId: 'self',
      name: moduleName,
      description: moduleDescription,
      keyExports: allFiles.flatMap(f => f.exports).slice(0, 10),
    }]
  }

  // Phase 3: Assign every file to a sub-module
  let subModules: DiscoveredSubModule[]

  if (subModuleDefs.length === 1) {
    // Single sub-module — all files belong to it, no LLM needed
    subModules = [{
      ...subModuleDefs[0],
      fileIndices: allFiles.map((_, i) => i),
      confidence: 0.9,
    }]
  } else {
    onProgress(`  ${moduleName}: assigning ${allFiles.length} files to ${subModuleDefs.length} sub-modules...`)
    const assignPrompt = buildSubModuleAssignPrompt(subModuleDefs, allFiles, moduleName)
    const assignRaw = await ai.call(assignPrompt, { timeoutMs: 300000 })
    const assignTokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
    totalTokens += assignTokens

    const assignParsed = parseJsonSafe<{ assignments: any[] }>(assignRaw, { assignments: [] })
    const assignments = assignParsed.assignments ?? []

    subModules = subModuleDefs.map(def => {
      const assignment = assignments.find((a: any) => a.subModuleId === def.subModuleId)
      const fileIndices: number[] = assignment?.fileIndices?.filter(
        (idx: any) => typeof idx === 'number' && idx >= 0 && idx < allFiles.length
      ) ?? []
      return {
        ...def,
        fileIndices,
        confidence: 0.8,
      }
    })
  }

  // Post-process: catch unassigned files
  const assignedIndices = new Set<number>()
  for (const sm of subModules) {
    for (const idx of sm.fileIndices) assignedIndices.add(idx)
  }
  const unassigned = allFiles.map((_, i) => i).filter(i => !assignedIndices.has(i))
  if (unassigned.length > 0) {
    // Add to largest sub-module
    const largest = subModules.reduce((a, b) => a.fileIndices.length >= b.fileIndices.length ? a : b)
    largest.fileIndices.push(...unassigned)
    onProgress(`  ${moduleName}: ${unassigned.length} unassigned files → ${largest.name}`)
  }

  for (const sm of subModules) {
    onProgress(`    ${sm.subModuleId}: ${sm.name} (${sm.fileIndices.length} files)`)
  }
  onProgress(`  ${moduleName}: done (${totalTokens.toLocaleString()} tokens, ${((Date.now() - startTime) / 1000).toFixed(1)}s)`)

  // Phase 4: Write to graph
  if (!dryRun) {
    const now = new Date().toISOString()

    // Clear existing sub-modules for this module
    await session.run(
      `MATCH (sub:SubModule {repo: $repo, parentModuleId: $moduleId}) DETACH DELETE sub`,
      { repo, moduleId },
    )

    for (const sm of subModules) {
      const subId = `${moduleId}_${sm.subModuleId}`

      await session.run(
        `CREATE (sub:SubModule {
          id: $id, name: $name, description: $description,
          repo: $repo, parentModuleId: $moduleId,
          confidence: $confidence, function_count: 0,
          created_at: $now, source: 'submodule_discovery'
        })`,
        { id: subId, name: sm.name, description: sm.description, repo, moduleId,
          confidence: sm.confidence, now },
      )
      await session.run(
        `MATCH (sub:SubModule {id: $subId}) MATCH (sm:SemanticModule {id: $moduleId})
         MERGE (sub)-[:CHILD_OF]->(sm)`,
        { subId, moduleId },
      )

      // Assign functions from these files → this sub-module
      const filePaths = sm.fileIndices.map(i => allFiles[i]?.path).filter(Boolean)
      const BATCH = 50
      for (let j = 0; j < filePaths.length; j += BATCH) {
        const batch = filePaths.slice(j, j + BATCH)
        await session.run(
          `UNWIND $paths AS filePath
           MATCH (f:CodeEntity {entity_type: 'file', repo: $repo, path: filePath})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
           WHERE ${NOISE_FILTER}
           MATCH (sub:SubModule {id: $subId})
           MERGE (fn)-[:BELONGS_TO]->(sub)`,
          { paths: batch, repo, subId },
        )
      }

      // Update function count
      const cntRes = await session.run(
        `MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sub:SubModule {id: $subId})
         RETURN count(fn) AS cnt`,
        { subId },
      )
      const cnt = toNum(cntRes.records[0]?.get('cnt'))
      await session.run(`MATCH (sub:SubModule {id: $subId}) SET sub.function_count = $cnt`, { subId, cnt })
    }
  }

  return {
    moduleId, moduleName, subModules,
    stats: { totalFiles: allFiles.length, totalExports, tokens: totalTokens, durationMs: Date.now() - startTime },
  }
}

// ── Main Entry Point ────────────────────────────────────

export async function discoverSubModules(opts: SubModuleDiscoveryOpts): Promise<SubModuleDiscoveryResult[]> {
  const {
    dbSession, ai, repo, repoPath,
    moduleIds, concurrency = 3,
    dryRun = false, onProgress = () => {},
  } = opts

  onProgress(`Sub-module discovery for ${moduleIds.length} modules`)

  // Run modules sequentially (they share one DB session),
  // but LLM chunk analysis within each module runs concurrently
  const results: SubModuleDiscoveryResult[] = []
  for (const moduleId of moduleIds) {
    const result = await discoverForModule(dbSession, ai, repo, repoPath, moduleId, concurrency, dryRun, onProgress)
    results.push(result)
  }

  return results
}
