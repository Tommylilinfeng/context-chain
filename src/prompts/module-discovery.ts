/**
 * Semantic Module Discovery — Prompt Templates
 *
 * Two rounds:
 *   Round 1 — Structure Discovery: AST communities (with signatures + call edges) → semantic modules
 *   Round 2 — Boundary Review: global view of all modules, add/remove function memberships
 *
 * Key design: functions can belong to multiple modules (many-to-many).
 */

// ── Types ────────────────────────────────────────────────

export interface ASTCommunity {
  communityId: number
  size: number
  topDirs: string[]               // top directories by function count
  sampleFiles: string[]           // representative file names
  /** Top function signatures (first 2-3 lines of code) */
  signatures: { name: string; filePath: string; sig: string }[]
  /** Top internal call edges: "caller → callee" */
  topCallEdges: string[]
}

export interface ProposedModule {
  moduleId: string
  name: string
  description: string
  sourceCommunities: number[]
  functionKeys: string[]          // "filePath::functionName"
  confidence: number
}

export interface BoundaryFunction {
  key: string                     // "filePath::functionName"
  currentModules: string[]        // module IDs it currently belongs to
  signature: string               // first few lines
  /** How many callers are in each module */
  callerDistribution: Record<string, number>  // moduleId → count
}

export interface BoundaryEdit {
  functionKey: string
  addTo: string[]                 // module IDs to add BELONGS_TO
  removeFrom: string[]            // module IDs to remove BELONGS_TO
  reasoning: string
}

export interface RefinedModule {
  moduleId: string
  name: string
  description: string
  functionKeys: string[]
  confidence: number
}

export interface DiscoveryResult {
  modules: RefinedModule[]
  boundaryEdits: BoundaryEdit[]
  stats: {
    communitiesDetected: number
    initialModules: number
    finalModules: number
    boundaryFunctionsReviewed: number
    editsApplied: number
    round1Tokens: number
    round2Tokens: number
    totalTokens: number
    durationMs: number
  }
}

// ── Round 1: Structure Discovery ─────────────────────────

export function buildStructureDiscoveryPrompt(
  communities: ASTCommunity[],
  repoName: string,
): string {
  const communityList = communities.map(c => {
    const dirs = c.topDirs.slice(0, 5).join(', ')
    const files = c.sampleFiles.slice(0, 6).join(', ')
    const sigs = c.signatures.slice(0, 12).map(s =>
      `    ${s.filePath}::${s.name}: ${s.sig}`
    ).join('\n')
    const edges = c.topCallEdges.slice(0, 8).map(e => `    ${e}`).join('\n')

    return `C${c.communityId} (${c.size} functions):
  dirs: ${dirs}
  files: ${files}
  signatures:
${sigs}
  call edges:
${edges}`
  }).join('\n\n')

  return `You are analyzing the architecture of "${repoName}" by examining function call-graph communities.

Below are ${communities.length} communities detected by Louvain algorithm on the function call graph (utility/hub functions removed). Each community is a group of functions that call each other more than they call outside. For each community you see: directory distribution, file names, representative function signatures (first lines of code), and top internal call edges.

${communityList}

## Task

Reorganize these structural communities into **semantic modules**.

Guidelines:
- Merge small communities that are sub-parts of the same concern
- Split large communities (>200 functions) ONLY if they clearly mix distinct concerns
- Name modules by WHAT they do (e.g. "Permission System", "Shell Execution")
- Aim for 15-30 modules
- A function CAN belong to multiple modules if it genuinely serves multiple concerns — list it in all relevant modules
- Each community maps to one primary module, but individual functions may be shared

Return ONLY raw JSON (no markdown, no backticks):
{
  "modules": [
    {
      "moduleId": "mod_1",
      "name": "2-5 word name",
      "description": "1-2 sentences: what this module does and why",
      "sourceCommunities": [3, 7, 15],
      "confidence": 0.85
    }
  ]
}`
}

// ── Round 2: Boundary Review ─────────────────────────────

export function buildBoundaryReviewPrompt(
  modules: { moduleId: string; name: string; description: string; functionCount: number }[],
  boundaryFunctions: BoundaryFunction[],
): string {
  const moduleList = modules.map(m =>
    `  ${m.moduleId}: ${m.name} (${m.functionCount} fns) — ${m.description}`
  ).join('\n')

  const fnList = boundaryFunctions.map(f => {
    const callerDist = Object.entries(f.callerDistribution)
      .sort((a, b) => b[1] - a[1])
      .map(([mod, cnt]) => `${mod}(${cnt})`)
      .join(', ')
    return `  ${f.key}
    current: [${f.currentModules.join(', ')}]
    callers from: ${callerDist}
    sig: ${f.signature}`
  }).join('\n\n')

  return `You are reviewing module boundary assignments for functions that may be misplaced or should belong to additional modules.

## All Modules
${moduleList}

## Boundary Functions (flagged because their callers come from multiple modules)
${fnList}

## Task

For each boundary function, decide:
- **addTo**: additional module(s) this function should also belong to (it genuinely serves that concern)
- **removeFrom**: module(s) this function should NOT belong to (it was misassigned)
- Both can be empty (function is correctly assigned)

A function serving multiple modules is normal and expected — shared utilities, cross-cutting concerns, integration points. Only remove a membership if the function clearly does NOT belong.

Return ONLY raw JSON (no markdown, no backticks):
{
  "edits": [
    {
      "functionKey": "path/file.ts::functionName",
      "addTo": ["mod_3"],
      "removeFrom": [],
      "reasoning": "brief explanation"
    }
  ]
}`
}
