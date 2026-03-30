/**
 * concern-analysis.ts
 *
 * Community detection (Louvain via MAGE) + LLM analysis of decision clusters.
 * Called from dashboard API — results returned as structured JSON.
 */

import { Session } from 'neo4j-driver'
import { parseJsonSafe } from './shared'

// ── Helpers ────────────────────────────────────────────

function num(val: any): number {
  if (val === null || val === undefined) return 0
  if (typeof val === 'number') return val
  if (typeof val?.toNumber === 'function') return val.toNumber()
  return parseInt(String(val)) || 0
}

// ── Types ──────────────────────────────────────────────

export interface CommunityDecision {
  id: string
  summary: string
  content: string
  keywords: string[]
  findingType: string
  anchorFunction: string | null
  anchorFile: string | null
}

export interface CommunityGroup {
  communityId: number
  decisions: CommunityDecision[]
}

export interface ConcernLayer {
  level: 'entry' | 'logic' | 'infra'
  label: string
  functions: string[]         // "file::function" format
  decisionSummaries: string[]
}

export interface CrossConcern {
  targetCommunityId: number
  relationship: string
  description: string
}

export interface ConcernAnalysis {
  communityId: number
  name: string
  description: string
  keyThemes: string[]
  risks: string[]
  layers: ConcernLayer[]
  crossConcerns: CrossConcern[]
  decisionIds: string[]
}

export interface DetectionResult {
  communities: CommunityGroup[]
  edges: { source: string; target: string; type: string; reason?: string }[]
}

export interface AnalysisResult {
  concerns: ConcernAnalysis[]
  totalCommunities: number
  analyzedCommunities: number
  skippedSingleton: number
}

// ── Community Detection ────────────────────────────────

export async function detectCommunities(session: Session): Promise<DetectionResult> {
  let communityRows: any[]
  try {
    const res = await session.run(`
      CALL community_detection.get()
      YIELD node, community_id
      WITH node, community_id WHERE node:DecisionContext
      OPTIONAL MATCH (node)-[:ANCHORED_TO]->(fn:CodeEntity {entity_type: 'function'})
      OPTIONAL MATCH (fFile:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(fn)
      RETURN node.id AS id, node.summary AS summary, node.content AS content,
             node.keywords AS keywords, node.finding_type AS ftype,
             community_id AS communityId,
             fn.name AS fnName, fFile.path AS filePath
      ORDER BY community_id, node.id
    `)
    communityRows = res.records
  } catch (err: any) {
    throw new Error(
      `community_detection.get failed: ${err.message}. Requires memgraph-mage image.`
    )
  }

  // Group by communityId
  const groupMap = new Map<number, CommunityDecision[]>()
  for (const rec of communityRows) {
    const cid = num(rec.get('communityId'))
    const decision: CommunityDecision = {
      id: rec.get('id') ?? '',
      summary: rec.get('summary') ?? '',
      content: rec.get('content') ?? '',
      keywords: rec.get('keywords') ?? [],
      findingType: rec.get('ftype') ?? '',
      anchorFunction: rec.get('fnName') ?? null,
      anchorFile: rec.get('filePath') ?? null,
    }
    if (!groupMap.has(cid)) groupMap.set(cid, [])
    groupMap.get(cid)!.push(decision)
  }

  const communities: CommunityGroup[] = []
  groupMap.forEach((decisions, communityId) => {
    communities.push({ communityId, decisions })
  })

  // Fetch inter-decision edges
  let edges: DetectionResult['edges'] = []
  try {
    const edgeRes = await session.run(`
      MATCH (a:DecisionContext)-[r:CAUSED_BY|DEPENDS_ON|CONFLICTS_WITH|CO_DECIDED]->(b:DecisionContext)
      RETURN a.id AS source, b.id AS target, type(r) AS type, r.reason AS reason
    `)
    edges = edgeRes.records.map((rec) => ({
      source: rec.get('source') ?? '',
      target: rec.get('target') ?? '',
      type: rec.get('type') ?? '',
      reason: rec.get('reason') ?? undefined,
    }))
  } catch {
    // edges are supplementary; proceed without them
  }

  return { communities, edges }
}

// ── Concern Analysis ───────────────────────────────────

export async function analyzeConcerns(opts: {
  dbSession: Session
  ai: any
  onProgress?: (msg: string) => void
}): Promise<AnalysisResult> {
  const { dbSession, ai, onProgress } = opts

  const detection = await detectCommunities(dbSession)
  const { communities } = detection

  const multiDecision = communities.filter((c) => c.decisions.length >= 2)
  const skippedSingleton = communities.length - multiDecision.length

  const concerns: ConcernAnalysis[] = []

  for (const community of multiDecision) {
    const decisions = community.decisions

    const prompt = `You are analyzing a cluster of related design decisions that were automatically grouped by community detection on a code knowledge graph.

## Decisions in this cluster:

${decisions.map((d, i) => `### ${i + 1}. [${d.id}]${d.anchorFile ? ` ${d.anchorFile}` : ''}${d.anchorFunction ? `::${d.anchorFunction}` : ''}
**Summary:** ${d.summary}
**Detail:** ${d.content}
**Keywords:** ${d.keywords.join(', ')}
**Type:** ${d.findingType}`).join('\n\n')}

## Task

Analyze this cluster as a "concern" — a cohesive area of design reasoning in the codebase.

Respond with JSON only (no markdown, no backticks):
{
  "name": "short name, 2-5 words",
  "description": "1-2 sentence summary of what this concern covers and why these decisions are related",
  "keyThemes": ["theme1", "theme2", "theme3"],
  "risks": ["potential risk or tension"],
  "layers": [
    {
      "level": "entry|logic|infra",
      "label": "human-readable layer name",
      "functions": ["file::function", ...],
      "decisionSummaries": ["short decision summary relevant to this layer"]
    }
  ],
  "crossConcerns": [
    {
      "relationship": "depends_on|triggers|shares_data",
      "description": "what the cross-concern relationship is about"
    }
  ]
}

Guidelines:
- "layers" should organize the code from entry points (API routes, handlers) through business logic to infrastructure (DB, external APIs). Omit layers that don't apply.
- "crossConcerns" should describe relationships with OTHER concerns that aren't in this cluster. Set targetCommunityId to -1 (it will be resolved later).
- Keep names concise and descriptive
- "risks" should focus on architectural risks, not code quality`

    const raw = await ai.call(prompt)
    const parsed: any = parseJsonSafe(raw, null)

    const analysis: ConcernAnalysis = {
      communityId: community.communityId,
      name: parsed?.name ?? 'Unknown',
      description: parsed?.description ?? '',
      keyThemes: parsed?.keyThemes ?? [],
      risks: parsed?.risks ?? [],
      layers: (parsed?.layers ?? []).map((l: any) => ({
        level: l.level ?? 'logic',
        label: l.label ?? '',
        functions: l.functions ?? [],
        decisionSummaries: l.decisionSummaries ?? [],
      })),
      crossConcerns: (parsed?.crossConcerns ?? []).map((cc: any) => ({
        targetCommunityId: cc.targetCommunityId ?? -1,
        relationship: cc.relationship ?? '',
        description: cc.description ?? '',
      })),
      decisionIds: community.decisions.map((d) => d.id),
    }

    concerns.push(analysis)

    onProgress?.(`Analyzed community ${community.communityId} (${community.decisions.length} decisions)`)
  }

  return {
    concerns,
    totalCommunities: communities.length,
    analyzedCommunities: multiDecision.length,
    skippedSingleton,
  }
}
