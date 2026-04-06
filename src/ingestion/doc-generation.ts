/**
 * ingestion/doc-generation.ts
 *
 * Two-level documentation generation:
 *   1. Per sub-module: feed full source code → deep doc (1 LLM call each, concurrent)
 *   2. Per module: synthesize sub-module docs → module doc (1 LLM call)
 */

import * as fs from 'fs'
import * as path from 'path'
import { Session } from 'neo4j-driver'
import { AIProvider } from '../ai/types'
import { toNum, runWithConcurrency } from './shared'
import { NOISE_FILTER } from './noise-filter'
import {
  buildSubModuleDocPrompt,
  buildModuleSynthesisPrompt,
} from '../prompts/doc-generation'

// ── Types ──────────────────────────────────────────────

export interface DocGenerationOpts {
  dbSession: Session
  ai: AIProvider
  repo: string
  repoPath: string
  outputDir: string
  moduleIds: string[]
  concurrency?: number
  onProgress?: (msg: string) => void
}

export interface DocGenerationResult {
  moduleId: string
  moduleName: string
  subModuleDocs: number
  synthesisPath: string
  tokens: number
  durationMs: number
}

// ── Source Code Gathering ──────────────────────────────

function readSourceForFiles(repoPath: string, filePaths: string[]): string {
  const sections: string[] = []
  for (const rel of filePaths) {
    const abs = path.join(repoPath, rel)
    try {
      const content = fs.readFileSync(abs, 'utf-8')
      sections.push(`// ═══ ${rel} ═══\n\n${content}`)
    } catch {}
  }
  return sections.join('\n\n')
}

// ── Per-Module Pipeline ────────────────────────────────

async function generateForModule(
  session: Session,
  ai: AIProvider,
  repo: string,
  repoPath: string,
  moduleId: string,
  outputDir: string,
  concurrency: number,
  onProgress: (msg: string) => void,
): Promise<DocGenerationResult> {
  const startTime = Date.now()
  let totalTokens = 0

  // Get module info
  const modRes = await session.run(
    `MATCH (sm:SemanticModule {id: $moduleId, repo: $repo})
     RETURN sm.name AS name, sm.description AS desc`,
    { moduleId, repo },
  )
  const moduleName = modRes.records[0]?.get('name') ?? moduleId
  const moduleDescription = modRes.records[0]?.get('desc') ?? ''

  // Get sub-modules
  const subRes = await session.run(
    `MATCH (sub:SubModule {parentModuleId: $moduleId, repo: $repo})
     RETURN sub.id AS subId, sub.name AS name, sub.description AS desc, sub.function_count AS fnCount
     ORDER BY sub.function_count DESC`,
    { moduleId, repo },
  )

  // Build sub-module info with files
  const subModules: { subId: string; name: string; desc: string; fnCount: number; files: string[] }[] = []
  for (const sr of subRes.records) {
    const subId = sr.get('subId') as string
    const filesRes = await session.run(
      `MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sub:SubModule {id: $subId})
       MATCH (f:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(fn)
       RETURN DISTINCT f.path AS file ORDER BY file`,
      { subId },
    )
    subModules.push({
      subId,
      name: sr.get('name') as string,
      desc: (sr.get('desc') as string) || '',
      fnCount: toNum(sr.get('fnCount')),
      files: filesRes.records.map(r => r.get('file') as string),
    })
  }

  onProgress(`  ${moduleName}: ${subModules.length} sub-modules`)

  // Create module output dir
  const moduleDir = path.join(outputDir, moduleId)
  fs.mkdirSync(moduleDir, { recursive: true })

  // Phase 1: Generate per-sub-module docs (concurrent)
  const subModuleDocs: { name: string; doc: string; functionCount: number; externalCallers: number }[] = []

  // Pre-compute external caller count per sub-module (importance signal)
  const externalCallerCounts = new Map<string, number>()
  for (const sm of subModules) {
    const callerRes = await session.run(
      `MATCH (callee:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sub:SubModule {id: $subId})
       MATCH (caller:CodeEntity {entity_type: 'function'})-[:CALLS]->(callee)
       MATCH (caller)-[:BELONGS_TO]->(callerMod:SemanticModule)
       WHERE callerMod.id <> $moduleId
       RETURN count(DISTINCT caller) AS cnt`,
      { subId: sm.subId, moduleId },
    )
    externalCallerCounts.set(sm.subId, toNum(callerRes.records[0]?.get('cnt')))
  }

  await runWithConcurrency(subModules, concurrency, async (sm) => {
    const source = readSourceForFiles(repoPath, sm.files)
    const prompt = buildSubModuleDocPrompt(
      sm.name, sm.desc, moduleName, source, sm.files.length, sm.fnCount,
    )
    const raw = await ai.call(prompt, { timeoutMs: 600000 })
    const tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
    totalTokens += tokens

    // Save individual sub-module doc
    const fileName = sm.subId.replace(`${moduleId}_`, '') + '.md'
    fs.writeFileSync(path.join(moduleDir, fileName), raw, 'utf-8')

    subModuleDocs.push({
      name: sm.name,
      doc: raw,
      functionCount: sm.fnCount,
      externalCallers: externalCallerCounts.get(sm.subId) ?? 0,
    })
    onProgress(`    ✓ ${sm.name} (${sm.files.length} files, ${tokens.toLocaleString()} tokens)`)
  })

  // Phase 2: Synthesize module doc
  onProgress(`  ${moduleName}: synthesizing...`)

  // External deps
  const extOutRes = await session.run(
    `MATCH (caller:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm:SemanticModule {id: $moduleId})
     MATCH (caller)-[:CALLS]->(callee:CodeEntity {entity_type: 'function'})
     MATCH (callee)-[:BELONGS_TO]->(sm2:SemanticModule {repo: $repo})
     WHERE sm2.id <> $moduleId
     RETURN sm2.name AS module, count(*) AS weight ORDER BY weight DESC LIMIT 8`,
    { moduleId, repo },
  )
  const extInRes = await session.run(
    `MATCH (callee:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm:SemanticModule {id: $moduleId})
     MATCH (caller:CodeEntity {entity_type: 'function'})-[:CALLS]->(callee)
     MATCH (caller)-[:BELONGS_TO]->(sm2:SemanticModule {repo: $repo})
     WHERE sm2.id <> $moduleId
     RETURN sm2.name AS module, count(*) AS weight ORDER BY weight DESC LIMIT 8`,
    { moduleId, repo },
  )

  const synthPrompt = buildModuleSynthesisPrompt(
    moduleName, moduleDescription, subModuleDocs,
    {
      dependsOn: extOutRes.records.map(r => r.get('module') as string),
      dependedBy: extInRes.records.map(r => r.get('module') as string),
    },
  )
  const synthRaw = await ai.call(synthPrompt, { timeoutMs: 600000 })
  const synthTokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
  totalTokens += synthTokens

  const synthPath = path.join(outputDir, `${moduleId}.md`)
  fs.writeFileSync(synthPath, fixMermaidBlocks(synthRaw), 'utf-8')
  onProgress(`  ✓ ${moduleName} synthesis (${synthTokens.toLocaleString()} tokens)`)

  return {
    moduleId, moduleName,
    subModuleDocs: subModuleDocs.length,
    synthesisPath: synthPath,
    tokens: totalTokens,
    durationMs: Date.now() - startTime,
  }
}

// ── Post-processing ────────────────────────────────────

function fixMermaidBlocks(md: string): string {
  return md.replace(
    /^mermaid\n((?:graph |sequenceDiagram|flowchart |classDiagram|stateDiagram|gantt|pie |erDiagram|gitGraph)[\s\S]*?)(?=\n---|\n## |\n#+ |\n\n[A-Z]|\n$)/gm,
    '```mermaid\n$1\n```',
  )
}

// ── Main Entry Point ───────────────────────────────────

export async function generateDocs(opts: DocGenerationOpts): Promise<DocGenerationResult[]> {
  const {
    dbSession, ai, repo, repoPath, outputDir,
    moduleIds, concurrency = 3,
    onProgress = () => {},
  } = opts

  fs.mkdirSync(outputDir, { recursive: true })

  // Process modules sequentially (share DB session), sub-modules concurrently within each
  const results: DocGenerationResult[] = []
  for (const moduleId of moduleIds) {
    const result = await generateForModule(
      dbSession, ai, repo, repoPath, moduleId, outputDir, concurrency, onProgress,
    )
    results.push(result)
  }

  return results
}
