/**
 * Architecture Documentation Generation Pipeline
 *
 * Phase 1: Per-module architecture doc (1 LLM call per module, parallelizable)
 * Phase 2: Global system architecture overview (1 LLM call)
 *
 * Usage:
 *   npm run arch-doc -- --repo claudecode
 *   npm run arch-doc -- --repo claudecode --dry-run --limit 1
 */

import { Session } from 'neo4j-driver'
import fs from 'fs'
import path from 'path'
import { AIProvider } from '../ai/types'
import { parseJsonSafe, toNum, runWithConcurrency } from './shared'
import {
  ModuleDocInput,
  ModuleDoc,
  ArchDocResult,
  buildModuleDocPrompt,
  buildGlobalArchDocPrompt,
} from '../prompts/arch-doc'

// ── Options ──────────────────────────────────────────────

export interface ArchDocOpts {
  dbSession: Session
  ai: AIProvider
  repo: string
  concurrency?: number
  limit?: number
  dryRun?: boolean
  shouldAbort?: () => boolean
  onProgress?: (msg: string) => void
}

// ── Gather module data from graph ────────────────────────

async function gatherModuleInput(
  session: Session,
  repo: string,
  moduleId: string,
  moduleName: string,
  moduleDescription: string,
): Promise<ModuleDocInput> {
  // SubModules
  const subRes = await session.run(
    `MATCH (sub:SubModule {repo: $repo})-[:CHILD_OF]->(sm:SemanticModule {id: $moduleId})
     OPTIONAL MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sub)
     RETURN sub.id AS id, sub.name AS name, sub.description AS description, count(fn) AS fnCount
     ORDER BY fnCount DESC`,
    { repo, moduleId },
  )
  const subModules = subRes.records.map(r => ({
    id: r.get('id') as string,
    name: r.get('name') as string,
    description: (r.get('description') as string) || '',
    fnCount: toNum(r.get('fnCount')),
  }))

  // Internal SUB_CALLS edges
  const intEdgeRes = await session.run(
    `MATCH (a:SubModule {repo: $repo})-[:CHILD_OF]->(sm:SemanticModule {id: $moduleId})
     MATCH (b:SubModule {repo: $repo})-[:CHILD_OF]->(sm)
     MATCH (a)-[r:SUB_CALLS]->(b)
     RETURN a.name AS sourceName, b.name AS targetName, r.weight AS weight
     ORDER BY r.weight DESC LIMIT 40`,
    { repo, moduleId },
  )
  const internalEdges = intEdgeRes.records.map(r => ({
    sourceName: r.get('sourceName') as string,
    targetName: r.get('targetName') as string,
    weight: toNum(r.get('weight')),
  }))

  // Cross-module connections (aggregated from function CALLS)
  const crossRes = await session.run(
    `MATCH (fn1:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm1:SemanticModule {id: $moduleId})
     MATCH (fn1)-[:CALLS]->(fn2:CodeEntity {entity_type: 'function'})
     MATCH (fn2)-[:BELONGS_TO]->(sm2:SemanticModule {repo: $repo})
     WHERE sm2.id <> $moduleId
     RETURN sm2.id AS targetId, sm2.name AS targetName, count(*) AS weight
     ORDER BY weight DESC LIMIT 15`,
    { repo, moduleId },
  )
  const outgoing = crossRes.records.map(r => ({
    targetModuleId: r.get('targetId') as string,
    targetModuleName: r.get('targetName') as string,
    direction: 'outgoing' as const,
    weight: toNum(r.get('weight')),
  }))

  const inRes = await session.run(
    `MATCH (fn2:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm2:SemanticModule {repo: $repo})
     WHERE sm2.id <> $moduleId
     MATCH (fn2)-[:CALLS]->(fn1:CodeEntity {entity_type: 'function'})
     MATCH (fn1)-[:BELONGS_TO]->(sm1:SemanticModule {id: $moduleId})
     RETURN sm2.id AS targetId, sm2.name AS targetName, count(*) AS weight
     ORDER BY weight DESC LIMIT 15`,
    { repo, moduleId },
  )
  const incoming = inRes.records.map(r => ({
    targetModuleId: r.get('targetId') as string,
    targetModuleName: r.get('targetName') as string,
    direction: 'incoming' as const,
    weight: toNum(r.get('weight')),
  }))

  // Design decisions anchored to this module's functions
  const decRes = await session.run(
    `MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm:SemanticModule {id: $moduleId})
     MATCH (dc:DecisionContext)-[:ANCHORED_TO]->(fn)
     RETURN dc.summary AS summary, dc.content AS content, fn.name AS anchorFunction
     LIMIT 20`,
    { moduleId },
  )
  const decisions = decRes.records.map(r => ({
    summary: r.get('summary') as string,
    content: (r.get('content') as string) || '',
    anchorFunction: r.get('anchorFunction') as string,
  }))

  // Scenarios involving this module
  const scenRes = await session.run(
    `MATCH (sub:SubModule {repo: $repo})-[:CHILD_OF]->(sm:SemanticModule {id: $moduleId})
     MATCH (sub)-[p:PARTICIPATES_IN]->(s:Scenario)
     RETURN DISTINCT s.name AS name, p.role AS role`,
    { repo, moduleId },
  )
  const scenarios = scenRes.records.map(r => ({
    name: r.get('name') as string,
    role: r.get('role') as string || 'processing',
  }))

  // Entry functions (most called from outside this module)
  const entryRes = await session.run(
    `MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm:SemanticModule {id: $moduleId})
     MATCH (caller:CodeEntity {entity_type: 'function'})-[:CALLS]->(fn)
     MATCH (caller)-[:BELONGS_TO]->(callerMod:SemanticModule)
     WHERE callerMod.id <> $moduleId
     OPTIONAL MATCH (file:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(fn)
     WITH fn.name AS name, file.path AS filePath, count(DISTINCT caller) AS callerCount
     RETURN name, filePath, callerCount
     ORDER BY callerCount DESC LIMIT 8`,
    { moduleId },
  )
  const entryFunctions = entryRes.records.map(r => ({
    name: r.get('name') as string,
    filePath: (r.get('filePath') as string) || '',
    callerCount: toNum(r.get('callerCount')),
  }))

  return {
    repoName: repo,
    moduleName,
    moduleId,
    moduleDescription,
    subModules,
    internalEdges,
    crossModuleConnections: [...outgoing, ...incoming],
    decisions,
    scenarios,
    entryFunctions,
  }
}

// ── Main Pipeline ────────────────────────────────────────

export async function generateArchDocs(opts: ArchDocOpts): Promise<ArchDocResult> {
  const {
    dbSession, ai, repo,
    concurrency = 5,
    limit,
    dryRun = false,
    shouldAbort = () => false,
    onProgress = () => {},
  } = opts
  const startTime = Date.now()

  // Get all modules
  const modRes = await dbSession.run(
    `MATCH (sm:SemanticModule {repo: $repo})
     WHERE NOT sm.id STARTS WITH 'dir_'
     OPTIONAL MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm)
     RETURN sm.id AS id, sm.name AS name, sm.description AS description, count(fn) AS fnCount
     ORDER BY fnCount DESC`,
    { repo },
  )
  let modules = modRes.records.map(r => ({
    id: r.get('id') as string,
    name: r.get('name') as string,
    description: (r.get('description') as string) || '',
    fnCount: toNum(r.get('fnCount')),
  }))

  if (limit) {
    modules = modules.slice(0, limit)
    onProgress(`Limited to ${modules.length} module(s)`)
  }
  onProgress(`Phase 1: Generating docs for ${modules.length} modules (concurrency=${concurrency})`)

  // Phase 1: Per-module docs
  let completed = 0
  let totalTokens = 0

  const moduleDocs = await runWithConcurrency(modules, concurrency, async (mod): Promise<ModuleDoc> => {
    if (shouldAbort()) return emptyModuleDoc(mod.id)

    const idx = ++completed
    onProgress(`  [${idx}/${modules.length}] ${mod.name} (${mod.fnCount} fns)`)

    const input = await gatherModuleInput(dbSession, repo, mod.id, mod.name, mod.description)
    const prompt = buildModuleDocPrompt(input)
    onProgress(`    Prompt: ${prompt.length} chars, ${input.subModules.length} submodules, ${input.decisions.length} decisions`)

    if (dryRun) {
      if (idx === 1) {
        console.log('\n━━━ Prompt Preview (first module) ━━━\n')
        console.log(prompt.slice(0, 4000))
        if (prompt.length > 4000) console.log(`\n... (${prompt.length - 4000} chars truncated)`)
      }
      return emptyModuleDoc(mod.id)
    }

    try {
      const raw = await ai.call(prompt, { timeoutMs: 600000 })
      const tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
      totalTokens += tokens
      onProgress(`    Done: ${tokens.toLocaleString()} tokens`)

      const parsed = parseJsonSafe<Partial<ModuleDoc>>(raw, {})
      return {
        moduleId: mod.id,
        overview: parsed.overview || '',
        responsibility: parsed.responsibility || '',
        subModuleSummaries: parsed.subModuleSummaries || [],
        crossModuleRelationships: parsed.crossModuleRelationships || [],
        keyDesignDecisions: parsed.keyDesignDecisions || [],
        scenarioRoles: parsed.scenarioRoles || [],
      }
    } catch (err: any) {
      onProgress(`    ⚠ Failed: ${err.message}`)
      return emptyModuleDoc(mod.id)
    }
  })

  if (dryRun) {
    return { globalOverview: '', moduleDocs, totalTokens: 0, durationMs: Date.now() - startTime }
  }

  // Phase 2: Global overview
  onProgress('Phase 2: Generating global architecture overview...')
  const globalInput = moduleDocs
    .filter(d => d.overview)
    .map(d => {
      const mod = modules.find(m => m.id === d.moduleId)
      return {
        moduleId: d.moduleId,
        name: mod?.name || d.moduleId,
        overview: d.overview,
        responsibility: d.responsibility,
        crossModuleRelationships: d.crossModuleRelationships,
      }
    })

  let globalOverview = ''
  if (globalInput.length > 0 && !shouldAbort()) {
    try {
      const globalPrompt = buildGlobalArchDocPrompt(repo, globalInput)
      onProgress(`  Prompt: ${globalPrompt.length} chars`)
      const raw = await ai.call(globalPrompt, { timeoutMs: 600000 })
      const tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
      totalTokens += tokens
      const parsed = parseJsonSafe<{ globalOverview?: string }>(raw, {})
      globalOverview = parsed.globalOverview || ''
      onProgress(`  Done: ${tokens.toLocaleString()} tokens`)
    } catch (err: any) {
      onProgress(`  ⚠ Global overview failed: ${err.message}`)
    }
  }

  // Save to file
  const result: ArchDocResult = { globalOverview, moduleDocs, totalTokens, durationMs: Date.now() - startTime }
  const outPath = path.join('data', `${repo}-arch-docs.json`)
  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2))
  onProgress(`Saved to ${outPath}`)

  return result
}

function emptyModuleDoc(moduleId: string): ModuleDoc {
  return {
    moduleId,
    overview: '',
    responsibility: '',
    subModuleSummaries: [],
    crossModuleRelationships: [],
    keyDesignDecisions: [],
    scenarioRoles: [],
  }
}
