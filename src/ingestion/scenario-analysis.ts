/**
 * Scenario Analysis Pipeline
 *
 * Phase A: Compute SUB_CALLS edges (submodule-to-submodule, aggregated from function CALLS)
 * Phase B: LLM scenario discovery (identify user scenarios + trace flow through submodules)
 *
 * Usage:
 *   npm run scenario-analysis -- --repo claudecode --edges-only
 *   npm run scenario-analysis -- --repo claudecode --dry-run
 *   npm run scenario-analysis -- --repo claudecode
 */

import { Session } from 'neo4j-driver'
import { AIProvider } from '../ai/types'
import { parseJsonSafe, toNum } from './shared'
import {
  ScenarioInput,
  ScenarioDiscoveryOutput,
  ScenarioAnalysisResult,
  buildScenarioDiscoveryPrompt,
} from '../prompts/scenario-analysis'

// ── Options ──────────────────────────────────────────────

export interface ScenarioAnalysisOpts {
  dbSession: Session
  ai: AIProvider
  repo: string
  edgesOnly?: boolean
  dryRun?: boolean
  shouldAbort?: () => boolean
  onProgress?: (msg: string) => void
}

// ── Phase A: Compute SUB_CALLS edges ─────────────────────

export async function computeSubModuleEdges(
  session: Session,
  repo: string,
  dryRun: boolean,
  onProgress: (msg: string) => void,
): Promise<number> {
  onProgress('Phase A: Computing sub-module call edges...')

  // Count existing sub-modules
  const subCheck = await session.run(
    `MATCH (sub:SubModule {repo: $repo}) RETURN count(sub) AS cnt`,
    { repo },
  )
  const subCount = toNum(subCheck.records[0]?.get('cnt'))
  if (subCount === 0) {
    throw new Error(`No SubModule nodes found for repo "${repo}". Run design-analysis first.`)
  }
  onProgress(`  Found ${subCount} sub-modules`)

  if (!dryRun) {
    // Clear existing SUB_CALLS for this repo
    await session.run(
      `MATCH (a:SubModule {repo: $repo})-[r:SUB_CALLS]->(b:SubModule) DELETE r`,
      { repo },
    )
  }

  // Aggregate function CALLS into submodule edges
  const edgeResult = await session.run(
    `MATCH (a:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(subA:SubModule {repo: $repo})
     MATCH (a)-[:CALLS]->(b:CodeEntity {entity_type: 'function'})
     MATCH (b)-[:BELONGS_TO]->(subB:SubModule {repo: $repo})
     WHERE subA.id <> subB.id
     RETURN subA.id AS source, subB.id AS target, count(*) AS weight`,
    { repo },
  )

  const edges = edgeResult.records.map(r => ({
    source: r.get('source') as string,
    target: r.get('target') as string,
    weight: toNum(r.get('weight')),
  }))

  onProgress(`  Found ${edges.length} cross-submodule call edges`)

  if (!dryRun && edges.length > 0) {
    // Write SUB_CALLS edges in batches
    const BATCH = 100
    for (let i = 0; i < edges.length; i += BATCH) {
      const batch = edges.slice(i, i + BATCH)
      await session.run(
        `UNWIND $edges AS e
         MATCH (a:SubModule {id: e.source})
         MATCH (b:SubModule {id: e.target})
         CREATE (a)-[:SUB_CALLS {repo: $repo, weight: e.weight}]->(b)`,
        { edges: batch, repo },
      )
    }
    onProgress(`  Wrote ${edges.length} SUB_CALLS edges`)
  }

  return edges.length
}

// ── Entry Point Detection ────────────────────────────────

async function detectEntryHints(
  session: Session,
  repo: string,
): Promise<string[]> {
  const result = await session.run(
    `MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sub:SubModule {repo: $repo})
     WHERE fn.name =~ '.*(main|cli|parse|route|handler|entry|start|init|bootstrap|serve|listen).*'
     RETURN DISTINCT sub.id AS id, sub.name AS name, count(fn) AS hits
     ORDER BY hits DESC
     LIMIT 15`,
    { repo },
  )
  return result.records.map(r => r.get('id') as string)
}

// ── Load SubModule + Edge data for prompt ────────────────

async function loadSubModuleGraph(
  session: Session,
  repo: string,
): Promise<{ subModules: ScenarioInput['subModules']; edges: ScenarioInput['subModuleEdges'] }> {
  // SubModules with parent module info
  const subRes = await session.run(
    `MATCH (sub:SubModule {repo: $repo})-[:CHILD_OF]->(sm:SemanticModule)
     OPTIONAL MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sub)
     RETURN sub.id AS id, sub.name AS name, sub.description AS description,
            sm.name AS parentModule, sm.id AS parentModuleId,
            count(fn) AS fnCount
     ORDER BY fnCount DESC`,
    { repo },
  )

  const subModules = subRes.records.map(r => ({
    id: r.get('id') as string,
    name: r.get('name') as string,
    description: (r.get('description') as string) || '',
    parentModule: r.get('parentModule') as string,
    parentModuleId: r.get('parentModuleId') as string,
    fnCount: toNum(r.get('fnCount')),
  }))

  // SUB_CALLS edges
  const edgeRes = await session.run(
    `MATCH (a:SubModule {repo: $repo})-[r:SUB_CALLS]->(b:SubModule)
     RETURN a.id AS sourceId, a.name AS sourceName,
            b.id AS targetId, b.name AS targetName,
            r.weight AS weight
     ORDER BY r.weight DESC`,
    { repo },
  )

  const edges = edgeRes.records.map(r => ({
    sourceId: r.get('sourceId') as string,
    sourceName: r.get('sourceName') as string,
    targetId: r.get('targetId') as string,
    targetName: r.get('targetName') as string,
    weight: toNum(r.get('weight')),
  }))

  return { subModules, edges }
}

// ── Phase B: LLM Scenario Discovery ──────────────────────

async function runPhaseB(
  session: Session,
  ai: AIProvider,
  repo: string,
  dryRun: boolean,
  onProgress: (msg: string) => void,
): Promise<{ scenariosCreated: number; totalSteps: number; totalFlowEdges: number; tokens: number }> {
  onProgress('Phase B: Loading sub-module graph for scenario discovery...')

  const { subModules, edges } = await loadSubModuleGraph(session, repo)
  if (subModules.length === 0) {
    throw new Error('No sub-modules with CHILD_OF edges found. Run design-analysis first.')
  }
  onProgress(`  ${subModules.length} sub-modules, ${edges.length} SUB_CALLS edges`)

  const entryHints = await detectEntryHints(session, repo)
  onProgress(`  ${entryHints.length} entry point hints detected`)

  const input: ScenarioInput = {
    repoName: repo,
    subModules,
    subModuleEdges: edges,
    entryHints,
  }

  const prompt = buildScenarioDiscoveryPrompt(input)
  onProgress(`  Prompt: ${prompt.length} chars`)

  if (dryRun) {
    onProgress('  [DRY RUN] Prompt built, skipping LLM call')
    console.log('\n━━━ Prompt Preview ━━━\n')
    console.log(prompt.slice(0, 3000))
    if (prompt.length > 3000) console.log(`\n... (${prompt.length - 3000} chars truncated)`)
    return { scenariosCreated: 0, totalSteps: 0, totalFlowEdges: 0, tokens: 0 }
  }

  // LLM call
  onProgress('  Calling LLM for scenario discovery...')
  const raw = await ai.call(prompt, { timeoutMs: 600000 })
  const tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
  onProgress(`  LLM response: ${raw.length} chars, ${tokens.toLocaleString()} tokens`)

  const parsed = parseJsonSafe<ScenarioDiscoveryOutput>(raw, { scenarios: [] })
  if (parsed.scenarios.length === 0) {
    onProgress('  WARNING: No scenarios parsed from LLM response')
    return { scenariosCreated: 0, totalSteps: 0, totalFlowEdges: 0, tokens }
  }

  onProgress(`  Parsed ${parsed.scenarios.length} scenarios`)

  // Validate: only keep steps referencing valid submodule IDs
  const validIds = new Set(subModules.map(sm => sm.id))
  let totalSteps = 0
  let totalFlowEdges = 0

  // Clear existing scenarios for this repo
  await session.run(
    `MATCH (s:Scenario {repo: $repo}) DETACH DELETE s`,
    { repo },
  )
  // Clear existing FLOWS_TO edges for this repo
  await session.run(
    `MATCH (a:SubModule {repo: $repo})-[r:FLOWS_TO]->(b:SubModule) DELETE r`,
    { repo },
  )

  const now = new Date().toISOString()

  for (const scenario of parsed.scenarios) {
    // Filter steps to valid submodule IDs
    const validSteps = scenario.steps.filter(s => validIds.has(s.subModuleId))
    if (validSteps.length < 2) {
      onProgress(`  Skipping "${scenario.name}" — fewer than 2 valid steps`)
      continue
    }

    const scenarioId = `scenario_${scenario.scenarioId}`

    // Create Scenario node
    await session.run(
      `CREATE (s:Scenario {
        id: $id, repo: $repo, name: $name, description: $description,
        category: $category, confidence: $confidence,
        created_at: $now, source: 'scenario_analysis'
      })`,
      {
        id: scenarioId, repo, name: scenario.name,
        description: scenario.description, category: scenario.category || 'unknown',
        confidence: scenario.confidence ?? 0.8, now,
      },
    )

    // Create PARTICIPATES_IN edges
    for (const step of validSteps) {
      await session.run(
        `MATCH (sub:SubModule {id: $subId})
         MATCH (s:Scenario {id: $scenarioId})
         MERGE (sub)-[:PARTICIPATES_IN {order: $order, role: $role}]->(s)`,
        { subId: step.subModuleId, scenarioId, order: step.order, role: step.role },
      )
    }
    totalSteps += validSteps.length

    // Create FLOWS_TO edges (only between valid submodules in this scenario)
    const stepIds = new Set(validSteps.map(s => s.subModuleId))
    const validFlows = scenario.flowEdges.filter(f => stepIds.has(f.from) && stepIds.has(f.to))
    for (const flow of validFlows) {
      await session.run(
        `MATCH (a:SubModule {id: $from})
         MATCH (b:SubModule {id: $to})
         CREATE (a)-[:FLOWS_TO {scenario_id: $scenarioId, label: $label}]->(b)`,
        { from: flow.from, to: flow.to, scenarioId, label: flow.label },
      )
    }
    totalFlowEdges += validFlows.length

    onProgress(`  Created scenario "${scenario.name}" — ${validSteps.length} steps, ${validFlows.length} edges`)
  }

  const scenariosCreated = parsed.scenarios.filter(s =>
    s.steps.filter(st => validIds.has(st.subModuleId)).length >= 2
  ).length

  return { scenariosCreated, totalSteps, totalFlowEdges, tokens }
}

// ── Main Entry Point ─────────────────────────────────────

export async function runScenarioAnalysis(opts: ScenarioAnalysisOpts): Promise<ScenarioAnalysisResult> {
  const {
    dbSession, ai, repo,
    edgesOnly = false,
    dryRun = false,
    shouldAbort = () => false,
    onProgress = () => {},
  } = opts
  const startTime = Date.now()

  // Phase A: Compute SUB_CALLS edges
  const subModuleEdges = await computeSubModuleEdges(dbSession, repo, dryRun, onProgress)

  if (edgesOnly || shouldAbort()) {
    return {
      subModuleEdges,
      scenariosCreated: 0, totalSteps: 0, totalFlowEdges: 0,
      tokens: 0, durationMs: Date.now() - startTime,
    }
  }

  // Phase B: LLM Scenario Discovery
  const phaseB = await runPhaseB(dbSession, ai, repo, dryRun, onProgress)

  return {
    subModuleEdges,
    ...phaseB,
    durationMs: Date.now() - startTime,
  }
}
