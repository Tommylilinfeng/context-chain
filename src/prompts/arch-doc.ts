/**
 * Architecture Documentation — Types + Prompt Templates
 *
 * Phase 1: Per-module architecture doc (1 LLM call per module)
 * Phase 2: Global system architecture overview (1 LLM call)
 * Chat: Context-aware Q&A prompt builder
 */

// ── Input Types ────────────────────────────────────────

export interface ModuleDocInput {
  repoName: string
  moduleName: string
  moduleId: string
  moduleDescription: string
  subModules: {
    id: string
    name: string
    description: string
    fnCount: number
  }[]
  /** SubModule-to-SubModule call edges within this module */
  internalEdges: { sourceName: string; targetName: string; weight: number }[]
  /** Aggregated cross-module connections */
  crossModuleConnections: {
    targetModuleId: string
    targetModuleName: string
    direction: 'outgoing' | 'incoming'
    weight: number
  }[]
  /** Design decisions anchored to functions in this module */
  decisions: { summary: string; content: string; anchorFunction?: string }[]
  /** Scenarios involving this module's submodules */
  scenarios: { name: string; role: string }[]
  /** Top entry-point functions (most called from outside) */
  entryFunctions: { name: string; filePath: string; callerCount: number }[]
}

// ── Output Types ───────────────────────────────────────

export interface SubModuleDocSummary {
  subModuleId: string
  summary: string
  keyFunctions: string[]
  designPatterns: string[]
}

export interface CrossModuleRelationship {
  targetModuleId: string
  relationship: string
  direction: 'outgoing' | 'incoming' | 'bidirectional'
}

export interface ScenarioRole {
  scenarioName: string
  role: string
}

export interface ModuleDoc {
  moduleId: string
  overview: string
  responsibility: string
  subModuleSummaries: SubModuleDocSummary[]
  crossModuleRelationships: CrossModuleRelationship[]
  keyDesignDecisions: string[]
  scenarioRoles: ScenarioRole[]
}

export interface ArchDocResult {
  globalOverview: string
  moduleDocs: ModuleDoc[]
  totalTokens: number
  durationMs: number
}

// ── Phase 1: Per-Module Doc Prompt ─────────────────────

export function buildModuleDocPrompt(input: ModuleDocInput): string {
  const subModuleList = input.subModules
    .filter(s => s.name !== 'Other / Unclassified')
    .map(s => `- **${s.name}** (${s.fnCount} fns): ${s.description}`)
    .join('\n')

  const otherSub = input.subModules.find(s => s.name === 'Other / Unclassified')
  const otherNote = otherSub ? `\n- _Other / Unclassified_ (${otherSub.fnCount} fns): miscellaneous functions not yet categorized` : ''

  const internalEdges = input.internalEdges
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 30)
    .map(e => `  ${e.sourceName} -> ${e.targetName} (${e.weight} calls)`)
    .join('\n')

  const crossModule = input.crossModuleConnections
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 20)
    .map(c => `  ${c.direction === 'outgoing' ? '->' : '<-'} ${c.targetModuleName} (${c.weight} calls)`)
    .join('\n')

  const decisions = input.decisions.length > 0
    ? input.decisions.slice(0, 15).map(d =>
      `- ${d.summary}${d.anchorFunction ? ` (at ${d.anchorFunction})` : ''}`
    ).join('\n')
    : '(no design decisions recorded for this module)'

  const scenarios = input.scenarios.length > 0
    ? input.scenarios.map(s => `- **${s.name}**: ${s.role}`).join('\n')
    : '(not involved in any identified scenario)'

  const entryFns = input.entryFunctions.length > 0
    ? input.entryFunctions.map(f => `- ${f.name} (${f.filePath}, called ${f.callerCount} times from outside)`).join('\n')
    : '(no prominent entry points)'

  return `You are writing architecture documentation for the "${input.moduleName}" module in the "${input.repoName}" codebase.

## Module: ${input.moduleName}
${input.moduleDescription}

## Sub-Modules
${subModuleList}${otherNote}

## Internal Call Edges (top sub-module to sub-module calls within this module)
${internalEdges || '(none)'}

## Cross-Module Connections (calls to/from other modules)
${crossModule || '(isolated module)'}

## Design Decisions
${decisions}

## Scenario Involvement
${scenarios}

## Key Entry Points (most-called functions from outside this module)
${entryFns}

## Task

Write comprehensive architecture documentation for this module. This should help a new engineer understand:
1. What this module is responsible for and why it exists
2. How its sub-modules work together internally
3. How it connects to the rest of the system
4. Key design patterns and trade-offs

Return ONLY raw JSON (no markdown, no backticks):
{
  "overview": "2-3 paragraphs of markdown describing the module's architecture, internal structure, and how data flows through it. Reference specific sub-modules by name. Include a mermaid flowchart if the internal flow is non-trivial.",
  "responsibility": "1 paragraph: the single-sentence mission of this module, expanded with scope boundaries — what it does AND what it explicitly does NOT do.",
  "subModuleSummaries": [
    {
      "subModuleId": "exact_id_from_above",
      "summary": "2-3 sentences: what this sub-module does, key patterns, notable implementation details",
      "keyFunctions": ["top 3-5 function names that define this sub-module"],
      "designPatterns": ["e.g. Strategy pattern", "Event-driven", "Pipeline"]
    }
  ],
  "crossModuleRelationships": [
    {
      "targetModuleId": "the_module_id",
      "relationship": "1 sentence describing what flows between the modules and why",
      "direction": "outgoing | incoming | bidirectional"
    }
  ],
  "keyDesignDecisions": ["top 3-5 architectural decisions, phrased as 'Chose X over Y because Z'"],
  "scenarioRoles": [
    {
      "scenarioName": "scenario name",
      "role": "1 sentence: what this module does in this scenario"
    }
  ]
}

Guidelines:
- Write for a senior engineer who hasn't seen this codebase before
- Be specific — reference sub-module names, function names, and concrete behaviors
- For the overview, explain the ARCHITECTURE, not just list what exists
- Identify design patterns (factory, strategy, pipeline, pub/sub, etc.) where they exist
- Note any tension points or trade-offs visible in the structure`
}

// ── Phase 2: Global Architecture Overview Prompt ───────

export function buildGlobalArchDocPrompt(
  repoName: string,
  moduleDocs: { moduleId: string; name: string; overview: string; responsibility: string; crossModuleRelationships: CrossModuleRelationship[] }[],
): string {
  const moduleSummaries = moduleDocs.map(m => {
    const connections = m.crossModuleRelationships
      .slice(0, 5)
      .map(c => `    ${c.direction === 'outgoing' ? '->' : '<-'} ${c.targetModuleId}: ${c.relationship}`)
      .join('\n')
    return `### ${m.name} (${m.moduleId})
${m.responsibility}

Key connections:
${connections || '    (minimal connections)'}`
  }).join('\n\n')

  return `You are writing the top-level architecture overview for "${repoName}".

Below are summaries of all ${moduleDocs.length} modules in the system:

${moduleSummaries}

## Task

Write a comprehensive system architecture overview. This is the "chapter 1" that someone reads before diving into any specific module.

Return ONLY raw JSON (no markdown, no backticks):
{
  "globalOverview": "4-6 paragraphs of markdown covering: (1) What this system is and its core design philosophy, (2) High-level layering — which modules form the core, which are infrastructure, which are cross-cutting, (3) A mermaid architecture diagram showing module relationships, (4) Key data flows — how a typical request travels through the system, (5) Notable architectural patterns and trade-offs at the system level."
}

Guidelines:
- Start with the big picture, not module-by-module
- Identify the architectural layers (entry points, core logic, infrastructure, cross-cutting)
- The mermaid diagram should show modules as nodes with labeled edges for major data flows
- Mention which modules are "central" (high connectivity) vs "peripheral"
- Note any architectural tensions (e.g. tight coupling, circular dependencies)`
}

// ── Chat Context Prompt ────────────────────────────────

export interface ChatContext {
  level: 'system' | 'module' | 'submodule' | 'function'
  moduleName?: string
  subModuleName?: string
  functionName?: string
  filePath?: string
  currentDoc?: string
  sourceCode?: string
  decisions?: string[]
}

export function buildChatContextPrompt(
  repoName: string,
  context: ChatContext,
  history: { role: 'user' | 'assistant'; content: string }[],
  message: string,
): string {
  let contextSection = ''

  if (context.level === 'system') {
    contextSection = `The user is viewing the system-level architecture overview of "${repoName}".`
  } else if (context.level === 'module') {
    contextSection = `The user is viewing the "${context.moduleName}" module.`
  } else if (context.level === 'submodule') {
    contextSection = `The user is viewing the "${context.subModuleName}" sub-module within "${context.moduleName}".`
  } else if (context.level === 'function') {
    contextSection = `The user is viewing the function "${context.functionName}" in ${context.filePath} (part of "${context.subModuleName}" in "${context.moduleName}").`
  }

  if (context.currentDoc) {
    contextSection += `\n\nCurrent documentation:\n${context.currentDoc.slice(0, 3000)}`
  }
  if (context.sourceCode) {
    contextSection += `\n\nSource code:\n\`\`\`\n${context.sourceCode.slice(0, 2000)}\n\`\`\``
  }
  if (context.decisions && context.decisions.length > 0) {
    contextSection += `\n\nRelated design decisions:\n${context.decisions.slice(0, 5).map(d => `- ${d}`).join('\n')}`
  }

  const historySection = history.length > 0
    ? history.slice(-6).map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n\n')
    : ''

  return `You are an architecture expert answering questions about the "${repoName}" codebase.

## Current Context
${contextSection}

${historySection ? `## Conversation History\n${historySection}\n` : ''}
## User Question
${message}

Answer concisely. Reference specific modules, sub-modules, and functions by name. If you don't know something from the provided context, say so rather than guessing.`
}
