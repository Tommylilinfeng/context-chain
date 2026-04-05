/**
 * ingestion/module-discovery.ts
 *
 * Export-based Architecture Discovery pipeline.
 * No graph algorithms (Louvain), no CALLS edges — just exports + LLM + imports.
 *
 * ═══════════════════════════════════════════════════════════
 * Pipeline
 * ═══════════════════════════════════════════════════════════
 *
 *   Phase 1 — Chunk Analysis (parallel LLM):
 *     1. Scan repo for TS/TSX/JS files, extract export names
 *     2. Group by 2-level directory, split into N chunks
 *     3. N concurrent LLM calls: each chunk → subsystem candidates
 *
 *   Phase 2 — Merge (single LLM):
 *     4. Deduplicate + unify into final architecture (12-20 modules)
 *
 *   Phase 3 — IQR Outlier Split (parallel LLM):
 *     5. Compute module sizes (by export count)
 *     6. IQR outlier detection (Q3 + 1.5 × IQR)
 *     7. Oversized modules get split by LLM — EXCEPT foundation/infra
 *        layers which are kept as-is (cross-cutting by nature)
 *
 *   Phase 4 — Write + Import Backfill (no LLM):
 *     8. Write SemanticModule nodes, assign functions by directory
 *     9. Orphan files (in flat dirs like utils/) assigned by import analysis:
 *        - File imported by exactly 1 external module → assign to that module
 *        - File imported by 0 or 2+ modules → Foundation (cross-cutting)
 *     10. File-level and directory-level backfill for remaining orphans
 *
 * ═══════════════════════════════════════════════════════════
 * Key design decisions
 * ═══════════════════════════════════════════════════════════
 *
 *   Why exports, not CALLS edges:
 *     Export names are the richest zero-cost signal. A file's public API
 *     reveals its architectural role without reading function bodies.
 *     CALLS edges miss closures, dynamic dispatch, React components.
 *     Exports have 100% coverage — every file has a path + exports.
 *
 *   Why IQR for outlier detection:
 *     Tukey's IQR method (1977) is project-agnostic — adapts to any
 *     distribution without hardcoded thresholds. No magic numbers.
 *
 *   Why foundation modules are kept large:
 *     Per DDD "Shared Kernel" and NX's "type:util" pattern, cross-cutting
 *     infrastructure (logging, errors, formatting) should stay in a
 *     dedicated layer that everything depends on, not be forcibly split.
 *     The gravity test: if a file is imported by 2+ modules, it belongs
 *     in the shared layer, not in any specific module.
 *
 *   Why import-based assignment for flat directories:
 *     Flat dirs like utils/ have 298 files at the same level — no sub-directory
 *     structure for LLM to split by. Import analysis resolves this without
 *     LLM: check who actually uses each file. Pure data, no guessing.
 *
 * ═══════════════════════════════════════════════════════════
 * Benchmark (claudecode, 1,902 files, 7,867 exports)
 * ═══════════════════════════════════════════════════════════
 *
 *   - Phase 1-3: ~25K tokens, ~7 LLM calls
 *   - Phase 4: zero LLM, pure import scan + graph writes
 *   - Total: ~213s wall time, 100% function coverage
 *   - 22 effective modules (after removing empty shells)
 *   - Foundation module: ~2,600 functions (250 cross-cutting utils files)
 *   - 82 utils files assigned to specific modules by import analysis
 *
 *   Stability (5× identical runs on Phase 1-2 alone):
 *   - Core subsystems always identified (tools, permissions, ink, mcp, bridge)
 *   - Module count: 19-22 across runs
 *   - Boundary directories vary — expected ambiguity
 */

import * as fs from 'fs'
import * as path from 'path'
import { Session } from 'neo4j-driver'
import { AIProvider } from '../ai/types'
import {
  DirGroup,
  DiscoveredModule,
  DiscoveryResult,
  buildChunkPrompt,
  buildMergePrompt,
  buildSplitPrompt,
} from '../prompts/module-discovery'
import { parseJsonSafe, toNum, runWithConcurrency } from './shared'

// ── File Scanning ────────────────────────────────────────

function walkFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', '__tests__', 'test', 'tests', '.next'].includes(entry.name)) continue
      walkFiles(full, files)
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(full)
    }
  }
  return files
}

function extractExportNames(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const names: string[] = []
  const regex = /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|abstract\s+class|interface|type|enum)\s+(\w+)/g
  let m
  while ((m = regex.exec(content)) !== null) names.push(m[1])
  return [...new Set(names)]
}

// ── Directory Grouping ───────────────────────────────────

export function buildDirGroups(repoPath: string): { groups: DirGroup[]; totalFiles: number } {
  const files = walkFiles(repoPath)
  const grouped = new Map<string, { name: string; exports: string[] }[]>()

  for (const f of files) {
    const rel = path.relative(repoPath, f)
    const parts = rel.split('/')
    const dir = parts.length >= 3
      ? parts[0] + '/' + parts[1]
      : parts.length >= 2 ? parts[0] : '.'
    const fileName = parts[parts.length - 1]

    try {
      const exports = extractExportNames(f)
      if (exports.length === 0) continue
      if (!grouped.has(dir)) grouped.set(dir, [])
      grouped.get(dir)!.push({ name: fileName, exports })
    } catch {}
  }

  const groups = [...grouped.entries()]
    .map(([dir, fileList]) => ({ dir, files: fileList }))
    .sort((a, b) => a.dir.localeCompare(b.dir))

  return { groups, totalFiles: files.length }
}

// ── Chunk Splitting ──────────────────────────────────────

function splitIntoChunks(groups: DirGroup[], n: number): DirGroup[][] {
  const totalExports = groups.reduce((s, g) =>
    s + g.files.reduce((s2, f) => s2 + f.exports.length, 0), 0)
  const targetPerChunk = Math.ceil(totalExports / n)

  const chunks: DirGroup[][] = []
  let current: DirGroup[] = []
  let currentSize = 0

  for (const g of groups) {
    const gSize = g.files.reduce((s, f) => s + f.exports.length, 0)
    current.push(g)
    currentSize += gSize
    if (currentSize >= targetPerChunk && chunks.length < n - 1) {
      chunks.push(current)
      current = []
      currentSize = 0
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

// ── LLM Phases ───────────────────────────────────────────

async function runPhase1(
  ai: AIProvider,
  chunks: DirGroup[][],
  allDirSummary: string,
  repoName: string,
  concurrency: number,
  onProgress?: (msg: string) => void,
): Promise<{ chunkResults: string[]; tokens: number }> {
  onProgress?.(`Phase 1: Analyzing ${chunks.length} chunks (concurrency=${concurrency})...`)
  let totalTokens = 0

  const chunkResults = await runWithConcurrency(
    chunks.map((chunk, i) => ({ chunk, i })),
    concurrency,
    async ({ chunk, i }) => {
      const prompt = buildChunkPrompt(chunk, i, chunks.length, allDirSummary, repoName)
      const raw = await ai.call(prompt, { timeoutMs: 300000 })
      const tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
      totalTokens += tokens
      const dirs = chunk.length
      const exports = chunk.reduce((s, g) => s + g.files.reduce((s2, f) => s2 + f.exports.length, 0), 0)
      onProgress?.(`  ✓ Chunk ${i + 1}/${chunks.length}: ${dirs} dirs, ${exports} exports (${tokens.toLocaleString()} tokens)`)
      return raw
    },
  )

  onProgress?.(`Phase 1 done: ${totalTokens.toLocaleString()} tokens`)
  return { chunkResults, tokens: totalTokens }
}

async function runPhase2(
  ai: AIProvider,
  chunkResults: string[],
  repoName: string,
  onProgress?: (msg: string) => void,
): Promise<{ modules: DiscoveredModule[]; tokens: number }> {
  onProgress?.('Phase 2: Merging subsystems...')

  const prompt = buildMergePrompt(chunkResults, repoName)
  const raw = await ai.call(prompt, { timeoutMs: 300000 })
  const tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)

  const parsed = parseJsonSafe<{ subsystems: any[] }>(raw, { subsystems: [] })
  let subsystems = parsed.subsystems
  if (!subsystems && Array.isArray(parsed)) subsystems = parsed as any
  if (!Array.isArray(subsystems)) subsystems = []

  const modules: DiscoveredModule[] = subsystems.map((s: any, i: number) => ({
    moduleId: s.moduleId || `mod_${i + 1}`,
    name: s.name || 'Unknown',
    description: s.description || '',
    directories: Array.isArray(s.directories) ? s.directories.map((d: string) => d.replace(/\/$/, '')) : [],
    keyExports: Array.isArray(s.keyExports) ? s.keyExports : [],
    confidence: 0.8,
  }))

  onProgress?.(`Phase 2 done: ${modules.length} subsystems (${tokens.toLocaleString()} tokens)`)
  return { modules, tokens }
}

// ── Write to Graph ───────────────────────────────────────

export async function writeModulesToGraph(
  session: Session,
  modules: DiscoveredModule[],
  repo: string,
  onProgress?: (msg: string) => void,
): Promise<{ modulesWritten: number; edgesWritten: number }> {
  const now = new Date().toISOString()

  // Clear existing modules
  await session.run(
    `MATCH (sm:SemanticModule {repo: $repo}) DETACH DELETE sm`,
    { repo },
  )

  let modulesWritten = 0
  let edgesWritten = 0

  for (const mod of modules) {
    // Create module node
    await session.run(
      `CREATE (sm:SemanticModule {
        id: $id, name: $name, description: $description,
        repo: $repo, confidence: $confidence,
        function_count: 0, created_at: $now,
        source: 'export_discovery'
      })`,
      {
        id: mod.moduleId, name: mod.name, description: mod.description,
        repo, confidence: mod.confidence, now,
      },
    )
    modulesWritten++

    // File-level assignment (from split of flat directories like utils/)
    if (mod.files && mod.files.length > 0 && mod.parentDir) {
      const BATCH = 50
      for (let i = 0; i < mod.files.length; i += BATCH) {
        const batch = mod.files.slice(i, i + BATCH)
        const paths = batch.map(f => `${mod.parentDir}/${f}`)
        const result = await session.run(
          `UNWIND $paths AS filePath
           MATCH (f:CodeEntity {entity_type: 'file', repo: $repo, path: filePath})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
           MATCH (sm:SemanticModule {id: $moduleId})
           MERGE (fn)-[:BELONGS_TO]->(sm)
           RETURN count(*) AS cnt`,
          { paths, repo, moduleId: mod.moduleId },
        )
        edgesWritten += toNum(result.records[0]?.get('cnt'))
      }
    } else {
      // Directory-level assignment
      for (const dir of mod.directories) {
        const dirPrefix = dir.endsWith('/') ? dir : dir + '/'
        const result = await session.run(
          `MATCH (f:CodeEntity {entity_type: 'file', repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
           WHERE f.path STARTS WITH $dirPrefix OR f.path = $dirExact
           MATCH (sm:SemanticModule {id: $moduleId})
           MERGE (fn)-[:BELONGS_TO]->(sm)
           RETURN count(*) AS cnt`,
          { repo, dirPrefix, dirExact: dir, moduleId: mod.moduleId },
        )
        edgesWritten += toNum(result.records[0]?.get('cnt'))
      }

      // Also handle root-level files (dir = ".")
      if (mod.directories.includes('.')) {
        const result = await session.run(
          `MATCH (f:CodeEntity {entity_type: 'file', repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
           WHERE NOT f.path CONTAINS '/'
           MATCH (sm:SemanticModule {id: $moduleId})
           MERGE (fn)-[:BELONGS_TO]->(sm)
           RETURN count(*) AS cnt`,
          { repo, moduleId: mod.moduleId },
        )
        edgesWritten += toNum(result.records[0]?.get('cnt'))
      }
    }
  }

  onProgress?.(`Written ${modulesWritten} modules, ${edgesWritten} BELONGS_TO edges`)
  return { modulesWritten, edgesWritten }
}

// ── IQR Outlier Detection & Split ────────────────────────

function computeModuleStats(modules: DiscoveredModule[], groups: DirGroup[]): {
  outliers: DiscoveredModule[]
  upperFence: number
  median: number
  sizes: Map<string, number>
} {
  // Estimate size per module by counting exports in its directories
  const dirExportCount = new Map<string, number>()
  for (const g of groups) {
    const count = g.files.reduce((s, f) => s + f.exports.length, 0)
    dirExportCount.set(g.dir, count)
  }

  const moduleSizes = modules.map(m => {
    const size = m.directories.reduce((s, d) => s + (dirExportCount.get(d) || 0), 0)
    return { mod: m, size }
  })

  const sizeMap = new Map<string, number>()
  for (const { mod, size } of moduleSizes) sizeMap.set(mod.moduleId, size)

  const values = moduleSizes.map(s => s.size).sort((a, b) => a - b)
  const n = values.length
  if (n < 4) return { outliers: [], upperFence: Infinity, median: 0, sizes: sizeMap }

  const q1 = values[Math.floor(n * 0.25)]
  const median = values[Math.floor(n * 0.5)]
  const q3 = values[Math.floor(n * 0.75)]
  const iqr = q3 - q1
  const upperFence = q3 + 1.5 * iqr

  const outliers = moduleSizes.filter(s => s.size > upperFence).map(s => s.mod)
  return { outliers, upperFence, median, sizes: sizeMap }
}

async function runOutlierSplit(
  ai: AIProvider,
  modules: DiscoveredModule[],
  groups: DirGroup[],
  repo: string,
  concurrency: number,
  onProgress?: (msg: string) => void,
): Promise<{ modules: DiscoveredModule[]; tokens: number }> {
  const { outliers, upperFence, median, sizes } = computeModuleStats(modules, groups)

  if (outliers.length === 0) {
    onProgress?.('IQR check: no outlier modules, skipping split')
    return { modules, tokens: 0 }
  }

  onProgress?.(`IQR check: median=${median}, upper fence=${upperFence}`)
  for (const o of outliers) {
    onProgress?.(`  outlier: ${o.name} (~${sizes.get(o.moduleId)} exports)`)
  }
  onProgress?.(`Splitting ${outliers.length} oversized modules concurrently...`)

  let totalTokens = 0
  const dirGroupMap = new Map<string, DirGroup>()
  for (const g of groups) dirGroupMap.set(g.dir, g)

  const splitResults = await runWithConcurrency(outliers, concurrency, async (mod) => {
    const dirExports = mod.directories
      .map(d => dirGroupMap.get(d))
      .filter((g): g is DirGroup => g !== undefined)

    const prompt = buildSplitPrompt(mod, dirExports, { median, upperFence })
    const raw = await ai.call(prompt, { timeoutMs: 300000 })
    const tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
    totalTokens += tokens

    const parsed = parseJsonSafe<{ modules: any[] }>(raw, { modules: [] })
    let newModules = parsed.modules
    if (!newModules && Array.isArray(parsed)) newModules = parsed as any
    if (!Array.isArray(newModules) || newModules.length === 0) {
      onProgress?.(`  ✗ ${mod.name}: split failed, keeping as-is`)
      return { original: mod, splits: null }
    }

    // Detect if this was a file-level split (single flat directory)
    const isSingleDir = dirExports.length === 1 && dirExports[0].files.length > 20
    const parentDir = isSingleDir ? dirExports[0].dir : undefined

    // Resolve file indices to filenames for single-dir splits
    const allFileNames = isSingleDir ? dirExports[0].files.map(f => f.name) : []

    const splits: DiscoveredModule[] = newModules.map((s: any, i: number) => {
      let directories: string[] = Array.isArray(s.directories) ? s.directories.map((d: string) => d.replace(/\/$/, '')) : []
      let files: string[] | undefined

      // Resolve fileIndices → filenames
      if (isSingleDir && Array.isArray(s.fileIndices)) {
        files = s.fileIndices
          .filter((idx: any) => typeof idx === 'number' && idx >= 0 && idx < allFileNames.length)
          .map((idx: number) => allFileNames[idx])
      }
      // Fallback: if LLM used "files" key with actual filenames
      if (!files && Array.isArray(s.files)) {
        files = s.files.map((f: string) => {
          if (f.includes('/')) return f.split('/').pop()!
          return f
        })
      }

      return {
        moduleId: s.moduleId || `split_${i + 1}`,
        name: s.name || `Split ${i + 1}`,
        description: s.description || '',
        directories,
        files,
        parentDir: (files && files.length > 0) ? parentDir : undefined,
        keyExports: Array.isArray(s.keyExports) ? s.keyExports : [],
        confidence: 0.75,
      }
    })

    // Post-process: ensure all files are assigned for single-dir splits
    if (isSingleDir && parentDir) {
      const assignedFiles = new Set<string>()
      for (const s of splits) {
        if (s.files) for (const f of s.files) assignedFiles.add(f)
      }

      const unmatched = allFileNames.filter(f => !assignedFiles.has(f))
      if (unmatched.length > 0) {
        // Find the split with most files as catch-all
        const largest = splits.reduce((a, b) =>
          (a.files?.length ?? 0) >= (b.files?.length ?? 0) ? a : b)
        if (largest.files) {
          largest.files.push(...unmatched)
        } else {
          largest.files = unmatched
          largest.parentDir = parentDir
        }
        onProgress?.(`    ${unmatched.length} unmatched files → ${largest.moduleId}`)
      }

      const totalAssigned = splits.reduce((s, m) => s + (m.files?.length ?? 0), 0)
      onProgress?.(`    file coverage: ${totalAssigned}/${allFileNames.length}`)
    }

    for (const s of splits) {
      const hasFiles = s.files && s.files.length > 0
      const hasDirs = s.directories && s.directories.length > 0
      const detail = hasFiles ? `${s.files!.length} files` : hasDirs ? `${s.directories.length} dirs` : 'EMPTY'
      onProgress?.(`    ${s.moduleId}: ${detail}`)
    }
    onProgress?.(`  ✓ ${mod.name} → ${splits.length} modules (${tokens.toLocaleString()} tokens)`)
    return { original: mod, splits }
  })

  // Replace outliers with their splits
  const outlierIds = new Set(outliers.map(o => o.moduleId))
  const result: DiscoveredModule[] = modules.filter(m => !outlierIds.has(m.moduleId))
  for (const { original, splits } of splitResults) {
    if (splits) {
      result.push(...splits)
    } else {
      result.push(original)
    }
  }

  onProgress?.(`Split done: ${modules.length} → ${result.length} modules (${totalTokens.toLocaleString()} tokens)`)
  return { modules: result, tokens: totalTokens }
}

// ── Import-based Assignment ──────────────────────────────

async function assignByImports(
  session: Session,
  repoPath: string,
  repo: string,
  modules: DiscoveredModule[],
  onProgress: (msg: string) => void,
): Promise<number> {
  // 1. Find orphan files
  const orphanRes = await session.run(
    `MATCH (f:CodeEntity {entity_type: 'file', repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
     WHERE fn.name <> ':program'
     OPTIONAL MATCH (fn)-[:BELONGS_TO]->(sm:SemanticModule)
     WITH f.path AS filePath, count(fn) AS total, count(sm) AS assigned
     WHERE assigned = 0
     RETURN filePath`,
    { repo },
  )
  const orphanFiles = orphanRes.records.map(r => r.get('filePath') as string)
  if (orphanFiles.length === 0) {
    onProgress('  No orphan files')
    return 0
  }
  onProgress(`  ${orphanFiles.length} orphan files`)

  // 2. For each orphan, count how many distinct non-sibling directories import it
  const allFiles = walkFiles(repoPath)
  const orphanSet = new Set(orphanFiles)

  // orphanFile → Set<importerDir (2-level, excluding same top-level dir)>
  const orphanImporterDirs = new Map<string, Set<string>>()

  for (const absPath of allFiles) {
    const rel = path.relative(repoPath, absPath)
    const parts = rel.split('/')
    const importerDir = parts.length >= 3
      ? parts[0] + '/' + parts[1]
      : parts.length >= 2 ? parts[0] : '.'

    let content: string
    try { content = fs.readFileSync(absPath, 'utf-8') } catch { continue }

    const importRegex = /from\s+['"]([^'"]+)['"]/g
    let m
    while ((m = importRegex.exec(content)) !== null) {
      let importPath = m[1]
      let resolved: string | null = null

      if (importPath.startsWith('.')) {
        const dir = path.dirname(absPath)
        const abs = path.resolve(dir, importPath).replace(/\.js$/, '')
        for (const ext of ['.ts', '.tsx']) {
          if (fs.existsSync(abs + ext)) { resolved = path.relative(repoPath, abs + ext); break }
        }
      } else if (importPath.startsWith('src/')) {
        const stripped = importPath.slice(4).replace(/\.js$/, '')
        for (const ext of ['.ts', '.tsx']) {
          const candidate = path.join(repoPath, stripped + ext)
          if (fs.existsSync(candidate)) { resolved = stripped + ext; break }
        }
      }

      if (!resolved || !orphanSet.has(resolved)) continue

      // Skip self-imports (importer in same top-level dir as orphan)
      const orphanTopDir = resolved.split('/')[0]
      const importerTopDir = parts[0]
      if (importerTopDir === orphanTopDir) continue

      if (!orphanImporterDirs.has(resolved)) orphanImporterDirs.set(resolved, new Set())
      orphanImporterDirs.get(resolved)!.add(importerDir)
    }
  }

  // 3. Classify: 1 external dir → assign to that module, 0 or 2+ → foundation
  const dirToModule = new Map<string, string>()
  for (const mod of modules) {
    for (const dir of mod.directories) dirToModule.set(dir, mod.moduleId)
  }

  const specificFiles = new Map<string, string>() // filePath → moduleId
  const foundationFiles: string[] = []

  for (const filePath of orphanFiles) {
    const dirs = orphanImporterDirs.get(filePath)
    if (!dirs || dirs.size !== 1) {
      foundationFiles.push(filePath)
      continue
    }
    // Exactly 1 external dir imports this file — find its module
    const dir = [...dirs][0]
    let moduleId = dirToModule.get(dir)
    if (!moduleId) {
      // Try 1-level match
      const topDir = dir.split('/')[0]
      moduleId = dirToModule.get(topDir)
    }
    if (moduleId) {
      specificFiles.set(filePath, moduleId)
    } else {
      foundationFiles.push(filePath)
    }
  }

  // 4. Write specific assignments
  let totalAssigned = 0
  const byModule = new Map<string, string[]>()
  for (const [fp, modId] of specificFiles) {
    if (!byModule.has(modId)) byModule.set(modId, [])
    byModule.get(modId)!.push(fp)
  }

  for (const [moduleId, files] of byModule) {
    const BATCH = 50
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH)
      const result = await session.run(
        `UNWIND $paths AS filePath
         MATCH (f:CodeEntity {entity_type: 'file', repo: $repo, path: filePath})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
         MATCH (sm:SemanticModule {id: $moduleId})
         MERGE (fn)-[:BELONGS_TO]->(sm)
         RETURN count(*) AS cnt`,
        { paths: batch, repo, moduleId },
      )
      totalAssigned += toNum(result.records[0]?.get('cnt'))
    }
  }

  // 5. Foundation for the rest
  if (foundationFiles.length > 0) {
    const existsRes = await session.run(
      `MATCH (sm:SemanticModule {id: 'foundation', repo: $repo}) RETURN sm.id`, { repo },
    )
    if (existsRes.records.length === 0) {
      await session.run(
        `CREATE (sm:SemanticModule {
          id: 'foundation', name: 'Foundation & Infrastructure',
          description: 'Cross-cutting utilities used by 2+ modules: logging, errors, formatting, data structures',
          repo: $repo, confidence: 0.7, function_count: 0,
          created_at: $now, source: 'import_assignment'
        })`,
        { repo, now: new Date().toISOString() },
      )
    }
    const BATCH = 50
    for (let i = 0; i < foundationFiles.length; i += BATCH) {
      const batch = foundationFiles.slice(i, i + BATCH)
      const result = await session.run(
        `UNWIND $paths AS filePath
         MATCH (f:CodeEntity {entity_type: 'file', repo: $repo, path: filePath})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
         MATCH (sm:SemanticModule {id: 'foundation'})
         MERGE (fn)-[:BELONGS_TO]->(sm)
         RETURN count(*) AS cnt`,
        { paths: batch, repo },
      )
      totalAssigned += toNum(result.records[0]?.get('cnt'))
    }
  }

  onProgress(`  ${specificFiles.size} files → specific modules, ${foundationFiles.length} files → Foundation`)
  return totalAssigned
}

// ── Main Pipeline ────────────────────────────────────────

export interface DiscoverModulesOpts {
  dbSession: Session
  ai: AIProvider
  repo: string
  repoPath: string
  concurrency?: number
  numChunks?: number
  dryRun?: boolean
  onProgress?: (msg: string) => void
}

export async function discoverModules(opts: DiscoverModulesOpts): Promise<DiscoveryResult> {
  const {
    dbSession, ai, repo, repoPath,
    concurrency = 5, numChunks = 5,
    dryRun = false, onProgress,
  } = opts
  const startTime = Date.now()

  // Step 1: Scan exports
  onProgress?.('Scanning exports...')
  const { groups, totalFiles } = buildDirGroups(repoPath)
  const totalExports = groups.reduce((s, g) => s + g.files.reduce((s2, f) => s2 + f.exports.length, 0), 0)
  onProgress?.(`Found ${groups.length} directories, ${totalExports} exports across ${totalFiles} files`)

  if (groups.length === 0) {
    throw new Error('No exports found. Check that the repo has TS/TSX/JS files with exports.')
  }

  // Step 2: Build directory summary (shared context for all chunks)
  const allDirSummary = groups.map(g => {
    const exportCount = g.files.reduce((s, f) => s + f.exports.length, 0)
    return `${g.dir}/ (${g.files.length} files, ${exportCount} exports)`
  }).join('\n')

  // Step 3: Split & run concurrent chunk analysis
  const chunks = splitIntoChunks(groups, numChunks)
  const { chunkResults, tokens: p1Tokens } = await runPhase1(
    ai, chunks, allDirSummary, repo, concurrency, onProgress,
  )

  // Step 4: Merge
  const { modules: mergedModules, tokens: p2Tokens } = await runPhase2(ai, chunkResults, repo, onProgress)

  // Step 5: IQR outlier split
  const { modules, tokens: splitTokens } = await runOutlierSplit(
    ai, mergedModules, groups, repo, concurrency, onProgress,
  )
  const totalLLMTokens = p1Tokens + p2Tokens + splitTokens

  // Step 6: Write to graph
  if (!dryRun) {
    onProgress?.('Writing modules to graph...')
    await writeModulesToGraph(dbSession, modules, repo, onProgress)

    // Step 7: Import-based assignment for flat directory orphans (e.g. utils/)
    onProgress?.('Import-based assignment for flat directory files...')
    const importAssigned = await assignByImports(dbSession, repoPath, repo, modules, onProgress!)

    // Step 8: Backfill remaining orphans — same-file then same-directory majority module
    onProgress?.('Backfilling remaining orphan functions...')
    const fileFill = await dbSession.run(
      `MATCH (f:CodeEntity {entity_type: 'file', repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
       WHERE fn.name <> ':program'
       OPTIONAL MATCH (fn)-[:BELONGS_TO]->(sm:SemanticModule)
       WITH f, fn, sm
       WITH f,
         collect(CASE WHEN sm IS NOT NULL THEN {fn: fn, mod: sm.id} END) AS assigned,
         collect(CASE WHEN sm IS NULL THEN fn END) AS orphans
       WHERE size(orphans) > 0 AND size(assigned) > 0
       UNWIND assigned AS a
       WITH f, orphans, a.mod AS modId, count(*) AS cnt
       ORDER BY cnt DESC
       WITH f, orphans, collect(modId)[0] AS majorityMod
       UNWIND orphans AS orphan
       MATCH (sm:SemanticModule {id: majorityMod})
       MERGE (orphan)-[:BELONGS_TO]->(sm)
       RETURN count(*) AS cnt`,
      { repo },
    )
    const fileFilled = toNum(fileFill.records[0]?.get('cnt'))

    const dirFill = await dbSession.run(
      `MATCH (f:CodeEntity {entity_type: 'file', repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
       WHERE fn.name <> ':program'
       OPTIONAL MATCH (fn)-[:BELONGS_TO]->(sm:SemanticModule)
       WITH fn, f, sm
       WHERE sm IS NULL
       WITH fn, split(f.path, '/') AS parts
       WITH fn, parts[0] + '/' + coalesce(parts[1], '') + '/' AS dirPrefix
       MATCH (f2:CodeEntity {entity_type: 'file', repo: $repo})-[:CONTAINS]->(fn2:CodeEntity {entity_type: 'function'})
       WHERE f2.path STARTS WITH dirPrefix
       MATCH (fn2)-[:BELONGS_TO]->(sm2:SemanticModule)
       WITH fn, sm2.id AS modId, count(fn2) AS cnt
       ORDER BY cnt DESC
       WITH fn, collect(modId)[0] AS majorityMod
       WHERE majorityMod IS NOT NULL
       MATCH (sm:SemanticModule {id: majorityMod})
       MERGE (fn)-[:BELONGS_TO]->(sm)
       RETURN count(*) AS cnt`,
      { repo },
    )
    const dirFilled = toNum(dirFill.records[0]?.get('cnt'))
    onProgress?.(`  File backfill: +${fileFilled}, Dir backfill: +${dirFilled}`)

    // Update function counts
    await dbSession.run(
      `MATCH (sm:SemanticModule {repo: $repo})
       OPTIONAL MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm)
       WITH sm, count(fn) AS cnt
       SET sm.function_count = cnt`,
      { repo },
    )

    // Count coverage
    const coverageResult = await dbSession.run(
      `MATCH (fn:CodeEntity {entity_type: 'function', repo: $repo})
       WHERE fn.name <> ':program'
       OPTIONAL MATCH (fn)-[:BELONGS_TO]->(sm:SemanticModule)
       RETURN
         count(fn) AS total,
         count(sm) AS assigned`,
      { repo },
    )
    const total = toNum(coverageResult.records[0]?.get('total'))
    const assigned = toNum(coverageResult.records[0]?.get('assigned'))
    onProgress?.(`Coverage: ${assigned}/${total} functions assigned (${(assigned / total * 100).toFixed(1)}%)`)
  } else {
    onProgress?.('[DRY RUN] Skipping graph write')
    for (const mod of modules) {
      onProgress?.(`  ${mod.name} (${mod.directories.length} dirs): ${mod.directories.join(', ')}`)
    }
  }

  return {
    modules,
    stats: {
      totalFiles,
      totalExports,
      totalDirs: groups.length,
      chunksUsed: chunks.length,
      modulesDiscovered: modules.length,
      phase1Tokens: p1Tokens,
      phase2Tokens: p2Tokens + splitTokens,
      totalTokens: totalLLMTokens,
      durationMs: Date.now() - startTime,
    },
  }
}
