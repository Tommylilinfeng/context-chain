/**
 * core/analyze-function.ts
 *
 * 核心 building block：分析单个函数，提取设计决策。
 *
 * 这是整个系统最重要的模块。所有的 pipeline（full-scan、
 * session ingestion）最终都通过这个模块来生成 DecisionContext。
 *
 * 用法：
 *   import { analyzeFunction } from '../core/analyze-function'
 *
 *   const result = await analyzeFunction(
 *     { functionName: 'createOrder', filePath: 'store/orderStore.js', repo: 'bite-me-website', repoPath: '/path/to/repo' },
 *     { caller_depth: 2, include_table_access: true }  // 部分覆盖，其余用模板默认值
 *   )
 */

import path from 'path'
import { Session } from 'neo4j-driver'
import { getSession, verifyConnectivity } from '../db/client'
import { createAIProvider, AIProvider } from '../ai'
import { loadConfig } from '../config'
import { loadTemplate } from './template-loader'
import {
  AnalyzeFunctionConfig, AnalyzeFunctionInput, AnalyzeFunctionResult,
  PendingDecisionOutput, ExtractedDecision, CodeSnippet, FunctionContext,
  AdvancedRoundOutput, AdvancedRoundLog, ContextRequest, AdvancedContextModules,
} from './types'
import {
  extractFunctionCode, readFullFile, resolveSourcePath,
  parseJsonSafe, toNum,
} from '../ingestion/shared'
import type { RelationshipBatch } from './batch-grouping'

const DEBUG = process.env.CKG_DEBUG === '1'

// ── Graph queries ───────────────────────────────────────

interface FunctionNode {
  name: string
  filePath: string
  lineStart: number
  lineEnd: number
  repo: string
}

/** 获取目标函数的行号（如果 input 没提供） */
async function getFunctionLineRange(
  session: Session, functionName: string, filePath: string, repo: string
): Promise<{ lineStart: number; lineEnd: number } | null> {
  try {
    const result = await session.run(
      `MATCH (f:CodeEntity {entity_type: 'file', path: $filePath, repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function', name: $fnName})
       RETURN fn.line_start AS ls, fn.line_end AS le`,
      { filePath, repo, fnName: functionName }
    )
    if (result.records.length === 0) return null
    return {
      lineStart: toNum(result.records[0].get('ls')),
      lineEnd: toNum(result.records[0].get('le')),
    }
  } catch { return null }
}

/** 获取 N 层 callers，逐层展开 */
async function getCallersMultiLevel(
  session: Session, functionName: string, filePath: string, repo: string,
  depth: number, maxPerLevel: number, includeCrossRepo: boolean
): Promise<FunctionNode[][]> {
  if (depth === 0) return []
  if (DEBUG) console.log(`  [DEBUG] getCallersMultiLevel: fn=${functionName} file=${filePath} repo=${repo} depth=${depth}`)

  const levels: FunctionNode[][] = []
  let currentNames = [functionName]
  let currentPaths = [filePath]
  const seen = new Set([`${filePath}::${functionName}`])

  for (let level = 0; level < depth; level++) {
    const levelNodes: FunctionNode[] = []

    for (let i = 0; i < currentNames.length; i++) {
      try {
        const repoFilter = includeCrossRepo ? '' : 'AND caller.repo = $repo'
        const result = await session.run(
          `MATCH (caller:CodeEntity {entity_type: 'function'})-[:CALLS]->(callee:CodeEntity {entity_type: 'function', name: $fnName})
           MATCH (calleeFile:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(callee)
           MATCH (callerFile:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(caller)
           WHERE caller.name <> ':program' ${repoFilter}
           RETURN DISTINCT caller.name AS name, callerFile.path AS callerPath,
                  caller.line_start AS ls, caller.line_end AS le, caller.repo AS callerRepo
           LIMIT ${maxPerLevel}`,
          { fnName: currentNames[i], filePath: currentPaths[i], repo }
        )

        if (DEBUG) console.log(`  [DEBUG] callers raw: ${result.records.length} records for ${currentNames[i]}`)
        for (const r of result.records) {
          const key = `${r.get('callerPath')}::${r.get('name')}`
          if (seen.has(key)) continue
          seen.add(key)
          levelNodes.push({
            name: r.get('name'),
            filePath: r.get('callerPath'),
            lineStart: toNum(r.get('ls')),
            lineEnd: toNum(r.get('le')),
            repo: r.get('callerRepo') ?? repo,
          })
        }
      } catch (e: any) {
        console.log(`  ⚠️ callers query failed for ${currentNames[i]}: ${e.message}`)
      }
    }

    if (levelNodes.length === 0) break
    levels.push(levelNodes)
    currentNames = levelNodes.map(n => n.name)
    currentPaths = levelNodes.map(n => n.filePath)
  }

  return levels
}

/** 获取 N 层 callees，逐层展开 */
async function getCalleesMultiLevel(
  session: Session, functionName: string, filePath: string, repo: string,
  depth: number, maxPerLevel: number, includeCrossRepo: boolean
): Promise<FunctionNode[][]> {
  if (depth === 0) return []

  const levels: FunctionNode[][] = []
  let currentNames = [functionName]
  let currentPaths = [filePath]
  const seen = new Set([`${filePath}::${functionName}`])

  for (let level = 0; level < depth; level++) {
    const levelNodes: FunctionNode[] = []

    for (let i = 0; i < currentNames.length; i++) {
      try {
        const repoFilter = includeCrossRepo ? '' : 'AND callee.repo = $repo'
        const result = await session.run(
          `MATCH (caller:CodeEntity {entity_type: 'function', name: $fnName})-[:CALLS]->(callee:CodeEntity {entity_type: 'function'})
           MATCH (callerFile:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(caller)
           MATCH (calleeFile:CodeEntity {entity_type: 'file'})-[:CONTAINS]->(callee)
           WHERE callee.name <> ':program' ${repoFilter}
           RETURN DISTINCT callee.name AS name, calleeFile.path AS calleePath,
                  callee.line_start AS ls, callee.line_end AS le, callee.repo AS calleeRepo
           LIMIT ${maxPerLevel}`,
          { fnName: currentNames[i], filePath: currentPaths[i], repo }
        )

        for (const r of result.records) {
          const key = `${r.get('calleePath')}::${r.get('name')}`
          if (seen.has(key)) continue
          seen.add(key)
          levelNodes.push({
            name: r.get('name'),
            filePath: r.get('calleePath'),
            lineStart: toNum(r.get('ls')),
            lineEnd: toNum(r.get('le')),
            repo: r.get('calleeRepo') ?? repo,
          })
        }
      } catch (e: any) {
        console.log(`  ⚠️ callees query failed for ${currentNames[i]}: ${e.message}`)
      }
    }

    if (levelNodes.length === 0) break
    levels.push(levelNodes)
    currentNames = levelNodes.map(n => n.name)
    currentPaths = levelNodes.map(n => n.filePath)
  }

  return levels
}

/** 获取函数访问的数据库表 */
async function getTableAccess(
  session: Session, functionName: string, filePath: string, repo: string
): Promise<string[]> {
  try {
    const result = await session.run(
      `MATCH (fn:CodeEntity {entity_type: 'function', name: $fnName, repo: $repo})-[:ACCESSES_TABLE]->(t:CodeEntity)
       MATCH (f:CodeEntity {entity_type: 'file', path: $filePath})-[:CONTAINS]->(fn)
       RETURN DISTINCT t.name AS tableName`,
      { fnName: functionName, filePath, repo }
    )
    return result.records.map(r => r.get('tableName') as string)
  } catch { return [] }
}

/** 获取同文件内其他函数签名 */
async function getFileContext(
  session: Session, filePath: string, repo: string, excludeFn: string
): Promise<string[]> {
  try {
    const result = await session.run(
      `MATCH (f:CodeEntity {entity_type: 'file', path: $filePath, repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
       WHERE fn.name <> ':program' AND fn.name <> $excludeFn
       RETURN fn.name AS name, fn.line_start AS ls, fn.line_end AS le
       ORDER BY fn.line_start`,
      { filePath, repo, excludeFn }
    )
    return result.records.map(r => {
      const name = r.get('name')
      const ls = toNum(r.get('ls'))
      const le = toNum(r.get('le'))
      return `${name}() [lines ${ls}-${le}]`
    })
  } catch { return [] }
}

/** 获取 business context */
async function getBusinessContext(
  session: Session
): Promise<{ summary: string; content: string }[]> {
  try {
    const result = await session.run(
      `MATCH (d:DecisionContext {source: 'manual_business_context'})
       RETURN d.summary AS summary, d.content AS content
       ORDER BY d.updated_at DESC`
    )
    return result.records.map(r => ({
      summary: r.get('summary') as string,
      content: r.get('content') as string,
    }))
  } catch { return [] }
}

// ── Code extraction ─────────────────────────────────────

function extractCode(
  repoPath: string, node: FunctionNode,
  mode: 'full' | 'truncated' | 'signature_only' | 'name_only',
  maxLines: number
): string | null {
  if (mode === 'name_only') return null  // 只需要名字，不需要代码

  const code = extractFunctionCode(repoPath, node.filePath, node.lineStart, node.lineEnd)
  if (!code) return null

  if (mode === 'signature_only') {
    // 取前 5 行作为签名（通常包含函数声明和参数）
    return code.split('\n').slice(0, 5).join('\n') + '\n// ...'
  }

  if (mode === 'truncated') {
    const lines = code.split('\n')
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n// [truncated at ${maxLines} lines, total ${lines.length}]`
    }
  }

  return code
}

function resolveRepoPath(repo: string, inputRepoPath: string): string {
  // 如果 input 给了 repoPath 直接用，否则从 config 找
  if (inputRepoPath) return inputRepoPath
  try {
    const config = loadConfig()
    const repoConfig = config.repos.find((r: any) => r.name === repo)
    return repoConfig?.path ?? ''
  } catch { return '' }
}

// ── Prompt building ─────────────────────────────────────

function buildPrompt(
  input: AnalyzeFunctionInput,
  config: AnalyzeFunctionConfig,
  context: FunctionContext
): string {
  // 如果用户提供了自定义模板，使用模板渲染
  if (config.prompt_template) {
    return renderPromptTemplate(config.prompt_template, input, config, context)
  }

  // 否则使用内置默认 prompt
  return buildDefaultPrompt(input, config, context)
}

function renderPromptTemplate(
  template: string,
  input: AnalyzeFunctionInput,
  config: AnalyzeFunctionConfig,
  context: FunctionContext
): string {
  const vars: Record<string, string> = {
    functionName: input.functionName,
    filePath: input.filePath,
    repo: input.repo,
    goal: input.goal ?? '',
    functionCode: context.targetCode,
    callerSection: formatCallerSection(input.functionName, context.callers),
    calleeSection: formatCalleeSection(input.functionName, context.callees),
    businessContext: formatBusinessContext(context.businessContext),
    customContext: config.custom_context ?? '',
    tableAccess: context.tableAccess?.length ? `Tables accessed: ${context.tableAccess.join(', ')}` : '',
    fileContext: context.fileContext?.length ? `Other functions in this file: ${context.fileContext.join(', ')}` : '',
    findingTypes: config.finding_types.join(', '),
    maxDecisions: String(config.max_decisions),
    language: config.language === 'zh' ? 'Chinese' : config.language === 'en' ? 'English' : 'the same language as the code comments',
  }

  let result = template
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{{${key}}}`).join(value)
  }
  return result
}

function formatCallerSection(fnName: string, callers: CodeSnippet[]): string {
  if (callers.length === 0) return ''
  return `\n## Functions that CALL ${fnName} (upstream):\n${callers.map(c =>
    c.code
      ? `### ${c.filePath}::${c.name}\n\`\`\`\n${c.code}\n\`\`\``
      : `### ${c.filePath}::${c.name} (code not loaded)`
  ).join('\n\n')}\n`
}

function formatCalleeSection(fnName: string, callees: CodeSnippet[]): string {
  if (callees.length === 0) return ''
  return `\n## Functions that ${fnName} CALLS (downstream):\n${callees.map(c =>
    c.code
      ? `### ${c.filePath}::${c.name}\n\`\`\`\n${c.code}\n\`\`\``
      : `### ${c.filePath}::${c.name} (code not loaded)`
  ).join('\n\n')}\n`
}

function formatBusinessContext(ctx?: { summary: string; content: string }[]): string {
  if (!ctx || ctx.length === 0) return ''
  return `\n## Business Context:\n${ctx.map(b => `  - ${b.summary}: ${b.content}`).join('\n')}\n`
}

function buildDefaultPrompt(
  input: AnalyzeFunctionInput,
  config: AnalyzeFunctionConfig,
  context: FunctionContext
): string {
  const goalSection = input.goal ? `GOAL: "${input.goal}"\n` : ''
  const bizSection = formatBusinessContext(context.businessContext)
  const callerSection = formatCallerSection(input.functionName, context.callers)
  const calleeSection = formatCalleeSection(input.functionName, context.callees)
  const customSection = config.custom_context ? `\n## Additional Context:\n${config.custom_context}\n` : ''
  const tableSection = context.tableAccess?.length
    ? `\n## Database tables accessed: ${context.tableAccess.join(', ')}\n`
    : ''
  const fileCtxSection = context.fileContext?.length
    ? `\n## Other functions in same file: ${context.fileContext.join(', ')}\n`
    : ''

  const findingTypeDesc = config.finding_types.includes('bug') || config.finding_types.includes('suboptimal')
    ? `\nAlso classify each finding:
- **decision**: Intentional, reasonable design choice.
- **suboptimal**: Works correctly but there's a significantly better approach.
- **bug**: Behavior does NOT match expected business logic.
Default to "decision" unless you have clear evidence otherwise.`
    : ''

  const summaryGuide = config.summary_length === 'short' ? '10-25 words' :
    config.summary_length === 'long' ? '40-80 words' : '20-50 words'

  const langGuide = config.language === 'zh' ? '\nRespond in Chinese.' :
    config.language === 'en' ? '\nRespond in English.' : ''

  // ── Stable prefix (identical across all function analyses → KV cache hit) ──
  // Everything above the "---" marker is the same for every function in a batch.
  // Anthropic's prompt cache matches the longest identical token prefix, so
  // keeping instructions first maximizes cache reuse across calls.

  const stablePrefix = `You are doing a deep analysis of a single function to extract design decisions.

## Instructions

A design decision explains:
- WHY this approach was chosen over alternatives
- WHAT trade-offs were made
- WHAT alternatives were considered
${findingTypeDesc}

For the target function provided below, extract up to ${config.max_decisions} design decisions.

Return ONLY a raw JSON array (no markdown, no backticks):
[{
  "function": "<function_name>",
  "related_functions": ["otherFunc1"],
  "summary": "${summaryGuide} — the decision with enough context to understand without seeing the code",
  "content": "200-600 chars explaining WHY, trade-offs, alternatives",
  "keywords": ["keyword1", "keyword2"],
  "finding_type": "${config.finding_types[0]}"${config.finding_types.includes('bug') || config.finding_types.includes('suboptimal') ? ',\n  "critique": "only for suboptimal/bug"' : ''}
}]

Empty array [] if no decisions worth recording.${langGuide}
${goalSection}${bizSection}${customSection}`

  // ── Variable suffix (different per function) ──

  const variableSuffix = `---

## Target function: ${input.functionName} (file: ${input.filePath})
\`\`\`
${context.targetCode}
\`\`\`
${callerSection}${calleeSection}${tableSection}${fileCtxSection}`

  return stablePrefix + variableSuffix
}

// ── Advanced mode: graph queries ─────────────────────────

/** Get 2-hop function names+signatures (names only, no full code) */
async function getTwoHopFunctions(
  session: Session, functionName: string, filePath: string, repo: string,
  maxPerLevel: number, includeCrossRepo: boolean
): Promise<{ callers: string[]; callees: string[] }> {
  const callerLevels = await getCallersMultiLevel(session, functionName, filePath, repo, 2, maxPerLevel, includeCrossRepo)
  const calleeLevels = await getCalleesMultiLevel(session, functionName, filePath, repo, 2, maxPerLevel, includeCrossRepo)

  // Only take level[1] (2nd hop) — level[0] is already included as full code
  const formatNode = (n: FunctionNode) => `${n.filePath}::${n.name}() [L${n.lineStart}-${n.lineEnd}]`
  return {
    callers: (callerLevels[1] || []).map(formatNode),
    callees: (calleeLevels[1] || []).map(formatNode),
  }
}

/** Get existing decisions anchored to a function */
async function getExistingDecisions(
  session: Session, functionName: string, filePath: string, repo: string
): Promise<{ summary: string; findingType: string }[]> {
  try {
    const result = await session.run(
      `MATCH (d:DecisionContext)-[:ANCHORED_TO]->(fn:CodeEntity {entity_type: 'function', name: $fnName})
       MATCH (f:CodeEntity {entity_type: 'file', path: $filePath, repo: $repo})-[:CONTAINS]->(fn)
       RETURN d.summary AS summary, d.finding_type AS findingType
       LIMIT 10`,
      { fnName: functionName, filePath, repo }
    )
    return result.records.map(r => ({
      summary: r.get('summary') as string,
      findingType: r.get('findingType') as string,
    }))
  } catch { return [] }
}

/** Lookup a function's code by name — used to fulfill LLM requests */
async function lookupFunctionCode(
  session: Session, name: string, requestedFile: string | undefined, repo: string, repoPath: string
): Promise<{ code: string; filePath: string } | null> {
  try {
    const fileFilter = requestedFile ? 'AND f.path = $filePath' : ''
    const result = await session.run(
      `MATCH (f:CodeEntity {entity_type: 'file', repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function', name: $fnName})
       WHERE fn.name <> ':program' ${fileFilter}
       RETURN fn.line_start AS ls, fn.line_end AS le, f.path AS fPath
       LIMIT 1`,
      { fnName: name, repo, ...(requestedFile ? { filePath: requestedFile } : {}) }
    )
    if (result.records.length === 0) return null
    const r = result.records[0]
    const fPath = r.get('fPath') as string
    const code = extractFunctionCode(repoPath, fPath, toNum(r.get('ls')), toNum(r.get('le')))
    if (!code) return null
    return { code, filePath: fPath }
  } catch { return null }
}

// ── Advanced mode: prompt builders ──────────────────────

function buildAdvancedInitialPrompt(
  input: AnalyzeFunctionInput,
  config: AnalyzeFunctionConfig,
  context: FunctionContext,
  twoHop: { callers: string[]; callees: string[] },
  existingDecs: { summary: string; findingType: string }[],
  modules: AdvancedContextModules,
): string {
  const sections: string[] = []

  sections.push(`You are doing a deep analysis of a function to extract design decisions.
You may return decisions you are confident about AND request additional context for decisions you need more information on.

## Target function: ${input.functionName} (file: ${input.filePath})
\`\`\`
${context.targetCode}
\`\`\``)

  if (modules.callerCode && context.callers.length > 0) {
    sections.push(formatCallerSection(input.functionName, context.callers))
  }
  if (modules.calleeCode && context.callees.length > 0) {
    sections.push(formatCalleeSection(input.functionName, context.callees))
  }
  if (modules.twoHopNames && (twoHop.callers.length > 0 || twoHop.callees.length > 0)) {
    let s = '\n## 2-hop neighbors (available to request):'
    if (twoHop.callers.length > 0) s += `\nCallers of callers:\n${twoHop.callers.map(c => `  - ${c}`).join('\n')}`
    if (twoHop.callees.length > 0) s += `\nCallees of callees:\n${twoHop.callees.map(c => `  - ${c}`).join('\n')}`
    sections.push(s)
  }
  if (modules.existingDecisions && existingDecs.length > 0) {
    sections.push(`\n## Existing decisions for ${input.functionName}:\n${existingDecs.map(d => `  - [${d.findingType}] ${d.summary}`).join('\n')}`)
  }
  if (modules.businessContext && context.businessContext && context.businessContext.length > 0) {
    sections.push(formatBusinessContext(context.businessContext))
  }
  if (modules.fileContext && context.fileContext && context.fileContext.length > 0) {
    sections.push(`\n## Other functions in ${input.filePath}: ${context.fileContext.join(', ')}`)
  }
  if (modules.tableAccess && context.tableAccess && context.tableAccess.length > 0) {
    sections.push(`\n## Database tables accessed: ${context.tableAccess.join(', ')}`)
  }

  // Available request types
  const availableTypes: string[] = ['function_code — request source code of any function in the graph']
  if (modules.fileContext) availableTypes.push('file_overview — list all functions in a file')
  if (modules.existingDecisions) availableTypes.push('existing_decisions — get decisions for a specific function')

  sections.push(`
## Instructions

Analyze ${input.functionName} and extract design decisions.

**You can return decisions AND requests in the same response.**
- For decisions you are confident about → include them in "decisions"
- For aspects that need more context → include requests in "requests"
- If you have all context needed → return empty "requests" array

Return ONLY raw JSON (no markdown, no backticks):
{
  "decisions": [{
    "function": "${input.functionName}",
    "related_functions": ["otherFunc"],
    "summary": "20-50 words — the decision with context",
    "content": "200-600 chars explaining WHY, trade-offs, alternatives",
    "keywords": ["keyword1"],
    "finding_type": "decision"
  }],
  "requests": [{
    "type": "function_code|file_overview|existing_decisions",
    "target": "functionName or filePath",
    "filePath": "optional/path.ts",
    "reason": "why you need this"
  }],
  "reasoning": "brief explanation of what you still need"
}

Available request types:
${availableTypes.map(t => `  - ${t}`).join('\n')}

Respond in English.`)

  return sections.join('\n')
}

function buildAdvancedFollowUpPrompt(
  input: AnalyzeFunctionInput,
  fulfilledContext: string[],
  deniedContext: string[],
  previousDecisions: ExtractedDecision[],
  round: number,
  maxRounds: number,
): string {
  const isLastRound = round >= maxRounds
  const sections: string[] = []

  sections.push(`Continue analyzing ${input.functionName} (${input.filePath}). Round ${round}/${maxRounds}.`)

  if (fulfilledContext.length > 0) {
    sections.push(`\n## Additional context you requested:\n${fulfilledContext.join('\n\n')}`)
  }
  if (deniedContext.length > 0) {
    sections.push(`\n## Requests not fulfilled:\n${deniedContext.join('\n')}`)
  }
  if (previousDecisions.length > 0) {
    sections.push(`\n## Decisions extracted so far (${previousDecisions.length}):\n${previousDecisions.map(d => `  - [${d.finding_type}] ${d.summary}`).join('\n')}`)
  }

  if (isLastRound) {
    sections.push(`\nThis is the FINAL round. Return all remaining decisions now. Do not make any requests.
Return ONLY raw JSON: { "decisions": [...], "requests": [] }`)
  } else {
    sections.push(`\nReturn additional decisions and/or more requests.
Return ONLY raw JSON: { "decisions": [...], "requests": [...] }`)
  }

  return sections.join('\n')
}

// ── Advanced mode: request fulfillment ──────────────────

async function fulfillRequests(
  requests: ContextRequest[],
  session: Session, repo: string, repoPath: string,
  modules: AdvancedContextModules,
  alreadyProvided: Set<string>,
): Promise<{ fulfilled: string[]; denied: string[] }> {
  const fulfilled: string[] = []
  const denied: string[] = []

  for (const req of requests.slice(0, 5)) { // cap at 5 requests per round
    const key = `${req.type}:${req.target}:${req.filePath || ''}`
    if (alreadyProvided.has(key)) {
      denied.push(`- ${req.target}: already provided`)
      continue
    }

    if (req.type === 'function_code') {
      const result = await lookupFunctionCode(session, req.target, req.filePath, repo, repoPath)
      if (result) {
        alreadyProvided.add(key)
        fulfilled.push(`### ${result.filePath}::${req.target}\n\`\`\`\n${result.code}\n\`\`\``)
      } else {
        denied.push(`- ${req.target}: not found in graph`)
      }
    } else if (req.type === 'file_overview' && modules.fileContext) {
      const fns = await getFileContext(session, req.target, repo, '')
      if (fns.length > 0) {
        alreadyProvided.add(key)
        fulfilled.push(`### File: ${req.target}\nFunctions: ${fns.join(', ')}`)
      } else {
        denied.push(`- ${req.target}: no functions found`)
      }
    } else if (req.type === 'existing_decisions' && modules.existingDecisions) {
      const decs = await getExistingDecisions(session, req.target, req.filePath || '', repo)
      if (decs.length > 0) {
        alreadyProvided.add(key)
        fulfilled.push(`### Decisions for ${req.target}:\n${decs.map(d => `  - [${d.findingType}] ${d.summary}`).join('\n')}`)
      } else {
        denied.push(`- ${req.target}: no existing decisions`)
      }
    } else {
      denied.push(`- ${req.target} (${req.type}): module not enabled or unknown type`)
    }
  }

  return { fulfilled, denied }
}

// ── Advanced mode: agentic loop ─────────────────────────

async function analyzeFunctionAdvanced(
  input: AnalyzeFunctionInput,
  config: AnalyzeFunctionConfig,
  session: Session,
  repoPath: string,
  context: FunctionContext,
  callerSnippets: CodeSnippet[],
  calleeSnippets: CodeSnippet[],
  startTime: number,
  resolvedTemplateName: string,
  configOverrides?: Partial<AnalyzeFunctionConfig>,
): Promise<AnalyzeFunctionResult> {
  const modules = config.advanced_modules
  const maxRounds = config.advanced_max_rounds

  // Get 2-hop neighbors
  let twoHop = { callers: [] as string[], callees: [] as string[] }
  if (modules.twoHopNames) {
    twoHop = await getTwoHopFunctions(
      session, input.functionName, input.filePath, input.repo,
      config.max_callers_per_level, config.include_cross_repo
    )
  }

  // Get existing decisions
  let existingDecs: { summary: string; findingType: string }[] = []
  if (modules.existingDecisions) {
    existingDecs = await getExistingDecisions(session, input.functionName, input.filePath, input.repo)
  }

  // Build AI provider
  const appConfig = loadConfig()
  const aiConfig = config.ai_provider || config.model
    ? { ...appConfig.ai, ...(config.ai_provider ? { provider: config.ai_provider } : {}), ...(config.model ? { model: config.model } : {}) }
    : appConfig.ai
  const ai = createAIProvider(aiConfig as any)

  const allDecisions: ExtractedDecision[] = []
  const roundLogs: AdvancedRoundLog[] = []
  const alreadyProvided = new Set<string>()

  // Mark initial callers/callees as already provided
  for (const c of callerSnippets) alreadyProvided.add(`function_code:${c.name}:${c.filePath}`)
  for (const c of calleeSnippets) alreadyProvided.add(`function_code:${c.name}:${c.filePath}`)

  // Round 1: initial prompt
  let prompt = buildAdvancedInitialPrompt(input, config, context, twoHop, existingDecs, modules)

  for (let round = 1; round <= maxRounds; round++) {
    const roundStart = Date.now()

    const raw = await ai.call(prompt, { timeoutMs: config.timeout_ms, onRetry: input.onRetry, onRateLimit: input.onRateLimit })
    const parsed = parseJsonSafe<AdvancedRoundOutput>(raw, { decisions: [], requests: [] })

    // Normalize: if LLM returned an array, treat as decisions-only
    const roundDecisions = Array.isArray(parsed) ? (parsed as unknown as ExtractedDecision[]) : (parsed.decisions || [])
    const requests: ContextRequest[] = Array.isArray(parsed) ? [] : (parsed.requests || [])

    // Accumulate valid decisions
    const validDecisions = roundDecisions.filter(
      (d): d is ExtractedDecision => !!d && !!d.summary && !!d.content
    )
    allDecisions.push(...validDecisions)

    if (DEBUG) console.log(`  [ADVANCED] Round ${round}: ${validDecisions.length} decisions, ${requests.length} requests`)

    // No more requests — done
    if (requests.length === 0 || round === maxRounds) {
      roundLogs.push({
        round, decisionsExtracted: validDecisions.length,
        requestsFulfilled: 0, requestsDenied: 0,
        durationMs: Date.now() - roundStart,
      })
      break
    }

    // Fulfill requests
    const { fulfilled, denied } = await fulfillRequests(
      requests, session, input.repo, repoPath, modules, alreadyProvided
    )

    roundLogs.push({
      round, decisionsExtracted: validDecisions.length,
      requestsFulfilled: fulfilled.length, requestsDenied: denied.length,
      durationMs: Date.now() - roundStart,
    })

    // Build follow-up prompt
    prompt = buildAdvancedFollowUpPrompt(
      input, fulfilled, denied, allDecisions,
      round + 1, maxRounds,
    )
  }

  // Convert to PendingDecisionOutput
  const now = new Date().toISOString()
  const owner = input.owner ?? 'me'
  const fileName = path.basename(input.filePath)
  const pathSlug = input.filePath.replace(/\//g, '_').replace(/\.[^.]+$/, '')
  const allowedTypes = new Set(config.finding_types)

  const filtered = allDecisions
    .filter(d => allowedTypes.has(d.finding_type ?? 'decision'))
    .slice(0, config.max_decisions)

  const decisions: PendingDecisionOutput[] = filtered.map((d, i) => {
    const id = `dc:af:${input.repo}:${pathSlug}:${d.function || input.functionName}:${Date.now()}-${i}`
    const findingType = ['decision', 'suboptimal', 'bug'].includes(d.finding_type)
      ? d.finding_type : 'decision'
    return {
      id,
      props: {
        summary: String(d.summary), content: String(d.content),
        keywords: Array.isArray(d.keywords) ? d.keywords : [],
        scope: [input.repo], owner,
        session_id: `analyze-function-${now.slice(0, 10)}`,
        commit_hash: 'analyze-function', source: 'analyze_function',
        confidence: 'auto_generated', staleness: 'active',
        finding_type: findingType,
        ...(d.critique && findingType !== 'decision' ? { critique: String(d.critique) } : {}),
        created_at: now, updated_at: now,
      },
      functionName: String(d.function || input.functionName),
      relatedFunctions: Array.isArray(d.related_functions) ? d.related_functions.map(String) : [],
      filePath: input.filePath, fileName, repo: input.repo,
    }
  })

  ai.cleanup()

  return {
    functionName: input.functionName, filePath: input.filePath, repo: input.repo,
    decisions,
    metadata: {
      template_used: resolvedTemplateName,
      config_snapshot: configOverrides ?? {},
      caller_count: callerSnippets.length,
      callee_count: calleeSnippets.length,
      token_usage: ai.lastUsage,
      duration_ms: Date.now() - startTime,
      advanced: { mode: 'advanced', rounds: roundLogs, totalRounds: roundLogs.length },
    },
  }
}

// ── Main function ───────────────────────────────────────

/**
 * 分析单个函数，提取设计决策。
 *
 * @param input - 目标函数信息
 * @param configOverrides - 配置覆盖（合并到模板配置之上）
 * @param templateName - 使用哪个模板（默认用 ckg.config.json 的 default_template 或 _default）
 */
export async function analyzeFunction(
  input: AnalyzeFunctionInput,
  configOverrides?: Partial<AnalyzeFunctionConfig>,
  templateName?: string
): Promise<AnalyzeFunctionResult> {
  const startTime = Date.now()

  // 1. 加载配置
  const resolvedTemplateName = templateName ?? '_default'
  const { config } = loadTemplate(resolvedTemplateName, configOverrides)

  // 2. 获取或创建 session
  const ownSession = !input.session
  let session: Session
  if (input.session) {
    session = input.session
  } else {
    await verifyConnectivity()
    session = await getSession()
  }

  let ai: AIProvider | null = null
  try {
    // 3. 获取函数行号（如果没提供）
    let lineStart = input.lineStart
    let lineEnd = input.lineEnd
    if (!lineStart || !lineEnd) {
      const range = await getFunctionLineRange(session, input.functionName, input.filePath, input.repo)
      if (range) {
        lineStart = range.lineStart
        lineEnd = range.lineEnd
      }
    }
    if (DEBUG) console.log(`  [DEBUG] lineRange: ${lineStart}-${lineEnd}`)

    // 4. 读取目标函数代码
    const repoPath = resolveRepoPath(input.repo, input.repoPath)
    let targetCode = input.functionCode ?? null
    if (!targetCode && lineStart && lineEnd && lineStart > 0) {
      targetCode = extractCode(repoPath, {
        name: input.functionName, filePath: input.filePath,
        lineStart, lineEnd, repo: input.repo,
      }, config.target_code, config.target_max_lines)
    }
    if (!targetCode) {
      // 最后尝试读整个文件
      targetCode = readFullFile(repoPath, input.filePath)
    }
    if (DEBUG) console.log(`  [DEBUG] targetCode: ${targetCode ? targetCode.length + ' chars' : 'NOT FOUND'} (repoPath=${repoPath})`)
    if (!targetCode) {
      return {
        functionName: input.functionName,
        filePath: input.filePath,
        repo: input.repo,
        decisions: [],
        metadata: {
          template_used: resolvedTemplateName,
          config_snapshot: configOverrides ?? {},
          caller_count: 0, callee_count: 0,
          duration_ms: Date.now() - startTime,
        },
      }
    }

    // 5. 获取 callers/callees
    if (DEBUG) console.log(`  [DEBUG] querying callers (depth=${config.caller_depth}) for ${input.functionName} in ${input.filePath} repo=${input.repo}`)
    const callerLevels = await getCallersMultiLevel(
      session, input.functionName, input.filePath, input.repo,
      config.caller_depth, config.max_callers_per_level, config.include_cross_repo
    )
    if (DEBUG) console.log(`  [DEBUG] callerLevels: ${callerLevels.map(l => l.length).join(',')} (${callerLevels.flat().map(n => n.name).join(', ') || 'none'})`)
    const calleeLevels = await getCalleesMultiLevel(
      session, input.functionName, input.filePath, input.repo,
      config.callee_depth, config.max_callees_per_level, config.include_cross_repo
    )
    if (DEBUG) console.log(`  [DEBUG] calleeLevels: ${calleeLevels.map(l => l.length).join(',')} (${calleeLevels.flat().map(n => n.name).join(', ') || 'none'})`)

    // Flatten levels and extract code
    const callerSnippets: CodeSnippet[] = []
    for (const level of callerLevels) {
      for (const node of level) {
        const nodeRepoPath = node.repo === input.repo
          ? repoPath
          : resolveRepoPath(node.repo, '')
        const code = extractCode(nodeRepoPath, node, config.caller_code, config.caller_max_lines)
        callerSnippets.push({
          name: node.name,
          filePath: node.filePath,
          code: code ?? '',
          lineStart: node.lineStart,
          lineEnd: node.lineEnd,
        })
      }
    }

    const calleeSnippets: CodeSnippet[] = []
    for (const level of calleeLevels) {
      for (const node of level) {
        const nodeRepoPath = node.repo === input.repo
          ? repoPath
          : resolveRepoPath(node.repo, '')
        const code = extractCode(nodeRepoPath, node, config.callee_code, config.callee_max_lines)
        calleeSnippets.push({
          name: node.name,
          filePath: node.filePath,
          code: code ?? '',
          lineStart: node.lineStart,
          lineEnd: node.lineEnd,
        })
      }
    }

    // 6. 获取数据库表访问
    let tableAccess: string[] = []
    if (config.include_table_access) {
      tableAccess = await getTableAccess(session, input.functionName, input.filePath, input.repo)
    }

    // 7. 获取文件上下文
    let fileContext: string[] = []
    if (config.include_file_context) {
      fileContext = await getFileContext(session, input.filePath, input.repo, input.functionName)
    }

    // 8. 获取 business context
    let businessContext: { summary: string; content: string }[] = []
    if (config.include_business_context) {
      businessContext = await getBusinessContext(session)
    }

    // 9. 组装 context
    const context: FunctionContext = {
      targetCode,
      callers: callerSnippets,
      callees: calleeSnippets,
      tableAccess: tableAccess.length > 0 ? tableAccess : undefined,
      fileContext: fileContext.length > 0 ? fileContext : undefined,
      businessContext: businessContext.length > 0 ? businessContext : undefined,
    }

    // 9.5. Advanced mode branch
    if (config.advanced_mode) {
      return await analyzeFunctionAdvanced(
        input, config, session, repoPath, context,
        callerSnippets, calleeSnippets, startTime, resolvedTemplateName, configOverrides
      )
    }

    // 10. 构建 prompt
    const prompt = buildPrompt(input, config, context)

    // 11. 调 AI
    const appConfig = loadConfig()
    const aiConfig = config.ai_provider || config.model
      ? { ...appConfig.ai, ...(config.ai_provider ? { provider: config.ai_provider } : {}), ...(config.model ? { model: config.model } : {}) }
      : appConfig.ai
    ai = createAIProvider(aiConfig as any)

    const raw = await ai.call(prompt, { timeoutMs: config.timeout_ms, onRetry: input.onRetry, onRateLimit: input.onRateLimit })

    // 12. 解析输出
    const rawDecisions = parseJsonSafe<ExtractedDecision[]>(raw, [])
    if (!Array.isArray(rawDecisions)) {
      return {
        functionName: input.functionName, filePath: input.filePath, repo: input.repo,
        decisions: [],
        metadata: {
          template_used: resolvedTemplateName,
          config_snapshot: configOverrides ?? {},
          caller_count: callerSnippets.length,
          callee_count: calleeSnippets.length,
          token_usage: ai.lastUsage,
          duration_ms: Date.now() - startTime,
        },
      }
    }

    // 过滤 finding_types
    const allowedTypes = new Set(config.finding_types)
    const filtered = rawDecisions
      .filter((d): d is ExtractedDecision =>
        !!d && !!d.function && !!d.summary && !!d.content &&
        allowedTypes.has(d.finding_type ?? 'decision')
      )
      .slice(0, config.max_decisions)

    // 13. 转换为 PendingDecisionOutput 格式
    const now = new Date().toISOString()
    const owner = input.owner ?? 'me'
    const fileName = path.basename(input.filePath)
    const pathSlug = input.filePath.replace(/\//g, '_').replace(/\.[^.]+$/, '')

    const decisions: PendingDecisionOutput[] = filtered.map((d, i) => {
      const id = `dc:af:${input.repo}:${pathSlug}:${d.function}:${Date.now()}-${i}`
      const findingType = ['decision', 'suboptimal', 'bug'].includes(d.finding_type)
        ? d.finding_type : 'decision'

      return {
        id,
        props: {
          summary: String(d.summary),
          content: String(d.content),
          keywords: Array.isArray(d.keywords) ? d.keywords : [],
          scope: [input.repo],
          owner,
          session_id: `analyze-function-${now.slice(0, 10)}`,
          commit_hash: 'analyze-function',
          source: 'analyze_function',
          confidence: 'auto_generated',
          staleness: 'active',
          finding_type: findingType,
          ...(d.critique && findingType !== 'decision' ? { critique: String(d.critique) } : {}),
          created_at: now,
          updated_at: now,
        },
        functionName: String(d.function),
        relatedFunctions: Array.isArray(d.related_functions) ? d.related_functions.map(String) : [],
        filePath: input.filePath,
        fileName,
        repo: input.repo,
      }
    })

    return {
      functionName: input.functionName,
      filePath: input.filePath,
      repo: input.repo,
      decisions,
      metadata: {
        template_used: resolvedTemplateName,
        config_snapshot: configOverrides ?? {},
        caller_count: callerSnippets.length,
        callee_count: calleeSnippets.length,
        token_usage: ai.lastUsage,
        duration_ms: Date.now() - startTime,
      },
    }
  } finally {
    ai?.cleanup()
    if (ownSession) {
      await session.close()
    }
  }
}

// ── Batch analysis: multiple functions in one LLM call ──────────

export interface BatchFunctionInput {
  functionName: string
  filePath: string
  lineStart: number
  lineEnd: number
}

export interface AnalyzeFunctionBatchResult {
  results: AnalyzeFunctionResult[]
  metadata: {
    token_usage: TokenUsage
    duration_ms: number
    batch_size: number
  }
}

export async function analyzeFunctionBatch(
  functions: BatchFunctionInput[],
  repo: string,
  repoPath: string,
  session: Session,
  configOverrides?: Partial<AnalyzeFunctionConfig>,
  templateName?: string,
  onRetry?: AnalyzeFunctionInput['onRetry'],
  onRateLimit?: AnalyzeFunctionInput['onRateLimit'],
): Promise<AnalyzeFunctionBatchResult> {
  const startTime = Date.now()
  const resolvedTemplateName = templateName ?? '_default'
  const { config } = loadTemplate(resolvedTemplateName, configOverrides)

  let ai: AIProvider | null = null
  try {
    // 1. Gather context for all functions
    const fnContexts: { input: BatchFunctionInput; code: string; callers: CodeSnippet[]; callees: CodeSnippet[] }[] = []

    for (const fn of functions) {
      const code = extractCode(repoPath, {
        name: fn.functionName, filePath: fn.filePath,
        lineStart: fn.lineStart, lineEnd: fn.lineEnd, repo,
      }, config.target_code, config.target_max_lines) ?? readFullFile(repoPath, fn.filePath) ?? ''

      const callerLevels = await getCallersMultiLevel(
        session, fn.functionName, fn.filePath, repo,
        config.caller_depth, config.max_callers_per_level, config.include_cross_repo
      )
      const calleeLevels = await getCalleesMultiLevel(
        session, fn.functionName, fn.filePath, repo,
        config.callee_depth, config.max_callees_per_level, config.include_cross_repo
      )

      const callerSnippets: CodeSnippet[] = []
      for (const level of callerLevels) {
        for (const node of level) {
          const nodeRepoPath = node.repo === repo ? repoPath : resolveRepoPath(node.repo, '')
          const c = extractCode(nodeRepoPath, node, config.caller_code, config.caller_max_lines)
          callerSnippets.push({ name: node.name, filePath: node.filePath, code: c ?? '', lineStart: node.lineStart, lineEnd: node.lineEnd })
        }
      }

      const calleeSnippets: CodeSnippet[] = []
      for (const level of calleeLevels) {
        for (const node of level) {
          const nodeRepoPath = node.repo === repo ? repoPath : resolveRepoPath(node.repo, '')
          const c = extractCode(nodeRepoPath, node, config.callee_code, config.callee_max_lines)
          calleeSnippets.push({ name: node.name, filePath: node.filePath, code: c ?? '', lineStart: node.lineStart, lineEnd: node.lineEnd })
        }
      }

      fnContexts.push({ input: fn, code, callers: callerSnippets, callees: calleeSnippets })
    }

    // 2. Build combined prompt
    const findingTypeDesc = config.finding_types.includes('bug') || config.finding_types.includes('suboptimal')
      ? `\nAlso classify each finding:
- **decision**: Intentional, reasonable design choice.
- **suboptimal**: Works correctly but there's a significantly better approach.
- **bug**: Behavior does NOT match expected business logic.
Default to "decision" unless you have clear evidence otherwise.`
      : ''

    const summaryGuide = config.summary_length === 'short' ? '10-25 words' :
      config.summary_length === 'long' ? '40-80 words' : '20-50 words'

    const langGuide = config.language === 'zh' ? '\nRespond in Chinese.' :
      config.language === 'en' ? '\nRespond in English.' : ''

    const stablePrefix = `You are analyzing ${functions.length} functions to extract design decisions.

## Instructions

A design decision explains:
- WHY this approach was chosen over alternatives
- WHAT trade-offs were made
- WHAT alternatives were considered
${findingTypeDesc}

For EACH function below, extract up to ${config.max_decisions} design decisions.

Return ONLY a raw JSON array (no markdown, no backticks) containing decisions from ALL functions:
[{
  "function": "<function_name>",
  "file": "<file_path>",
  "related_functions": ["otherFunc1"],
  "summary": "${summaryGuide} — the decision with enough context to understand without seeing the code",
  "content": "200-600 chars explaining WHY, trade-offs, alternatives",
  "keywords": ["keyword1", "keyword2"],
  "finding_type": "${config.finding_types[0]}"${config.finding_types.includes('bug') || config.finding_types.includes('suboptimal') ? ',\n  "critique": "only for suboptimal/bug"' : ''}
}]

IMPORTANT: The "function" field must exactly match the function name as given. The "file" field must exactly match the file path.
Empty array [] if no decisions worth recording across all functions.${langGuide}
`

    const functionSections = fnContexts.map((fc, i) => {
      const callerSection = formatCallerSection(fc.input.functionName, fc.callers)
      const calleeSection = formatCalleeSection(fc.input.functionName, fc.callees)
      return `---

## Function ${i + 1}/${functions.length}: ${fc.input.functionName} (file: ${fc.input.filePath})
\`\`\`
${fc.code}
\`\`\`
${callerSection}${calleeSection}`
    }).join('\n')

    const prompt = stablePrefix + functionSections

    // 3. Single AI call
    const appConfig = loadConfig()
    const aiConfig = config.ai_provider || config.model
      ? { ...appConfig.ai, ...(config.ai_provider ? { provider: config.ai_provider } : {}), ...(config.model ? { model: config.model } : {}) }
      : appConfig.ai
    ai = createAIProvider(aiConfig as any)

    const raw = await ai.call(prompt, { timeoutMs: config.timeout_ms, onRetry, onRateLimit })

    // 4. Parse and distribute results
    const rawDecisions = parseJsonSafe<(ExtractedDecision & { file?: string })[]>(raw, [])
    const allowedTypes = new Set(config.finding_types)
    const now = new Date().toISOString()
    const owner = 'dashboard'

    // Group decisions by function
    const resultMap = new Map<string, PendingDecisionOutput[]>()
    for (const fn of functions) {
      resultMap.set(`${fn.filePath}::${fn.functionName}`, [])
    }

    if (Array.isArray(rawDecisions)) {
      for (const d of rawDecisions) {
        if (!d || !d.function || !d.summary || !d.content) continue
        if (!allowedTypes.has(d.finding_type ?? 'decision')) continue

        // Match to a function — try exact match on function name + file, fallback to function name only
        const file = d.file ?? functions.find(f => f.functionName === d.function)?.filePath ?? functions[0].filePath
        const key = `${file}::${d.function}`
        const altKey = [...resultMap.keys()].find(k => k.endsWith(`::${d.function}`))
        const targetKey = resultMap.has(key) ? key : (altKey ?? key)

        if (!resultMap.has(targetKey)) continue

        const filePath = targetKey.split('::')[0]
        const pathSlug = filePath.replace(/\//g, '_').replace(/\.[^.]+$/, '')
        const findingType = ['decision', 'suboptimal', 'bug'].includes(d.finding_type) ? d.finding_type : 'decision'
        const idx = resultMap.get(targetKey)!.length

        resultMap.get(targetKey)!.push({
          id: `dc:af:${repo}:${pathSlug}:${d.function}:${Date.now()}-${idx}`,
          props: {
            summary: String(d.summary),
            content: String(d.content),
            keywords: Array.isArray(d.keywords) ? d.keywords : [],
            scope: [repo],
            owner,
            session_id: `analyze-function-${now.slice(0, 10)}`,
            commit_hash: 'analyze-function',
            source: 'analyze_function',
            confidence: 'auto_generated',
            staleness: 'active',
            finding_type: findingType,
            ...(d.critique && findingType !== 'decision' ? { critique: String(d.critique) } : {}),
            created_at: now,
            updated_at: now,
          },
          functionName: String(d.function),
          relatedFunctions: Array.isArray(d.related_functions) ? d.related_functions.map(String) : [],
          filePath,
          fileName: path.basename(filePath),
          repo,
        })
      }
    }

    // 5. Build results array
    const results: AnalyzeFunctionResult[] = functions.map(fn => {
      const key = `${fn.filePath}::${fn.functionName}`
      const decisions = resultMap.get(key) ?? []
      return {
        functionName: fn.functionName,
        filePath: fn.filePath,
        repo,
        decisions,
        metadata: {
          template_used: resolvedTemplateName,
          config_snapshot: configOverrides ?? {},
          caller_count: 0,
          callee_count: 0,
          token_usage: ai!.lastUsage,
          duration_ms: Date.now() - startTime,
        },
      }
    })

    return {
      results,
      metadata: {
        token_usage: ai.lastUsage,
        duration_ms: Date.now() - startTime,
        batch_size: functions.length,
      },
    }
  } finally {
    ai?.cleanup()
  }
}

// ── Cluster Analysis — Relationship-Aware Batch Analysis ─

export interface ClusterBatchResult extends AnalyzeFunctionBatchResult {
  /** Functions that were targets (produced decisions) */
  targetKeys: string[]
  /** Functions that were context-only (no decisions) */
  contextOnlyKeys: string[]
  /** Token savings from shared context dedup */
  tokenSavings: {
    sharedSnippetCount: number
    dedupedReferences: number
    estimatedTokensSaved: number
  }
}

/**
 * Analyze a cluster batch with shared context deduplication.
 *
 * - Center + level-1 → analysis targets (produce decisions)
 * - Level-2 → context-only (loaded once in shared pool)
 * - Level-1 functions with existing decisions → existing decisions fed as context
 * - Concurrent overlap: allowed, duplicates resolved later
 */
export async function analyzeClusterBatch(
  batch: RelationshipBatch,
  repo: string,
  repoPath: string,
  session: Session,
  configOverrides?: Partial<AnalyzeFunctionConfig>,
  templateName?: string,
  onRetry?: AnalyzeFunctionInput['onRetry'],
  onRateLimit?: AnalyzeFunctionInput['onRateLimit'],
): Promise<ClusterBatchResult> {
  const startTime = Date.now()
  const resolvedTemplateName = templateName ?? '_default'
  const { config } = loadTemplate(resolvedTemplateName, configOverrides)

  let ai: AIProvider | null = null
  try {
    const targetFns = batch.functions
    const targetKeys = new Set(targetFns.map(fn => `${fn.filePath}::${fn.functionName}`))

    // 1. Load code for all targets
    const targetCodeMap = new Map<string, string>()
    for (const fn of targetFns) {
      const code = extractCode(repoPath, {
        name: fn.functionName, filePath: fn.filePath,
        lineStart: fn.lineStart, lineEnd: fn.lineEnd, repo,
      }, config.target_code, config.target_max_lines) ?? readFullFile(repoPath, fn.filePath) ?? ''
      targetCodeMap.set(`${fn.filePath}::${fn.functionName}`, code)
    }

    // 2. For each target, fetch callers/callees. Separate into:
    //    - inBatch: other targets in this batch (reference by Target N label)
    //    - contextOnly: level-2 context functions (deduplicate)
    //    - unique: only referenced by this one target

    interface ContextSnippet {
      key: string
      name: string
      filePath: string
      code: string
      referencedBy: Set<string> // target keys that reference this
      direction: 'caller' | 'callee' | 'both'
    }

    const contextPool = new Map<string, ContextSnippet>()
    const perTargetCallerKeys = new Map<string, string[]>() // targetKey → [contextKey or targetKey]
    const perTargetCalleeKeys = new Map<string, string[]>()

    for (const fn of targetFns) {
      const fnKey = `${fn.filePath}::${fn.functionName}`

      const callerLevels = await getCallersMultiLevel(
        session, fn.functionName, fn.filePath, repo,
        config.caller_depth, config.max_callers_per_level, config.include_cross_repo
      )
      const calleeLevels = await getCalleesMultiLevel(
        session, fn.functionName, fn.filePath, repo,
        config.callee_depth, config.max_callees_per_level, config.include_cross_repo
      )

      const callerRefs: string[] = []
      for (const level of callerLevels) {
        for (const node of level) {
          const nodeKey = `${node.filePath}::${node.name}`
          callerRefs.push(nodeKey)
          if (targetKeys.has(nodeKey)) continue // skip — it's already a target
          if (!contextPool.has(nodeKey)) {
            const nodeRepoPath = node.repo === repo ? repoPath : resolveRepoPath(node.repo, '')
            const code = extractCode(nodeRepoPath, node, config.caller_code, config.caller_max_lines) ?? ''
            contextPool.set(nodeKey, { key: nodeKey, name: node.name, filePath: node.filePath, code, referencedBy: new Set(), direction: 'caller' })
          }
          contextPool.get(nodeKey)!.referencedBy.add(fnKey)
        }
      }
      perTargetCallerKeys.set(fnKey, callerRefs)

      const calleeRefs: string[] = []
      for (const level of calleeLevels) {
        for (const node of level) {
          const nodeKey = `${node.filePath}::${node.name}`
          calleeRefs.push(nodeKey)
          if (targetKeys.has(nodeKey)) continue
          if (!contextPool.has(nodeKey)) {
            const nodeRepoPath = node.repo === repo ? repoPath : resolveRepoPath(node.repo, '')
            const code = extractCode(nodeRepoPath, node, config.callee_code, config.callee_max_lines) ?? ''
            contextPool.set(nodeKey, { key: nodeKey, name: node.name, filePath: node.filePath, code, referencedBy: new Set(), direction: 'callee' })
          } else if (contextPool.get(nodeKey)!.direction === 'caller') {
            contextPool.get(nodeKey)!.direction = 'both'
          }
          contextPool.get(nodeKey)!.referencedBy.add(fnKey)
        }
      }
      perTargetCalleeKeys.set(fnKey, calleeRefs)
    }

    // 3. Partition context pool into shared (2+ references) vs unique (1 reference)
    const sharedContext: ContextSnippet[] = []
    const uniqueContext = new Map<string, ContextSnippet[]>() // targetKey → unique snippets
    let dedupedReferences = 0

    for (const [key, snippet] of contextPool) {
      if (snippet.referencedBy.size >= 2) {
        sharedContext.push(snippet)
        dedupedReferences += snippet.referencedBy.size - 1 // saved N-1 duplicates
      } else {
        const targetKey = [...snippet.referencedBy][0]
        if (!uniqueContext.has(targetKey)) uniqueContext.set(targetKey, [])
        uniqueContext.get(targetKey)!.push(snippet)
      }
    }

    // 4. Fetch existing decisions for targets that were already analyzed
    const existingDecisionsMap = new Map<string, { summary: string; findingType: string }[]>()
    for (const fn of targetFns) {
      const decisions = await getExistingDecisions(session, fn.functionName, fn.filePath, repo)
      if (decisions.length > 0) {
        existingDecisionsMap.set(`${fn.filePath}::${fn.functionName}`, decisions)
      }
    }

    // 5. Build relationship-aware prompt
    const findingTypeDesc = config.finding_types.includes('bug') || config.finding_types.includes('suboptimal')
      ? `\nAlso classify each finding:
- **decision**: Intentional, reasonable design choice.
- **suboptimal**: Works correctly but there's a significantly better approach.
- **bug**: Behavior does NOT match expected business logic.
Default to "decision" unless you have clear evidence otherwise.`
      : ''

    const summaryGuide = config.summary_length === 'short' ? '10-25 words' :
      config.summary_length === 'long' ? '40-80 words' : '20-50 words'

    const langGuide = config.language === 'zh' ? '\nRespond in Chinese.' :
      config.language === 'en' ? '\nRespond in English.' : ''

    const stablePrefix = `You are analyzing ${targetFns.length} related functions that form a connected call graph.

## Instructions

A design decision explains:
- WHY this approach was chosen over alternatives
- WHAT trade-offs were made
- WHAT alternatives were considered
${findingTypeDesc}

These functions are related through caller/callee relationships. Shared context functions (labeled [S1], [S2], etc.) are referenced by multiple targets — they appear once in the Shared Context section. Target functions reference each other by (Target N) labels. Use the call graph to understand data and control flow.

If a target function has existing decisions from a prior analysis, they are shown below it. You may:
- Skip producing new decisions if existing ones are accurate
- Produce new/modified decisions if the existing ones are incomplete or wrong
- Reference existing decisions in your analysis of related functions

For EACH target function below, extract up to ${config.max_decisions} design decisions.

Return ONLY a raw JSON array (no markdown, no backticks):
[{
  "function": "<function_name>",
  "file": "<file_path>",
  "related_functions": ["otherFunc1"],
  "summary": "${summaryGuide} — the decision with enough context to understand without seeing the code",
  "content": "200-600 chars explaining WHY, trade-offs, alternatives",
  "keywords": ["keyword1", "keyword2"],
  "finding_type": "${config.finding_types[0]}"${config.finding_types.includes('bug') || config.finding_types.includes('suboptimal') ? ',\n  "critique": "only for suboptimal/bug"' : ''}
}]

IMPORTANT: The "function" field must exactly match the function name as given. The "file" field must exactly match the file path.
Empty array [] if no decisions worth recording.${langGuide}
`

    // Build shared context section
    let sharedSection = ''
    const sharedLabels = new Map<string, string>() // key → [S1], [S2], ...
    if (sharedContext.length > 0) {
      sharedSection = '\n## Shared Context (referenced by multiple targets)\n'
      sharedContext.forEach((s, i) => {
        const label = `[S${i + 1}]`
        sharedLabels.set(s.key, label)
        sharedSection += `\n### ${label} ${s.filePath}::${s.name}\n\`\`\`\n${s.code}\n\`\`\`\n`
      })
    }

    // Build call graph section
    let callGraphSection = '\n## Call Graph\n'
    for (const edge of batch.internalEdges) {
      const callerLabel = targetKeys.has(edge.caller)
        ? `${edge.caller.split('::')[1]} (Target)`
        : sharedLabels.has(edge.caller) ? `${sharedLabels.get(edge.caller)} ${edge.caller.split('::')[1]}` : edge.caller.split('::')[1]
      const calleeLabel = targetKeys.has(edge.callee)
        ? `${edge.callee.split('::')[1]} (Target)`
        : sharedLabels.has(edge.callee) ? `${sharedLabels.get(edge.callee)} ${edge.callee.split('::')[1]}` : edge.callee.split('::')[1]
      callGraphSection += `${callerLabel} → ${calleeLabel}\n`
    }

    // Build per-target sections
    const functionSections = targetFns.map((fn, i) => {
      const fnKey = `${fn.filePath}::${fn.functionName}`
      const code = targetCodeMap.get(fnKey) ?? ''

      // Build caller/callee reference lines (not full code — just labels)
      const callerKeys = perTargetCallerKeys.get(fnKey) ?? []
      const calleeKeys = perTargetCalleeKeys.get(fnKey) ?? []

      const callerLine = callerKeys.length > 0
        ? `Callers: ${callerKeys.map(k => {
            if (targetKeys.has(k)) return `${k.split('::')[1]} (Target)`
            if (sharedLabels.has(k)) return `${sharedLabels.get(k)} ${k.split('::')[1]}`
            return k.split('::')[1]
          }).join(', ')}`
        : ''

      const calleeLine = calleeKeys.length > 0
        ? `Callees: ${calleeKeys.map(k => {
            if (targetKeys.has(k)) return `${k.split('::')[1]} (Target)`
            if (sharedLabels.has(k)) return `${sharedLabels.get(k)} ${k.split('::')[1]}`
            return k.split('::')[1]
          }).join(', ')}`
        : ''

      // Existing decisions
      const existing = existingDecisionsMap.get(fnKey)
      const existingSection = existing && existing.length > 0
        ? `\n### Existing decisions (from prior analysis):\n${existing.map(d => `- [${d.findingType}] ${d.summary}`).join('\n')}\n`
        : ''

      // Unique context (only referenced by this target)
      const uniques = uniqueContext.get(fnKey) ?? []
      const uniqueSection = uniques.length > 0
        ? `\n### Unique context:\n${uniques.map(u => `#### ${u.filePath}::${u.name}\n\`\`\`\n${u.code}\n\`\`\``).join('\n')}\n`
        : ''

      return `---

## Target ${i + 1}/${targetFns.length}: ${fn.functionName} (file: ${fn.filePath})
${callerLine ? callerLine + '\n' : ''}${calleeLine ? calleeLine + '\n' : ''}\`\`\`
${code}
\`\`\`${existingSection}${uniqueSection}`
    }).join('\n')

    const prompt = stablePrefix + sharedSection + callGraphSection + functionSections

    // 6. Call AI
    const appConfig = loadConfig()
    const aiConfig = config.ai_provider || config.model
      ? { ...appConfig.ai, ...(config.ai_provider ? { provider: config.ai_provider } : {}), ...(config.model ? { model: config.model } : {}) }
      : appConfig.ai
    ai = createAIProvider(aiConfig as any)

    const raw = await ai.call(prompt, { timeoutMs: config.timeout_ms, onRetry, onRateLimit })

    // 7. Parse and distribute results (same logic as analyzeFunctionBatch)
    const rawDecisions = parseJsonSafe<(ExtractedDecision & { file?: string })[]>(raw, [])
    const allowedTypes = new Set(config.finding_types)
    const now = new Date().toISOString()
    const owner = 'dashboard'

    const resultMap = new Map<string, PendingDecisionOutput[]>()
    for (const fn of targetFns) {
      resultMap.set(`${fn.filePath}::${fn.functionName}`, [])
    }

    if (Array.isArray(rawDecisions)) {
      for (const d of rawDecisions) {
        if (!d || !d.function || !d.summary || !d.content) continue
        if (!allowedTypes.has(d.finding_type ?? 'decision')) continue

        const file = d.file ?? targetFns.find(f => f.functionName === d.function)?.filePath ?? targetFns[0].filePath
        const key = `${file}::${d.function}`
        const altKey = [...resultMap.keys()].find(k => k.endsWith(`::${d.function}`))
        const targetKey = resultMap.has(key) ? key : (altKey ?? key)

        if (!resultMap.has(targetKey)) continue

        const filePath = targetKey.split('::')[0]
        const pathSlug = filePath.replace(/\//g, '_').replace(/\.[^.]+$/, '')
        const findingType = ['decision', 'suboptimal', 'bug'].includes(d.finding_type) ? d.finding_type : 'decision'
        const idx = resultMap.get(targetKey)!.length

        resultMap.get(targetKey)!.push({
          id: `dc:af:${repo}:${pathSlug}:${d.function}:${Date.now()}-${idx}`,
          props: {
            summary: String(d.summary),
            content: String(d.content),
            keywords: Array.isArray(d.keywords) ? d.keywords : [],
            scope: [repo],
            owner,
            session_id: `analyze-cluster-${now.slice(0, 10)}`,
            commit_hash: 'analyze-function',
            source: 'analyze_function',
            confidence: 'auto_generated',
            staleness: 'active',
            finding_type: findingType,
            ...(d.critique && findingType !== 'decision' ? { critique: String(d.critique) } : {}),
            created_at: now,
            updated_at: now,
          },
          functionName: String(d.function),
          relatedFunctions: Array.isArray(d.related_functions) ? d.related_functions.map(String) : [],
          filePath,
          fileName: path.basename(filePath),
          repo,
        })
      }
    }

    // 8. Build results
    const results: AnalyzeFunctionResult[] = targetFns.map(fn => {
      const key = `${fn.filePath}::${fn.functionName}`
      const decisions = resultMap.get(key) ?? []
      return {
        functionName: fn.functionName,
        filePath: fn.filePath,
        repo,
        decisions,
        metadata: {
          template_used: resolvedTemplateName,
          config_snapshot: configOverrides ?? {},
          caller_count: (perTargetCallerKeys.get(key) ?? []).length,
          callee_count: (perTargetCalleeKeys.get(key) ?? []).length,
          token_usage: ai!.lastUsage,
          duration_ms: Date.now() - startTime,
        },
      }
    })

    const estimatedTokensSaved = dedupedReferences * 800 // ~800 tokens per deduped snippet

    return {
      results,
      metadata: {
        token_usage: ai.lastUsage,
        duration_ms: Date.now() - startTime,
        batch_size: targetFns.length,
      },
      targetKeys: [...targetKeys],
      contextOnlyKeys: [...batch.contextOnlyKeys],
      tokenSavings: {
        sharedSnippetCount: sharedContext.length,
        dedupedReferences,
        estimatedTokensSaved,
      },
    }
  } finally {
    ai?.cleanup()
  }
}
