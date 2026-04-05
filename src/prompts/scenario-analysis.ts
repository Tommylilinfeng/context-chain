/**
 * Scenario Analysis — Types + Prompt Templates
 *
 * Identifies typical user scenarios from the sub-module call graph
 * and traces data flow through sub-modules for each scenario.
 */

// ── Input Types ────────────────────────────────────────

export interface ScenarioInput {
  repoName: string
  subModules: {
    id: string
    name: string
    description: string
    parentModule: string    // parent SemanticModule name
    parentModuleId: string
    fnCount: number
  }[]
  subModuleEdges: {
    sourceId: string
    sourceName: string
    targetId: string
    targetName: string
    weight: number
  }[]
  entryHints: string[]  // submodule IDs that look like entry points
}

// ── Output Types ───────────────────────────────────────

export interface ScenarioStep {
  subModuleId: string
  order: number
  role: 'entry' | 'processing' | 'decision' | 'output' | 'cross-cutting'
  description: string
}

export interface ScenarioFlowEdge {
  from: string   // subModuleId
  to: string     // subModuleId
  label: string  // what data/control flows
}

export interface ScenarioProposal {
  scenarioId: string
  name: string
  description: string
  category: string
  confidence: number
  steps: ScenarioStep[]
  flowEdges: ScenarioFlowEdge[]
}

export interface ScenarioDiscoveryOutput {
  scenarios: ScenarioProposal[]
}

// ── Result Types ───────────────────────────────────────

export interface ScenarioAnalysisResult {
  subModuleEdges: number
  scenariosCreated: number
  totalSteps: number
  totalFlowEdges: number
  tokens: number
  durationMs: number
}

// ── Prompt Builder ─────────────────────────────────────

export function buildScenarioDiscoveryPrompt(input: ScenarioInput): string {
  // Sub-module list: compact format with parent module context
  const subModuleSection = input.subModules
    .map(sm => `- [${sm.id}] "${sm.name}" (${sm.fnCount} fns, module: ${sm.parentModule}) — ${sm.description}`)
    .join('\n')

  // Call edges: top edges by weight, compact format
  const maxEdges = Math.min(input.subModuleEdges.length, 200)
  const edgeSection = input.subModuleEdges
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxEdges)
    .map(e => `  ${e.sourceName} -> ${e.targetName} (${e.weight} calls)`)
    .join('\n')

  // Entry hints
  const entrySection = input.entryHints.length > 0
    ? input.entryHints.join(', ')
    : '(none detected — infer from the call graph structure)'

  return `You are analyzing the architecture of "${input.repoName}" to identify typical user scenarios and trace data flow.

## Sub-Modules (${input.subModules.length} total):

${subModuleSection}

## Sub-Module Call Edges (${input.subModuleEdges.length} total, top ${maxEdges} by weight):

${edgeSection}

## Entry Point Hints:

${entrySection}

## Task

Identify 5-15 typical **user scenarios** — concrete actions a user or external system triggers that cause data to flow through multiple sub-modules. Think about what the end user actually does with this software.

For each scenario:
1. List the participating sub-modules **in execution order**
2. Assign each a role: "entry" (where the scenario starts), "processing" (core logic), "decision" (branching/routing), "output" (final result/side-effect), or "cross-cutting" (auth, logging, etc. that gets called but isn't on the main path)
3. Define directed flow edges between participating sub-modules with a label describing what flows

Important:
- Scenarios should be **distinct** — each covers a meaningfully different code path
- A sub-module can appear in multiple scenarios with different roles
- flowEdges should only connect sub-modules that are both in this scenario's steps
- Use the EXACT sub-module IDs from the list above (the bracketed [id] values)
- cross-cutting sub-modules don't need strict ordering; use order = 99

Return ONLY raw JSON (no markdown, no backticks):
{
  "scenarios": [
    {
      "scenarioId": "short_slug",
      "name": "Human-readable name",
      "description": "1-3 sentences describing what the user does and what happens",
      "category": "cli_command | agent_tool | protocol | lifecycle | error_handling | configuration",
      "confidence": 0.85,
      "steps": [
        { "subModuleId": "sub_...", "order": 1, "role": "entry", "description": "what this step does" }
      ],
      "flowEdges": [
        { "from": "sub_...", "to": "sub_...", "label": "what data/control flows" }
      ]
    }
  ]
}

Guidelines:
- Focus on scenarios that are **observable by the user**, not internal implementation details
- Include at least one "happy path" scenario for each major feature area
- Include 1-2 error/edge-case scenarios if the call graph suggests them
- Each scenario should have 3-10 steps (not too granular, not too coarse)
- Prefer fewer, well-defined scenarios over many vague ones`
}
