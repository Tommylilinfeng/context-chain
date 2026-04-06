/**
 * Doc Generation — Prompt Templates
 *
 * Two-level generation:
 *   1. Per sub-module: full source code → deep technical doc
 *   2. Per module: synthesize sub-module docs → module overview
 *   3. Repo overview: synthesize module docs → architecture guide
 */

// ── Sub-Module Doc ─────────────────────────────────────

export function buildSubModuleDocPrompt(
  subModuleName: string,
  subModuleDescription: string,
  parentModuleName: string,
  sourceCode: string,
  fileCount: number,
  functionCount: number,
): string {
  return `You are reading the complete source code of the "${subModuleName}" sub-module (part of "${parentModuleName}").

Sub-module description: ${subModuleDescription}
Scale: ${functionCount} functions across ${fileCount} files.

## Source Code

${sourceCode}

## Task

Write a technical document that captures what a developer needs to know about this sub-module. Length should match complexity — a 5-file utility needs 200 words, a 20-file core system needs 800+. Let the code dictate.

Focus on:
- Design decisions revealed by the code and comments — especially the WHY
- Domain concepts defined here (type systems, taxonomies, protocols, constraints)
- Non-obvious behavior, edge cases, error handling strategies
- Key type signatures and interfaces that define the contract
- Exclusion rules, invariants, "what NOT to do" — these are often more valuable than "what to do"

Do NOT:
- List every function
- Repeat information obvious from function names
- Write boilerplate introductions
- Compress important design rationale to save space — if the code has a rich comment explaining WHY, surface it fully

If you see a comment explaining WHY something is done a certain way, that's gold — surface it.

Write in Chinese. Be direct and technical. Include code snippets (actual TypeScript from the source) where they clarify a design point.

Output: Markdown (no need for mermaid at this level).`
}

// ── Module Synthesis ───────────────────────────────────

export function buildModuleSynthesisPrompt(
  moduleName: string,
  moduleDescription: string,
  subModuleDocs: { name: string; doc: string; functionCount: number; externalCallers: number }[],
  externalDeps: { dependsOn: string[]; dependedBy: string[] },
): string {
  // Sort by importance: external callers first, then function count
  const sorted = [...subModuleDocs].sort((a, b) =>
    (b.externalCallers + b.functionCount) - (a.externalCallers + a.functionCount)
  )

  // Tag each sub-module with importance
  const subDocs = sorted.map(s => {
    const tag = s.externalCallers > 10 ? '🔴 CORE PATH' :
                s.externalCallers > 3 ? '🟡 IMPORTANT' : '⚪ SUPPORTING'
    return `### ${s.name} [${tag}, ${s.functionCount} fns, ${s.externalCallers} external callers]\n\n${s.doc}`
  }).join('\n\n---\n\n')

  return `You are writing a technical guide for the "${moduleName}" module. You have detailed analysis of each sub-module below.

Module description: ${moduleDescription}

External dependencies:
- Used by: ${externalDeps.dependedBy.join(', ') || '(none)'}
- Depends on: ${externalDeps.dependsOn.join(', ') || '(none)'}

## Sub-Module Analysis (ordered by importance)

${subDocs}

## Task

Write a module guide for a developer who needs to understand and work in this module.

CRITICAL RULES:
- Do NOT organize by sub-module. Organize by **concepts that matter to the reader** — the sub-module boundary is a code organization detail, not a documentation structure.
- Spend 80% of the doc on 🔴 CORE PATH and 🟡 IMPORTANT sub-modules. ⚪ SUPPORTING sub-modules get brief mentions only.
- Start with WHY this module exists and what problem it solves, not what it contains.
- Explain the key DOMAIN CONCEPTS first (e.g., "four memory types", "permission layers"), then trace how code implements them.
- Include a mermaid diagram that shows the USER-FACING behavior flow, not the code structure.

Write in Chinese. Be direct, technical, opinionated. Include TypeScript snippets where they reveal design decisions.

Output: Markdown with \`\`\`mermaid code blocks (properly fenced with triple backticks).`
}

// ── Overview ───────────────────────────────────────────

export function buildOverviewDocPrompt(
  repoName: string,
  moduleSummaries: { name: string; summary: string }[],
  crossModuleDeps: { from: string; to: string }[],
): string {
  const moduleDocs = moduleSummaries.map(m =>
    `### ${m.name}\n\n${m.summary}`
  ).join('\n\n---\n\n')

  const depSummary = crossModuleDeps
    .map(d => `  ${d.from} → ${d.to}`)
    .join('\n')

  return `You are writing an architectural guide for the "${repoName}" project, based on detailed module documentation.

## Module Documentation (summaries)

${moduleDocs}

## Cross-Module Dependencies

${depSummary}

## Task

Write an architectural guide that answers: "How does this system work?"

This is NOT a module catalog. It IS a narrative that explains:
- What happens when a user interacts with the system — trace the full lifecycle
- What are the key architectural decisions and WHY were they made
- What patterns govern module interactions
- What would surprise a new engineer or trip them up
- Where are the critical paths that must not break

Include mermaid diagrams where they clarify flow or structure — show HOW things work, not just WHAT exists.

Write in Chinese. Be direct, technical, opinionated.

Output: Markdown with \`\`\`mermaid code blocks (properly fenced).`
}
