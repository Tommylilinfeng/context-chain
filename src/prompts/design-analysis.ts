/**
 * Design Analysis — Types + Prompt Templates
 *
 * Layers 2-5 of the design analysis pipeline:
 *   Layer 2:   Sub-Module Decomposition (AI per module, many-to-many)
 *   Layer 2.5: Misassigned Reassignment (single AI call)
 *   Layer 4:   Theme + DesignChoice (AI per sub-module)
 *   Layer 5:   Cross-Module Theme Merge (single AI call)
 */

// ── Layer 2: Sub-Module Types ───────────────────────────

export interface SubModuleInput {
  moduleName: string
  moduleId: string
  moduleDescription: string
  functions: { name: string; filePath: string; sourceCode?: string }[]
  internalCallEdges: string[]  // "caller -> callee"
}

export interface SubModuleProposal {
  subModuleId: string
  name: string
  description: string
  functionNames: string[]   // may overlap across sub-modules (many-to-many)
  confidence: number
}

export interface MisassignedFlag {
  functionName: string
  reason: string
  suggestedModule?: string
}

export interface SubModuleOutput {
  subModules: SubModuleProposal[]
  misassigned: MisassignedFlag[]
}

// ── Layer 2.5: Misassigned Reassignment Types ───────────

export interface MisassignedFunction {
  functionKey: string       // "filePath::functionName"
  sourceModuleId: string
  sourceModuleName: string
  reason: string
  suggestedModule?: string
}

export interface Reassignment {
  functionKey: string
  targetModuleId: string
  reasoning: string
}

export interface ReassignmentOutput {
  reassignments: Reassignment[]
  infrastructure: { functionKey: string; reasoning: string }[]
}

// ── Layer 4: Theme + DesignChoice Types ─────────────────

export interface DecisionForAnalysis {
  id: string
  summary: string
  content: string
  anchorFunction?: string
  anchorFile?: string
}

export interface DesignChoiceProposal {
  choiceId: string
  name: string
  description: string
  decisionIds: string[]
}

export interface ThemeProposal {
  themeId: string
  name: string
  description: string
  choiceIds: string[]
}

export interface ThemeAnalysisOutput {
  designChoices: DesignChoiceProposal[]
  themes: ThemeProposal[]
}

// ── Layer 5: Cross-Module Theme Merge Types ─────────────

export interface LocalThemeForMerge {
  themeId: string
  name: string
  description: string
  sourceSubModule: string
  sourceModule: string
}

export interface GlobalThemeProposal {
  globalThemeId: string
  name: string
  description: string
  mergedLocalThemeIds: string[]
}

export interface CrossModuleMergeOutput {
  globalThemes: GlobalThemeProposal[]
}

// ── Pipeline Result ─────────────────────────────────────

export interface DesignAnalysisResult {
  layer2: {
    subModulesCreated: number
    misassignedCount: number
    tokens: number
  }
  layer2_5: {
    reassigned: number
    infrastructure: number
    tokens: number
  }
  totalTokens: number
  durationMs: number
}

// ── Prompt Builders ─────────────────────────────────────

export function buildSubModulePrompt(input: SubModuleInput): string {
  const hasSource = input.functions.some(fn => fn.sourceCode)

  // Group functions by file (last 2 path segments for compactness)
  const byFile = new Map<string, typeof input.functions>()
  for (const fn of input.functions) {
    const parts = fn.filePath.split('/')
    const key = parts.slice(-2).join('/')
    if (!byFile.has(key)) byFile.set(key, [])
    byFile.get(key)!.push(fn)
  }

  let functionSection: string
  if (hasSource) {
    // Rich format: source code per function, grouped by file
    const fileSections = Array.from(byFile.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .map(([file, fns]) => {
        const fnBlocks = fns.map(fn => {
          if (fn.sourceCode) {
            return `### ${fn.name}\n\`\`\`\n${fn.sourceCode}\n\`\`\``
          }
          return `### ${fn.name}\n(no source available)`
        }).join('\n\n')
        return `## ${file}\n\n${fnBlocks}`
      })
      .join('\n\n')
    functionSection = fileSections
  } else {
    // Compact format: name-only
    const entries = Array.from(byFile.entries())
      .sort((a, b) => b[1].length - a[1].length)
    const isLarge = input.functions.length > 300
    functionSection = entries
      .map(([file, fns]) => {
        const names = fns.map(f => f.name)
        if (isLarge && names.length > 8) {
          return `${file} (${names.length}): ${names.slice(0, 8).join(', ')}, ...`
        }
        return `${file}: ${names.join(', ')}`
      })
      .join('\n')
  }

  const maxEdges = input.functions.length > 300 ? 80 : 150
  const callEdges = input.internalCallEdges.slice(0, maxEdges)
    .map(e => `  ${e}`)
    .join('\n')

  return `You are decomposing the semantic module "${input.moduleName}" into sub-modules.

Module description: ${input.moduleDescription}

## Functions (${input.functions.length} total, grouped by file):

${functionSection}

## Internal call edges (sample):

${callEdges}

## Task

Identify cohesive sub-modules within this module. Each sub-module should represent a distinct responsibility.

A function CAN belong to multiple sub-modules if it genuinely serves multiple responsibilities within this module — list it in all relevant sub-modules.

Also flag any functions that appear misassigned — they don't belong in the "${input.moduleName}" module at all.

Return ONLY raw JSON (no markdown, no backticks):
{
  "subModules": [
    {
      "subModuleId": "submod_1",
      "name": "2-5 word name",
      "description": "1-2 sentences: what this sub-module does",
      "functionNames": ["fn1", "fn2"],
      "confidence": 0.85
    }
  ],
  "misassigned": [
    {
      "functionName": "someFunc",
      "reason": "why it doesn't belong in ${input.moduleName}",
      "suggestedModule": "optional: which module it likely belongs to"
    }
  ]
}

Guidelines:
- Sub-modules should have 3+ functions; avoid singletons
- If fewer than 5 sub-modules make sense, that's fine (minimum 2)
- Name sub-modules by their responsibility, not by file/directory
- Shared utility functions within the module can belong to multiple sub-modules
- Only flag misassigned if the function CLEARLY and OBVIOUSLY does not belong in this module — be very conservative
- If a function could arguably belong here even tangentially, keep it — do NOT flag it
- Typical misassigned rate should be under 5% of functions; if you're flagging more than 10%, you're being too aggressive`
}

export function buildMisassignedReassignmentPrompt(
  misassigned: MisassignedFunction[],
  allModules: { moduleId: string; name: string; description: string }[],
): string {
  const moduleList = allModules
    .map(m => `  ${m.moduleId}: ${m.name} — ${m.description}`)
    .join('\n')

  const fnList = misassigned
    .map(f => `  ${f.functionKey}
    from: ${f.sourceModuleName} (${f.sourceModuleId})
    reason: ${f.reason}${f.suggestedModule ? `\n    suggested: ${f.suggestedModule}` : ''}`)
    .join('\n\n')

  return `You are reassigning functions that were flagged as misassigned during sub-module decomposition.

## All Available Modules

${moduleList}

## Misassigned Functions (${misassigned.length} total)

${fnList}

## Task

For each function, decide:
1. **Reassign** to the correct module (pick from the list above)
2. **Infrastructure** — the function is a shared utility that doesn't belong to any specific module

Return ONLY raw JSON (no markdown, no backticks):
{
  "reassignments": [
    {
      "functionKey": "path/file.ts::functionName",
      "targetModuleId": "mod_3",
      "reasoning": "brief explanation"
    }
  ],
  "infrastructure": [
    {
      "functionKey": "path/file.ts::functionName",
      "reasoning": "why this is shared infrastructure"
    }
  ]
}

Guidelines:
- Prefer reassignment over infrastructure — most functions belong somewhere
- Use the suggestedModule hint when available, but verify it makes sense
- Infrastructure is for true cross-cutting utilities (logging, hashing, env detection)`
}

export function buildThemeAnalysisPrompt(
  subModuleName: string,
  parentModuleName: string,
  decisions: DecisionForAnalysis[],
): string {
  const decisionList = decisions.map((d, i) =>
    `### ${i + 1}. [${d.id}]${d.anchorFile ? ` ${d.anchorFile}` : ''}${d.anchorFunction ? `::${d.anchorFunction}` : ''}
**Summary:** ${d.summary}
**Detail:** ${d.content}`
  ).join('\n\n')

  return `You are analyzing design decisions within the sub-module "${subModuleName}" (part of module "${parentModuleName}").

## Decisions (${decisions.length} total):

${decisionList}

## Task

Organize these decisions into two layers:

1. **DesignChoice**: Group closely related decisions (2-8 each) into a concrete design choice — a specific technical decision that was made (e.g., "token-based auth with refresh rotation", "event-driven file watcher with debounce").

2. **Theme**: Group related design choices (2-10 each) into a broader design theme — an architectural area or concern (e.g., "Authentication Strategy", "File System Management").

Return ONLY raw JSON (no markdown, no backticks):
{
  "designChoices": [
    {
      "choiceId": "choice_1",
      "name": "concise name for the specific design choice",
      "description": "1-2 sentences: what was decided and why",
      "decisionIds": ["dec_xxx", "dec_yyy"]
    }
  ],
  "themes": [
    {
      "themeId": "theme_1",
      "name": "2-5 word theme name",
      "description": "1-2 sentences: what architectural area this covers",
      "choiceIds": ["choice_1", "choice_2"]
    }
  ]
}

Guidelines:
- Every decision must belong to exactly one design choice
- Every design choice must belong to exactly one theme
- If there are only 2-3 decisions, create 1 design choice and 1 theme
- Design choice names should be specific and concrete
- Theme names should be broad architectural areas
- Do not create themes with only 1 design choice unless there are very few decisions overall`
}

export function buildCrossModuleMergePrompt(
  themes: LocalThemeForMerge[],
): string {
  const themeList = themes
    .map(t => `  ${t.themeId}: "${t.name}" (${t.sourceModule} > ${t.sourceSubModule})
    ${t.description}`)
    .join('\n\n')

  return `You are identifying cross-cutting design themes across an entire codebase.

Below are all local design themes discovered within individual sub-modules:

${themeList}

## Task

Merge themes that represent the same architectural concern appearing in different modules. These are cross-cutting concerns.

Return ONLY raw JSON (no markdown, no backticks):
{
  "globalThemes": [
    {
      "globalThemeId": "gtheme_1",
      "name": "canonical theme name",
      "description": "1-2 sentences covering the global scope of this theme",
      "mergedLocalThemeIds": ["theme_x", "theme_y", "theme_z"]
    }
  ]
}

Guidelines:
- Themes that appear in only one sub-module: include as-is (mergedLocalThemeIds has 1 entry)
- Merge ONLY if they represent the SAME concern, not merely related topics
- Cross-cutting concerns (error handling, caching, auth, logging) are prime merge candidates
- The global theme name should generalize across the merged local themes
- Every local theme must appear in exactly one global theme's mergedLocalThemeIds`
}
