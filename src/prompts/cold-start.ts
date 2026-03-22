/**
 * cold-start prompt templates
 *
 * Four rounds + keyword normalization:
 *   Round 1 — Scope Selection: pick relevant files for a goal
 *   Round 2 — Triage: per-file, identify functions worth deep analysis
 *   Round 3 — Deep Analysis: per-function, extract decisions with full caller/callee context
 *   Round 4a — Grouping: cluster related decisions for relationship analysis
 *   Round 4b — Relationships: per-group, determine edge types (CAUSED_BY, DEPENDS_ON, etc.)
 *   Keyword Normalization: merge synonyms across all decisions
 */

// ─── Shared types ────────────────────────────────────────────────────────────

export interface BusinessContext {
  summary: string
  content: string
}

// ─── Round 1: Scope Selection ────────────────────────────────────────────────

export interface FileEntry {
  file: string          // e.g. "services/orderService.ts"
  functions: string[]   // e.g. ["createOrder (11-76)", "getOrderById (81-106)"]
  callers: string[]     // cross-file callers
  callees: string[]     // cross-file callees
}

export function buildScopePrompt(goal: string, files: FileEntry[]): string {
  const fileList = files.map((f, i) => {
    const fns = f.functions.length > 0
      ? `\n    Functions: ${f.functions.join(', ')}`
      : ''
    const deps = []
    if (f.callers.length > 0) deps.push(`Called by: ${f.callers.join(', ')}`)
    if (f.callees.length > 0) deps.push(`Calls: ${f.callees.join(', ')}`)
    const depStr = deps.length > 0 ? `\n    ${deps.join(' | ')}` : ''
    return `  ${i + 1}. ${f.file}${fns}${depStr}`
  }).join('\n')

  return `You are selecting which files are relevant to a development goal.

GOAL: "${goal}"

FILES IN THIS REPO:
${fileList}

Select ALL files whose functions contain design decisions relevant to this goal.
Include files that are indirectly relevant (e.g. helper functions called by core logic, error handling, data formatting).
Exclude files that are purely type definitions, re-exports, or trivial wrappers.

Return ONLY a raw JSON array of file paths (no markdown, no backticks, no explanation):
["services/orderService.ts", "logic/cart.ts"]`
}

// ─── Round 2: Triage ─────────────────────────────────────────────────────────

export interface FunctionTriageEntry {
  name: string
  lines: string        // "11-76"
  callers: string[]    // cross-file: ["services/orderService.js::createOrder"]
  callees: string[]    // cross-file: ["store/cartStore.js::formatCartItems"]
}

export function buildTriagePrompt(
  filePath: string,
  code: string,
  functions: FunctionTriageEntry[],
  businessContext: BusinessContext[],
  goal: string
): string {
  const fnList = functions.map(f => {
    const parts = [`  - ${f.name} (lines ${f.lines})`]
    const deps = []
    if (f.callers.length > 0) deps.push(`Called by: ${f.callers.join(', ')}`)
    if (f.callees.length > 0) deps.push(`Calls: ${f.callees.join(', ')}`)
    if (deps.length > 0) parts.push(`    ${deps.join(' | ')}`)
    return parts.join('\n')
  }).join('\n')

  const bizSection = businessContext.length > 0
    ? `\n## Business Context (provided by project owner):\n${businessContext.map(b => `  - ${b.summary}: ${b.content}`).join('\n')}\n`
    : ''

  return `You are triaging functions to decide which ones contain design decisions worth deep analysis.

GOAL: "${goal}"
${bizSection}
## File: ${filePath}

## Functions in this file:
${fnList}

## Source code:
${code}

## Worth investigating — functions that contain:
- Non-obvious architectural choices (WHY this approach, not another)
- Intentional trade-offs (performance vs readability, consistency vs flexibility)
- Business logic that deviates from the straightforward implementation
- Complex edge case handling with implicit reasoning
- Integration patterns with external services where alternatives existed

## NOT worth investigating:
- Standard CRUD operations or simple data fetching
- Trivial wrappers, re-exports, or simple getters/setters
- Pure UI rendering without meaningful business logic
- Boilerplate (standard error handling, basic validation, formatting)
- Functions that just call through to another function without adding logic

Return ONLY a raw JSON array of function names worth deep analysis (no markdown, no backticks, no explanation).
Empty array [] if nothing in this file is worth investigating.
["functionA", "functionB"]`
}

// ─── Round 3: Deep Analysis ──────────────────────────────────────────────────

export interface CallerCalleeCode {
  name: string
  filePath: string
  code: string
}

export function buildDeepAnalysisPrompt(
  fnName: string,
  fnCode: string,
  filePath: string,
  callers: CallerCalleeCode[],
  callees: CallerCalleeCode[],
  businessContext: BusinessContext[],
  goal: string
): string {
  const callerSection = callers.length > 0
    ? `\n## Functions that CALL ${fnName} (upstream — why they need this function):\n${callers.map(c =>
        `### ${c.filePath}::${c.name}\n\`\`\`\n${c.code}\n\`\`\``
      ).join('\n\n')}\n`
    : ''

  const calleeSection = callees.length > 0
    ? `\n## Functions that ${fnName} CALLS (downstream — what it depends on):\n${callees.map(c =>
        `### ${c.filePath}::${c.name}\n\`\`\`\n${c.code}\n\`\`\``
      ).join('\n\n')}\n`
    : ''

  const bizSection = businessContext.length > 0
    ? `\n## Business Context & Spec (provided by project owner):\n${businessContext.map(b => `  - ${b.summary}: ${b.content}`).join('\n')}\n`
    : ''

  return `You are doing a deep analysis of a single function to extract design decisions.

GOAL: "${goal}"
${bizSection}
## Target function: ${fnName} (file: ${filePath})
\`\`\`
${fnCode}
\`\`\`
${callerSection}${calleeSection}
## Instructions

Analyze ${fnName} and its relationship with its callers and callees. Extract 1-3 design decisions.

A design decision explains:
- WHY this approach was chosen over alternatives
- WHAT trade-offs were made and what was sacrificed
- WHAT alternatives were considered or could have been chosen
- WHY edge cases are handled in a specific way

Also classify each finding:
- **decision**: Intentional, reasonable design choice. The developer chose this for a reason.
- **suboptimal**: Works correctly but there's a significantly better approach. Explain what and why. Only flag if the improvement is significant — not nitpicks.
- **bug**: Behavior does NOT match expected business logic${businessContext.length > 0 ? ' (see Business Context above)' : ''}. Be specific about expected vs actual behavior.

Default to "decision" unless you have clear evidence otherwise.

## Good example:
{
  "function": "createOrder",
  "related_functions": ["formatCartItemsForOrder", "place_order"],
  "summary": "createOrder 把所有下单逻辑（库存扣减、订单创建、coupon核销）放在 PostgreSQL RPC 而非应用层，用数据库事务保证原子性，代价是业务逻辑分散在前端和数据库两个 repo",
  "content": "createOrder 没有直接操作数据库表，而是调 Supabase RPC（place_order）把所有下单逻辑放在 PostgreSQL 函数里。这个决策让原子性由数据库层保证——库存扣减、订单创建、coupon 核销在同一个事务内完成，不需要应用层实现分布式事务。代价是业务逻辑分散在前端 repo 和数据库 repo 两个地方，调试需要切换上下文。",
  "keywords": ["RPC", "place_order", "Supabase", "原子性", "PostgreSQL", "事务"],
  "finding_type": "decision"
}

## Bad example (too descriptive, no WHY):
{
  "summary": "createOrder calls the place_order RPC",
  "content": "The createOrder function calls supabase.rpc('place_order') to create an order."
}

Return ONLY a raw JSON array. Empty array [] if no decisions worth recording:
[{
  "function": "${fnName}",
  "related_functions": ["otherFunc1", "otherFunc2"],
  "summary": "20-50 words — state the decision with enough context for someone to understand without seeing the code",
  "content": "200-600 chars explaining WHY, trade-offs, alternatives considered",
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "finding_type": "decision|suboptimal|bug",
  "critique": "only for suboptimal/bug — what's wrong and what should it be"
}]

IMPORTANT:
- "related_functions" lists OTHER functions (callers, callees, or same-file) affected by this decision.
- "finding_type" defaults to "decision". Only use "suboptimal"/"bug" with clear evidence.
- "critique" is required for suboptimal/bug, omit entirely for decision.`
}

// ─── Round 4a: Relationship Triage (grouping) ──────────────────────────────

export interface DecisionSummaryForGrouping {
  id: string
  function: string
  file: string
  summary: string
  keywords: string[]
}

export function buildGroupingPrompt(
  decisions: DecisionSummaryForGrouping[],
  cpgHints: string[],  // e.g. ["createOrder CALLS formatCartItems", "applyCoupon CALLS validateCoupon"]
): string {
  const decisionList = decisions.map((d, i) =>
    `  ${i + 1}. [${d.id}] ${d.file}::${d.function}\n     ${d.summary}\n     Keywords: ${d.keywords.join(', ')}`
  ).join('\n')

  const cpgSection = cpgHints.length > 0
    ? `\n## Code structure hints (from static analysis):\n${cpgHints.map(h => `  - ${h}`).join('\n')}\n`
    : ''

  return `You are analyzing relationships between design decisions extracted from a codebase.

## All decisions:
${decisionList}
${cpgSection}
## Task

Group decisions that are meaningfully related to each other. A group means these decisions should be analyzed together because they:
- Form a causal chain (A led to B, B depends on A)
- Are in tension or conflict (A and B are both reasonable but create a trade-off together)
- Co-depend on shared context (understanding A requires understanding B)
- Are different aspects of the same architectural choice

A decision can appear in multiple groups. Do NOT group decisions just because they are in the same file or have overlapping keywords — the relationship must be about design reasoning, not proximity.

Return ONLY raw JSON (no markdown, no backticks):
[
  {
    "group": ["decision_id_1", "decision_id_2", "decision_id_3"],
    "reason": "brief explanation of why these are related"
  }
]

Return empty array [] if no meaningful groups exist.`
}

// ─── Round 4b: Relationship Deep Analysis (per group) ───────────────────

export interface DecisionFullContent {
  id: string
  function: string
  file: string
  summary: string
  content: string
  keywords: string[]
}

export function buildRelationshipPrompt(
  decisions: DecisionFullContent[],
  groupReason: string
): string {
  const decisionList = decisions.map((d, i) =>
    `### ${i + 1}. [${d.id}] ${d.file}::${d.function}\n**Summary:** ${d.summary}\n**Detail:** ${d.content}\n**Keywords:** ${d.keywords.join(', ')}`
  ).join('\n\n')

  return `You are determining the exact relationships between a group of related design decisions.

Group context: ${groupReason}

## Decisions in this group:

${decisionList}

## Task

For each pair that has a meaningful relationship, specify the relationship type and direction:

- **CAUSED_BY**: Decision A exists because of Decision B. B is the reason A was made.
- **DEPENDS_ON**: Decision A assumes Decision B is true. If B changes, A might need to change.
- **CONFLICTS_WITH**: Decisions A and B are both reasonable individually, but together they create tension or a trade-off that developers should be aware of.
- **CO_DECIDED**: A and B were made together as parts of the same architectural choice. They don't have a directional relationship but are a package deal.

Only output relationships you are confident about. "from" is the decision that depends on / is caused by / conflicts with the "to" decision.

Return ONLY raw JSON (no markdown, no backticks):
{
  "edges": [
    {
      "from": "decision_id",
      "to": "decision_id",
      "type": "CAUSED_BY|DEPENDS_ON|CONFLICTS_WITH|CO_DECIDED",
      "reason": "one sentence explaining this specific relationship"
    }
  ]
}

Return {"edges": []} if no confident relationships exist.`
}

// ─── Keyword Normalization (lightweight, single call) ────────────────

export function buildKeywordNormalizationPrompt(allKeywords: string[]): string {
  const unique = [...new Set(allKeywords)].sort()
  return `You are normalizing keywords extracted from design decisions in a codebase.

Here are all unique keywords currently in use:
${unique.map(k => `  - ${k}`).join('\n')}

## Task

Find groups of keywords that refer to the same concept but use different terms (synonyms, translations, abbreviations). For each group, pick the best canonical form.

Rules:
- Only group keywords that truly mean the same thing in this codebase context
- Chinese and English terms for the same concept should be grouped (e.g. "认证" and "auth")
- Abbreviations should be grouped with full forms (e.g. "tx" and "transaction")
- Do NOT group keywords that are merely related (e.g. "订单" and "支付" are related but not synonyms)

Return ONLY raw JSON (no markdown, no backticks):
[
  {"canonical": "best_term", "aliases": ["synonym1", "synonym2"]}
]

Return empty array [] if no normalization needed.`
}

// ─── PromptBuilders: 可插拔 prompt 模板集合 ────────────────────────────────

export interface PromptBuilders {
  scope: typeof buildScopePrompt
  triage: typeof buildTriagePrompt
  deepAnalysis: typeof buildDeepAnalysisPrompt
  grouping: typeof buildGroupingPrompt
  relationship: typeof buildRelationshipPrompt
  keywordNormalization: typeof buildKeywordNormalizationPrompt
}

export const defaultPromptBuilders: PromptBuilders = {
  scope: buildScopePrompt,
  triage: buildTriagePrompt,
  deepAnalysis: buildDeepAnalysisPrompt,
  grouping: buildGroupingPrompt,
  relationship: buildRelationshipPrompt,
  keywordNormalization: buildKeywordNormalizationPrompt,
}
