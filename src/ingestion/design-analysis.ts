/**
 * ingestion/design-analysis.ts
 *
 * Design Analysis pipeline (layers 2-5):
 *   Layer 2:   Sub-Module Decomposition — AI per module, many-to-many
 *   Layer 2.5: Misassigned Reassignment — single AI call, closed-loop correction
 *   Layer 3:   Decision Attribution — zero-cost graph query
 *   Layer 4:   Theme + DesignChoice — AI per sub-module
 *   Layer 5:   Cross-Module Theme Merge — single AI call
 *
 * Prerequisite: Module Discovery must have run (SemanticModule nodes exist).
 */

import { Session } from 'neo4j-driver'
import { AIProvider } from '../ai/types'
import { parseJsonSafe, toNum, runWithConcurrency, extractFunctionCode } from './shared'
import fs from 'fs'
import path from 'path'
import {
  SubModuleInput,
  SubModuleOutput,
  MisassignedFunction,
  SubModuleTarget,
  SubModuleReassignmentOutput,
  DesignAnalysisResult,
  buildSubModulePrompt,
  buildMisassignedReassignmentPrompt,
} from '../prompts/design-analysis'

// ── Options ─────────────────────────────────────────────

export interface DesignAnalysisOpts {
  dbSession: Session
  ai: AIProvider
  repo: string
  repoPath: string
  concurrency?: number          // parallel AI calls (default 5)
  maxLinesPerFunction?: number  // max source lines per function in prompt (0 = name only, default 0)
  moduleIds?: string[]          // if set, only process these modules (skip others)
  dryRun?: boolean
  shouldAbort?: () => boolean
  onProgress?: (msg: string) => void
}

// ── Layer 2: Sub-Module Decomposition ───────────────────

interface ModuleFunction {
  name: string
  filePath: string
  lineStart: number
  lineEnd: number
  sourceCode?: string   // populated when maxLinesPerFunction > 0
}

interface ModuleData {
  moduleId: string
  moduleName: string
  moduleDescription: string
  functions: ModuleFunction[]
  callEdges: string[]
}

async function getModulesWithFunctions(session: Session, repo: string): Promise<ModuleData[]> {
  const result = await session.run(
    `MATCH (sm:SemanticModule {repo: $repo})
     MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm)
     OPTIONAL MATCH (file:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(fn)
     RETURN sm.id AS moduleId, sm.name AS moduleName, sm.description AS moduleDesc,
            fn.name AS fnName, file.path AS filePath,
            fn.line_start AS lineStart, fn.line_end AS lineEnd
     ORDER BY sm.id, file.path, fn.name`,
    { repo }
  )

  const moduleMap = new Map<string, ModuleData>()
  for (const rec of result.records) {
    const mid = rec.get('moduleId')
    if (!moduleMap.has(mid)) {
      moduleMap.set(mid, {
        moduleId: mid,
        moduleName: rec.get('moduleName') ?? '',
        moduleDescription: rec.get('moduleDesc') ?? '',
        functions: [],
        callEdges: [],
      })
    }
    moduleMap.get(mid)!.functions.push({
      name: rec.get('fnName') ?? '',
      filePath: rec.get('filePath') ?? '',
      lineStart: toNum(rec.get('lineStart')) ?? 0,
      lineEnd: toNum(rec.get('lineEnd')) ?? 0,
    })
  }

  // Fetch internal call edges per module
  for (const mod of Array.from(moduleMap.values())) {
    const callRes = await session.run(
      `MATCH (a:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm:SemanticModule {id: $moduleId})
       MATCH (b:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm)
       MATCH (a)-[:CALLS]->(b)
       RETURN a.name AS caller, b.name AS callee
       LIMIT 200`,
      { moduleId: mod.moduleId }
    )
    mod.callEdges = callRes.records.map(r => `${r.get('caller')} -> ${r.get('callee')}`)
  }

  return Array.from(moduleMap.values())
}

/** Populate sourceCode on each function, truncated to maxLines (includes comments). */
function loadModuleSourceCode(modules: ModuleData[], repoPath: string, maxLines: number): void {
  for (const mod of modules) {
    for (const fn of mod.functions) {
      if (fn.lineStart === 0 || fn.lineEnd === 0) continue
      const raw = extractFunctionCode(repoPath, fn.filePath, fn.lineStart, fn.lineEnd)
      if (!raw) continue
      const lines = raw.split('\n')
      fn.sourceCode = lines.length > maxLines
        ? lines.slice(0, maxLines).join('\n') + `\n// ... truncated (${lines.length} lines total)`
        : raw
    }
  }
}

/** Estimate tokens for a module prompt at a given maxLines setting. */
function estimateModuleTokens(
  mod: ModuleData,
  fnLineCounts: number[],
  maxLines: number,
): number {
  let codeLines = 0
  for (const lc of fnLineCounts) {
    codeLines += maxLines > 0 ? Math.min(lc, maxLines) : 0
  }
  const metadataTokens = mod.functions.length * 50
  const codeTokens = codeLines * 10
  const edgeTokens = mod.callEdges.length * 15
  const promptOverhead = 800
  return metadataTokens + codeTokens + edgeTokens + promptOverhead
}

// ── Stats / Pre-analysis ────────────────────────────────

export interface ModuleStats {
  moduleId: string
  moduleName: string
  functionCount: number
  functionsWithSource: number
  lineCounts: number[]        // raw line count per function (from disk)
  totalLines: number
  meanLines: number
  medianLines: number
  p90Lines: number
  maxLines: number
  maxFunctionName: string
  // estimated tokens at various max-lines settings
  tokenEstimates: { maxLines: number; tokens: number; pctOf200K: number }[]
}

export interface RepoModuleStats {
  repo: string
  modules: ModuleStats[]
  totalFunctions: number
  totalLines: number
  globalLineCounts: number[]
}

/** Collect raw line counts for all functions in a module (reads source from disk). */
function collectFunctionLineCounts(
  mod: ModuleData,
  repoPath: string,
): { lineCounts: number[]; maxFnName: string; functionsWithSource: number } {
  const lineCounts: number[] = []
  let maxLines = 0
  let maxFnName = ''
  let withSource = 0

  for (const fn of mod.functions) {
    if (fn.lineStart === 0 || fn.lineEnd === 0) continue
    const raw = extractFunctionCode(repoPath, fn.filePath, fn.lineStart, fn.lineEnd)
    if (!raw) continue
    withSource++
    const lc = raw.split('\n').length
    lineCounts.push(lc)
    if (lc > maxLines) {
      maxLines = lc
      maxFnName = `${fn.filePath}::${fn.name}`
    }
  }
  return { lineCounts, maxFnName, functionsWithSource: withSource }
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const sorted = arr.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = arr.slice().sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * p / 100)
  return sorted[Math.min(idx, sorted.length - 1)]
}

/** Build a horizontal ASCII histogram of line counts. */
function buildHistogram(lineCounts: number[], barWidth: number = 40): string[] {
  if (lineCounts.length === 0) return ['  (no data)']
  const buckets = [
    { label: '  1-5   ', lo: 1, hi: 5 },
    { label: '  6-10  ', lo: 6, hi: 10 },
    { label: ' 11-30  ', lo: 11, hi: 30 },
    { label: ' 31-60  ', lo: 31, hi: 60 },
    { label: ' 61-100 ', lo: 61, hi: 100 },
    { label: '101-200 ', lo: 101, hi: 200 },
    { label: '201-500 ', lo: 201, hi: 500 },
    { label: '  500+  ', lo: 501, hi: Infinity },
  ]
  const counts = buckets.map(b => ({
    label: b.label,
    count: lineCounts.filter(lc => lc >= b.lo && lc <= b.hi).length,
  }))
  const maxCount = Math.max(...counts.map(c => c.count), 1)
  return counts
    .filter(c => c.count > 0)
    .map(c => {
      const bar = '█'.repeat(Math.round(c.count / maxCount * barWidth))
      const pct = (c.count / lineCounts.length * 100).toFixed(0)
      return `${c.label} ${bar} ${c.count} (${pct}%)`
    })
}

const ESTIMATE_LEVELS = [0, 10, 30, 60, 100, 999]

/** Analyze all modules for a repo — no LLM calls, just reads source and builds stats. */
export async function analyzeModuleStats(
  dbSession: Session,
  repo: string,
  repoPath: string,
  onProgress?: (msg: string) => void,
): Promise<RepoModuleStats> {
  const log = onProgress ?? (() => {})

  const modules = await getModulesWithFunctions(dbSession, repo)
  log(`Found ${modules.length} modules`)

  const allLineCounts: number[] = []
  const moduleStats: ModuleStats[] = []

  for (const mod of modules) {
    log(`  Reading ${mod.moduleName} (${mod.functions.length} fns)...`)
    const { lineCounts, maxFnName, functionsWithSource } = collectFunctionLineCounts(mod, repoPath)
    allLineCounts.push(...lineCounts)

    const total = lineCounts.reduce((s, l) => s + l, 0)
    const mean = lineCounts.length > 0 ? total / lineCounts.length : 0
    const maxLc = lineCounts.length > 0 ? Math.max(...lineCounts) : 0

    const tokenEstimates = ESTIMATE_LEVELS.map(ml => {
      const tokens = estimateModuleTokens(mod, lineCounts, ml)
      return { maxLines: ml, tokens, pctOf200K: +(tokens / 200_000 * 100).toFixed(1) }
    })

    moduleStats.push({
      moduleId: mod.moduleId,
      moduleName: mod.moduleName,
      functionCount: mod.functions.length,
      functionsWithSource,
      lineCounts,
      totalLines: total,
      meanLines: +mean.toFixed(1),
      medianLines: median(lineCounts),
      p90Lines: percentile(lineCounts, 90),
      maxLines: maxLc,
      maxFunctionName: maxFnName,
      tokenEstimates,
    })
  }

  return {
    repo,
    modules: moduleStats.sort((a, b) => b.functionCount - a.functionCount),
    totalFunctions: allLineCounts.length,
    totalLines: allLineCounts.reduce((s, l) => s + l, 0),
    globalLineCounts: allLineCounts,
  }
}

/** Format stats into printable report. */
export function formatStatsReport(stats: RepoModuleStats): string {
  const lines: string[] = []

  lines.push(`\n━━━ Module Stats: ${stats.repo} ━━━\n`)
  lines.push(`  Total: ${stats.modules.length} modules, ${stats.totalFunctions} functions, ${stats.totalLines.toLocaleString()} lines\n`)

  // Global histogram
  lines.push(`  Global line distribution:`)
  for (const h of buildHistogram(stats.globalLineCounts)) lines.push(`    ${h}`)
  lines.push('')

  // Per-module details
  for (const mod of stats.modules) {
    lines.push(`  ┌─ ${mod.moduleName} (${mod.functionCount} fns, ${mod.functionsWithSource} with source)`)
    lines.push(`  │  Lines: mean=${mod.meanLines} median=${mod.medianLines} p90=${mod.p90Lines} max=${mod.maxLines}`)
    if (mod.maxFunctionName) {
      lines.push(`  │  Largest: ${mod.maxFunctionName} (${mod.maxLines} lines)`)
    }

    // Mini histogram
    lines.push(`  │  Distribution:`)
    for (const h of buildHistogram(mod.lineCounts, 25)) {
      lines.push(`  │    ${h}`)
    }

    // Token estimates table
    lines.push(`  │  Token estimates:`)
    lines.push(`  │    max-lines │ tokens     │ % of 200K`)
    lines.push(`  │    ──────────┼────────────┼──────────`)
    for (const est of mod.tokenEstimates) {
      const mlLabel = est.maxLines === 0 ? 'off' : est.maxLines === 999 ? 'full' : String(est.maxLines)
      const warn = est.pctOf200K > 90 ? ' ⚠️' : est.pctOf200K > 70 ? ' ⚡' : ''
      lines.push(`  │    ${mlLabel.padStart(9)} │ ${est.tokens.toLocaleString().padStart(10)} │ ${String(est.pctOf200K + '%').padStart(7)}${warn}`)
    }
    lines.push(`  └─`)
    lines.push('')
  }

  return lines.join('\n')
}

// ── Orphan Backfill ─────────────────────────────────────

export interface BackfillResult {
  fileLevelAdded: number     // orphans backfilled via same-file majority
  dirModulesCreated: number  // kept for backward compat (always 0 now)
  dirFunctionsAdded: number  // orphans assigned via directory affinity
  stillOrphan: number        // could not resolve
  filesProcessed: number
}

/**
 * Additive backfill: ensure every function has at least one BELONGS_TO edge.
 *
 * Strategy (no edges removed, only added):
 *   1. For each file with orphan functions:
 *      - Find dominant module(s) from sibling functions in the same file
 *      - Add BELONGS_TO edges for orphans → dominant module(s)
 *   2. For fully-orphan files (no function has a module):
 *      - Group by directory → create a new SemanticModule per directory
 *      - Add BELONGS_TO edges for all functions → their directory module
 */
export async function backfillOrphanFunctions(
  session: Session,
  repo: string,
  dryRun: boolean = false,
  onProgress: (msg: string) => void = () => {},
): Promise<BackfillResult> {
  const result: BackfillResult = { fileLevelAdded: 0, dirModulesCreated: 0, dirFunctionsAdded: 0, stillOrphan: 0, filesProcessed: 0 }

  // ── Step 1: Get all files with their function → module mapping ──
  const allRes = await session.run(
    `MATCH (file:CodeEntity {entity_type: 'file', repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
     OPTIONAL MATCH (fn)-[:BELONGS_TO]->(sm:SemanticModule)
     RETURN file.path AS filePath, fn.name AS fnName, sm.id AS moduleId, sm.name AS moduleName`,
    { repo }
  )

  // Build per-file data
  interface FnInfo { name: string; moduleIds: string[] }
  const fileMap = new Map<string, FnInfo[]>()
  for (const rec of allRes.records) {
    const fp = rec.get('filePath') as string
    const fnName = rec.get('fnName') as string
    const modId = rec.get('moduleId') as string | null

    if (!fileMap.has(fp)) fileMap.set(fp, [])
    const fns = fileMap.get(fp)!
    let fn = fns.find(f => f.name === fnName)
    if (!fn) { fn = { name: fnName, moduleIds: [] }; fns.push(fn) }
    if (modId && !fn.moduleIds.includes(modId)) fn.moduleIds.push(modId)
  }

  // ── Step 2: File-level backfill ──
  const fullyOrphanFiles: string[] = []

  for (const [filePath, fns] of Array.from(fileMap.entries())) {
    const orphans = fns.filter(f => f.moduleIds.length === 0)
    if (orphans.length === 0) continue

    const assigned = fns.filter(f => f.moduleIds.length > 0)
    if (assigned.length === 0) {
      fullyOrphanFiles.push(filePath)
      continue
    }

    // Find dominant module(s): count how many functions belong to each
    const moduleCounts = new Map<string, number>()
    for (const fn of assigned) {
      for (const mid of fn.moduleIds) {
        moduleCounts.set(mid, (moduleCounts.get(mid) || 0) + 1)
      }
    }

    // Pick module(s) with highest count
    const maxCount = Math.max(...Array.from(moduleCounts.values()))
    const dominantModules = Array.from(moduleCounts.entries())
      .filter(([, c]) => c === maxCount)
      .map(([id]) => id)

    // Add edges
    if (!dryRun) {
      for (const modId of dominantModules) {
        const orphanNames = orphans.map(f => f.name)
        await session.run(
          `UNWIND $names AS fnName
           MATCH (fn:CodeEntity {entity_type: 'function', name: fnName, repo: $repo})
           MATCH (file:CodeEntity {entity_type: 'file', path: $filePath, repo: $repo})-[:CONTAINS]->(fn)
           MATCH (sm:SemanticModule {id: $modId})
           WHERE NOT (fn)-[:BELONGS_TO]->(sm)
           CREATE (fn)-[:BELONGS_TO]->(sm)`,
          { names: orphanNames, repo, filePath, modId }
        )
      }
    }

    result.fileLevelAdded += orphans.length
    result.filesProcessed++
  }

  onProgress(`  File-level: ${result.fileLevelAdded} orphans backfilled from ${result.filesProcessed} files`)

  // ── Step 3: Assign fully-orphan files to existing modules by directory affinity ──
  // Instead of creating new dir_* modules, find the most relevant existing module
  // by looking at what modules dominate the same or parent directory.
  if (fullyOrphanFiles.length > 0) {
    // Build directory → dominant module mapping from ALL assigned functions
    const dirModuleCounts = new Map<string, Map<string, number>>()
    for (const [fp, fns] of Array.from(fileMap.entries())) {
      for (const fn of fns) {
        if (fn.moduleIds.length === 0) continue
        // Register at multiple directory levels for broader matching
        const parts = fp.split('/')
        for (let depth = 1; depth <= Math.min(3, parts.length - 1); depth++) {
          const dir = parts.slice(0, depth).join('/')
          if (!dirModuleCounts.has(dir)) dirModuleCounts.set(dir, new Map())
          const counts = dirModuleCounts.get(dir)!
          for (const mid of fn.moduleIds) {
            counts.set(mid, (counts.get(mid) || 0) + 1)
          }
        }
      }
    }

    // For each fully-orphan file, find the best module by directory affinity
    let dirAssigned = 0
    let dirUnmatched = 0
    for (const filePath of fullyOrphanFiles) {
      const fns = fileMap.get(filePath) || []
      if (fns.length === 0) continue

      // Try matching at decreasing directory depth
      const parts = filePath.split('/')
      let bestModuleId: string | null = null
      for (let depth = Math.min(3, parts.length - 1); depth >= 1; depth--) {
        const dir = parts.slice(0, depth).join('/')
        const counts = dirModuleCounts.get(dir)
        if (counts && counts.size > 0) {
          // Pick the module with the most functions in this directory
          let maxCount = 0
          for (const [mid, cnt] of Array.from(counts.entries())) {
            if (cnt > maxCount) { maxCount = cnt; bestModuleId = mid }
          }
          break
        }
      }

      if (!bestModuleId) {
        dirUnmatched += fns.length
        continue
      }

      if (!dryRun) {
        const orphanNames = fns.map(f => f.name)
        const BATCH = 100
        for (let i = 0; i < orphanNames.length; i += BATCH) {
          const batch = orphanNames.slice(i, i + BATCH)
          await session.run(
            `UNWIND $names AS fnName
             MATCH (fn:CodeEntity {entity_type: 'function', name: fnName, repo: $repo})
             MATCH (file:CodeEntity {entity_type: 'file', path: $filePath, repo: $repo})-[:CONTAINS]->(fn)
             MATCH (sm:SemanticModule {id: $modId})
             WHERE NOT (fn)-[:BELONGS_TO]->(sm)
             CREATE (fn)-[:BELONGS_TO]->(sm)`,
            { names: batch, repo, filePath, modId: bestModuleId }
          )
        }
      }
      dirAssigned += fns.length
    }

    result.dirFunctionsAdded = dirAssigned
    onProgress(`  Dir-affinity: ${dirAssigned} orphans assigned to existing modules, ${dirUnmatched} unmatched`)
  }

  onProgress(`  Total: +${result.fileLevelAdded} file-level, +${result.dirFunctionsAdded} in ${result.dirModulesCreated} dir-modules, ${result.stillOrphan} still orphan`)
  return result
}

interface Layer2ModuleResult {
  subModules: { subId: string; name: string; description: string; confidence: number; functionNames: string[] }[]
  misassigned: MisassignedFunction[]
  tokens: number
  moduleName: string
  moduleId: string
  functions: ModuleFunction[]
}

async function runLayer2(
  session: Session,
  ai: AIProvider,
  repo: string,
  modules: ModuleData[],
  concurrency: number,
  dryRun: boolean,
  shouldAbort: () => boolean,
  onProgress: (msg: string) => void,
): Promise<{
  subModulesCreated: number
  misassigned: MisassignedFunction[]
  tokens: number
}> {
  // Clear existing sub-modules for the modules being processed (not all)
  if (!dryRun) {
    const moduleIds = modules.map(m => m.moduleId)
    await session.run(
      `MATCH (sub:SubModule {repo: $repo}) WHERE sub.parentModuleId IN $moduleIds DETACH DELETE sub`,
      { repo, moduleIds }
    )
  }

  onProgress(`Layer 2: Decomposing ${modules.length} modules (concurrency=${concurrency})`)
  let completed = 0
  let totalSubModules = 0
  let totalTokens = 0
  const allMisassigned: MisassignedFunction[] = []
  const now = new Date().toISOString()

  // Each worker: LLM call → parse → write to graph immediately
  await runWithConcurrency(modules, concurrency, async (mod) => {
    if (shouldAbort()) return

    const idx = ++completed
    onProgress(`  [${idx}/${modules.length}] Decomposing ${mod.moduleName} (${mod.functions.length} fns)`)

    const input: SubModuleInput = {
      moduleName: mod.moduleName,
      moduleId: mod.moduleId,
      moduleDescription: mod.moduleDescription,
      functions: mod.functions,
      internalCallEdges: mod.callEdges,
    }

    let subModules: { subId: string; name: string; description: string; confidence: number; functionNames: string[] }[] = []
    let misassigned: MisassignedFunction[] = []
    let tokens = 0

    try {
      const raw = await ai.call(buildSubModulePrompt(input), { timeoutMs: 600000 })
      tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
      totalTokens += tokens
      const parsed = parseJsonSafe<SubModuleOutput>(raw, { subModules: [], misassigned: [] })

      misassigned = (parsed.misassigned ?? []).map(m => {
        const fn = mod.functions.find(f => f.name === m.functionName)
        return {
          functionKey: fn ? `${fn.filePath}::${m.functionName}` : m.functionName,
          sourceModuleId: mod.moduleId,
          sourceModuleName: mod.moduleName,
          reason: m.reason,
          suggestedModule: m.suggestedModule,
        }
      })
      allMisassigned.push(...misassigned)

      subModules = parsed.subModules.map(sub => ({
        subId: `${mod.moduleId}_${sub.subModuleId}`,
        name: sub.name,
        description: sub.description,
        confidence: sub.confidence ?? 0.8,
        functionNames: sub.functionNames,
      }))

      onProgress(`  ✓ ${mod.moduleName}: ${subModules.length} sub-modules, ${misassigned.length} misassigned (${tokens.toLocaleString()} tokens)`)
    } catch (err: any) {
      onProgress(`  ⚠ ${mod.moduleName} failed: ${err.message}`)
      return
    }

    // Write immediately (no waiting for other modules)
    if (dryRun || subModules.length === 0) {
      totalSubModules += subModules.length
      return
    }

    for (const sub of subModules) {
      await session.run(
        `CREATE (sub:SubModule {
          id: $id, name: $name, description: $description,
          repo: $repo, parentModuleId: $parentModuleId,
          confidence: $confidence, function_count: $fnCount,
          created_at: $now, source: 'design_analysis'
        })`,
        { id: sub.subId, name: sub.name, description: sub.description, repo, parentModuleId: mod.moduleId,
          confidence: sub.confidence, fnCount: sub.functionNames.length, now },
      )
      await session.run(
        `MATCH (sub:SubModule {id: $subId}) MATCH (sm:SemanticModule {id: $parentId}) MERGE (sub)-[:CHILD_OF]->(sm)`,
        { subId: sub.subId, parentId: mod.moduleId },
      )

      const matchedFns = sub.functionNames
        .map(name => mod.functions.find(f => f.name === name))
        .filter((f): f is ModuleFunction => f != null)
      const BATCH = 50
      for (let j = 0; j < matchedFns.length; j += BATCH) {
        const pairs = matchedFns.slice(j, j + BATCH).map(f => ({ fnName: f.name, filePath: f.filePath }))
        await session.run(
          `UNWIND $pairs AS p
           MATCH (fn:CodeEntity {entity_type: 'function', name: p.fnName, repo: $repo})
           MATCH (f:CodeEntity {entity_type: 'file', path: p.filePath})-[:CONTAINS]->(fn)
           MATCH (sub:SubModule {id: $subId})
           MERGE (fn)-[:BELONGS_TO]->(sub)`,
          { pairs, repo, subId: sub.subId },
        )
      }
      totalSubModules++
    }

    // Per-module "Other" for functions LLM didn't assign
    const orphanRes = await session.run(
      `MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm:SemanticModule {id: $moduleId})
       OPTIONAL MATCH (fn)-[:BELONGS_TO]->(existingSub:SubModule)
       WITH fn, existingSub WHERE existingSub IS NULL
       RETURN count(fn) AS cnt`,
      { moduleId: mod.moduleId },
    )
    const orphanCount = toNum(orphanRes.records[0]?.get('cnt'))
    if (orphanCount > 0) {
      const catchAllId = `${mod.moduleId}_other`
      await session.run(
        `MERGE (sub:SubModule {id: $id})
         ON CREATE SET sub.name = 'Other / Unclassified', sub.description = 'Functions not assigned to a specific sub-module',
           sub.repo = $repo, sub.parentModuleId = $moduleId, sub.confidence = 0.5, sub.function_count = $cnt,
           sub.created_at = $now, sub.source = 'design_analysis_backfill'
         ON MATCH SET sub.function_count = $cnt`,
        { id: catchAllId, repo, moduleId: mod.moduleId, cnt: orphanCount, now },
      )
      await session.run(
        `MATCH (sub:SubModule {id: $catchAllId}) MATCH (sm:SemanticModule {id: $moduleId}) MERGE (sub)-[:CHILD_OF]->(sm)`,
        { catchAllId, moduleId: mod.moduleId },
      )
      await session.run(
        `MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm:SemanticModule {id: $moduleId})
         OPTIONAL MATCH (fn)-[:BELONGS_TO]->(existingSub:SubModule)
         WITH fn, existingSub WHERE existingSub IS NULL
         MATCH (sub:SubModule {id: $catchAllId}) MERGE (fn)-[:BELONGS_TO]->(sub)`,
        { moduleId: mod.moduleId, catchAllId },
      )
      onProgress(`  + ${mod.moduleName}: ${orphanCount} orphan functions → "Other" sub-module`)
    }
  })

  onProgress(`Layer 2 done: ${totalSubModules} sub-modules, ${allMisassigned.length} misassigned`)
  return { subModulesCreated: totalSubModules, misassigned: allMisassigned, tokens: totalTokens }
}

// ── Layer 2.5: Misassigned → SubModule Reassignment ──────

async function runLayer2_5(
  session: Session,
  ai: AIProvider,
  repo: string,
  misassigned: MisassignedFunction[],
  concurrency: number,
  dryRun: boolean,
  onProgress: (msg: string) => void,
): Promise<{ reassigned: number; infrastructure: number; tokens: number }> {
  if (misassigned.length === 0) {
    onProgress('Layer 2.5: No misassigned functions, skipping')
    return { reassigned: 0, infrastructure: 0, tokens: 0 }
  }

  // Get all SubModules across the entire repo (created by Layer 2)
  const subRes = await session.run(
    `MATCH (sub:SubModule {repo: $repo})-[:CHILD_OF]->(sm:SemanticModule)
     RETURN sub.id AS subId, sub.name AS name, sub.description AS description, sm.name AS parentName
     ORDER BY sm.name, sub.name`,
    { repo },
  )
  const allSubModules: SubModuleTarget[] = subRes.records.map(r => ({
    subModuleId: r.get('subId') as string,
    name: r.get('name') as string,
    description: (r.get('description') as string) || '',
    parentModuleName: r.get('parentName') as string,
  }))

  onProgress(`Layer 2.5: ${allSubModules.length} sub-modules available as targets`)

  // Batch misassigned into chunks of 80
  const BATCH_SIZE = 80
  const batches: MisassignedFunction[][] = []
  for (let i = 0; i < misassigned.length; i += BATCH_SIZE) {
    batches.push(misassigned.slice(i, i + BATCH_SIZE))
  }

  onProgress(`Layer 2.5: Reassigning ${misassigned.length} misassigned functions to sub-modules in ${batches.length} batches`)

  let completed = 0
  const batchResults = await runWithConcurrency(batches, concurrency, async (batch): Promise<SubModuleReassignmentOutput & { tokens: number }> => {
    const idx = ++completed
    onProgress(`  [${idx}/${batches.length}] Reassigning batch of ${batch.length}`)

    try {
      const raw = await ai.call(buildMisassignedReassignmentPrompt(batch, allSubModules), { timeoutMs: 600000 })
      const tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
      const parsed = parseJsonSafe<SubModuleReassignmentOutput>(raw, { reassignments: [], infrastructure: [] })
      return { ...parsed, tokens }
    } catch (err: any) {
      onProgress(`  ⚠ Batch failed: ${err.message}`)
      return { reassignments: [], infrastructure: [], tokens: 0 }
    }
  })

  // Build SubModule → parent module lookup
  const subToParent = new Map<string, string>()
  for (const sub of allSubModules) {
    // Extract parentModuleId from subModuleId (format: "mod_X_submod_Y")
    const subIdParts = sub.subModuleId.split('_submod_')
    if (subIdParts.length >= 2) subToParent.set(sub.subModuleId, subIdParts[0])
  }

  // Aggregate and apply
  let totalReassigned = 0
  let totalInfra = 0
  let totalTokens = 0

  for (const br of batchResults) {
    totalTokens += br.tokens

    if (dryRun) {
      totalReassigned += br.reassignments.length
      totalInfra += br.infrastructure.length
      continue
    }

    for (const r of br.reassignments) {
      const sep = r.functionKey.lastIndexOf('::')
      if (sep === -1) continue
      const filePath = r.functionKey.slice(0, sep)
      const fnName = r.functionKey.slice(sep + 2)

      // Remove old BELONGS_TO → SemanticModule edges
      await session.run(
        `MATCH (fn:CodeEntity {entity_type: 'function', name: $fnName, repo: $repo})
         MATCH (f:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(fn)
         MATCH (fn)-[rel:BELONGS_TO]->(sm:SemanticModule)
         DELETE rel`,
        { fnName, filePath, repo },
      )

      // Add BELONGS_TO → target SubModule
      await session.run(
        `MATCH (fn:CodeEntity {entity_type: 'function', name: $fnName, repo: $repo})
         MATCH (f:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(fn)
         MATCH (sub:SubModule {id: $targetSubId})
         MERGE (fn)-[:BELONGS_TO]->(sub)`,
        { fnName, filePath, repo, targetSubId: r.targetSubModuleId },
      )

      // Also add BELONGS_TO → parent SemanticModule
      const parentModuleId = subToParent.get(r.targetSubModuleId)
      if (parentModuleId) {
        await session.run(
          `MATCH (fn:CodeEntity {entity_type: 'function', name: $fnName, repo: $repo})
           MATCH (f:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(fn)
           MATCH (sm:SemanticModule {id: $moduleId})
           MERGE (fn)-[:BELONGS_TO]->(sm)`,
          { fnName, filePath, repo, moduleId: parentModuleId },
        )
      }

      totalReassigned++
    }

    for (const inf of br.infrastructure) {
      const sep = inf.functionKey.lastIndexOf('::')
      if (sep === -1) continue
      const filePath = inf.functionKey.slice(0, sep)
      const fnName = inf.functionKey.slice(sep + 2)

      // Infrastructure: remove all module/submodule edges
      await session.run(
        `MATCH (fn:CodeEntity {entity_type: 'function', name: $fnName, repo: $repo})
         MATCH (f:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(fn)
         MATCH (fn)-[rel:BELONGS_TO]->(target)
         WHERE target:SemanticModule OR target:SubModule
         DELETE rel`,
        { fnName, filePath, repo },
      )

      totalInfra++
    }
  }

  onProgress(`Layer 2.5 done: ${totalReassigned} reassigned to sub-modules, ${totalInfra} infrastructure`)
  return { reassigned: totalReassigned, infrastructure: totalInfra, tokens: totalTokens }
}

// ── Main Pipeline ───────────────────────────────────────

// NOTE: Layer 3 (Decision Attribution), Layer 4 (Theme/Choice),
// Layer 5 (Cross-Module Merge) have been moved to sub-module analysis pipeline.


export async function runDesignAnalysis(opts: DesignAnalysisOpts): Promise<DesignAnalysisResult> {
  const {
    dbSession, ai, repo, repoPath,
    concurrency = 5,
    maxLinesPerFunction = 0,
    moduleIds,
    dryRun = false,
    shouldAbort = () => false,
    onProgress = () => {},
  } = opts
  const startTime = Date.now()

  // Prerequisite check
  const modCheck = await dbSession.run(
    `MATCH (sm:SemanticModule {repo: $repo}) RETURN count(sm) AS cnt`,
    { repo }
  )
  const moduleCount = toNum(modCheck.records[0]?.get('cnt'))
  if (moduleCount === 0) {
    throw new Error(`No SemanticModule nodes found for repo "${repo}". Run module discovery first.`)
  }
  onProgress(`Found ${moduleCount} modules for repo "${repo}"`)

  // Get module data
  let modules = await getModulesWithFunctions(dbSession, repo)

  // Filter to specific modules if requested
  if (moduleIds) {
    modules = modules.filter(m => moduleIds.includes(m.moduleId))
    onProgress(`Filtered to ${modules.length} module(s): ${modules.map(m => m.moduleName).join(', ')}`)
  }

  // Load source code if requested
  if (maxLinesPerFunction > 0) {
    onProgress(`Loading source code (max ${maxLinesPerFunction} lines/fn)...`)
    loadModuleSourceCode(modules, repoPath, maxLinesPerFunction)
    const totalWithSource = modules.reduce((s, m) => s + m.functions.filter(f => f.sourceCode).length, 0)
    const totalFns = modules.reduce((s, m) => s + m.functions.length, 0)
    onProgress(`  ${totalWithSource}/${totalFns} functions loaded with source`)
  }

  // Layer 2: Sub-Module Decomposition
  const layer2 = await runLayer2(dbSession, ai, repo, modules, concurrency, dryRun, shouldAbort, onProgress)

  // Save misassigned to file for later reassignment via --reassign
  if (layer2.misassigned.length > 0) {
    const misassignedPath = path.join('data', `${repo}-misassigned.json`)
    fs.mkdirSync('data', { recursive: true })
    fs.writeFileSync(misassignedPath, JSON.stringify(layer2.misassigned, null, 2))
    onProgress(`Saved ${layer2.misassigned.length} misassigned functions to ${misassignedPath}`)
    onProgress(`Run with --reassign to assign them to sub-modules`)
  }

  return {
    layer2: { subModulesCreated: layer2.subModulesCreated, misassignedCount: layer2.misassigned.length, tokens: layer2.tokens },
    layer2_5: { reassigned: 0, infrastructure: 0, tokens: 0 },
    totalTokens: layer2.tokens,
    durationMs: Date.now() - startTime,
  }
}

// ── Reassign misassigned functions (standalone, run after all modules done) ──

export async function runReassignment(opts: {
  dbSession: Session
  ai: AIProvider
  repo: string
  concurrency?: number
  dryRun?: boolean
  onProgress?: (msg: string) => void
}): Promise<{ reassigned: number; infrastructure: number; tokens: number; durationMs: number }> {
  const {
    dbSession, ai, repo,
    concurrency = 5,
    dryRun = false,
    onProgress = () => {},
  } = opts
  const startTime = Date.now()

  // Load misassigned from file
  const misassignedPath = path.join('data', `${repo}-misassigned.json`)
  if (!fs.existsSync(misassignedPath)) {
    throw new Error(`No misassigned file found at ${misassignedPath}. Run design-analysis first.`)
  }
  const misassigned: MisassignedFunction[] = JSON.parse(fs.readFileSync(misassignedPath, 'utf-8'))
  onProgress(`Loaded ${misassigned.length} misassigned functions from ${misassignedPath}`)

  const result = await runLayer2_5(dbSession, ai, repo, misassigned, concurrency, dryRun, onProgress)

  // Clean up file after successful reassignment
  if (!dryRun && result.reassigned > 0) {
    fs.unlinkSync(misassignedPath)
    onProgress(`Removed ${misassignedPath}`)
  }

  return { ...result, durationMs: Date.now() - startTime }
}
