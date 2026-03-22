/**
 * core/analyze-function.ts
 *
 * 核心 building block：分析单个函数，提取设计决策。
 *
 * 这是整个系统最重要的模块。所有的 pipeline（cold-start、full-scan、
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
import { createAIProvider } from '../ai'
import { loadConfig } from '../config'
import { loadTemplate } from './template-loader'
import {
  AnalyzeFunctionConfig, AnalyzeFunctionInput, AnalyzeFunctionResult,
  PendingDecisionOutput, ExtractedDecision, CodeSnippet, FunctionContext,
} from './types'
import {
  extractFunctionCode, readFullFile, resolveSourcePath,
  parseJsonSafe, toNum,
} from '../ingestion/shared'

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
        if (DEBUG) console.log(`  [DEBUG] callers query error: ${e.message}`)
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
      } catch {}
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
    ? `\n## Database tables accessed by ${input.functionName}: ${context.tableAccess.join(', ')}\n`
    : ''
  const fileCtxSection = context.fileContext?.length
    ? `\n## Other functions in ${input.filePath}: ${context.fileContext.join(', ')}\n`
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

  return `You are doing a deep analysis of a single function to extract design decisions.

${goalSection}${bizSection}${customSection}
## Target function: ${input.functionName} (file: ${input.filePath})
\`\`\`
${context.targetCode}
\`\`\`
${callerSection}${calleeSection}${tableSection}${fileCtxSection}
## Instructions

Analyze ${input.functionName} and extract up to ${config.max_decisions} design decisions.

A design decision explains:
- WHY this approach was chosen over alternatives
- WHAT trade-offs were made
- WHAT alternatives were considered
${findingTypeDesc}

Return ONLY a raw JSON array (no markdown, no backticks):
[{
  "function": "${input.functionName}",
  "related_functions": ["otherFunc1"],
  "summary": "${summaryGuide} — the decision with enough context to understand without seeing the code",
  "content": "200-600 chars explaining WHY, trade-offs, alternatives",
  "keywords": ["keyword1", "keyword2"],
  "finding_type": "${config.finding_types[0]}"${config.finding_types.includes('bug') || config.finding_types.includes('suboptimal') ? ',\n  "critique": "only for suboptimal/bug"' : ''}
}]

Empty array [] if no decisions worth recording.${langGuide}`
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

    // 10. 构建 prompt
    const prompt = buildPrompt(input, config, context)

    // 11. 调 AI
    const appConfig = loadConfig()
    const aiConfig = config.ai_provider || config.model
      ? { ...appConfig.ai, ...(config.ai_provider ? { provider: config.ai_provider } : {}), ...(config.model ? { model: config.model } : {}) }
      : appConfig.ai
    const ai = createAIProvider(aiConfig)

    const raw = await ai.call(prompt, { timeoutMs: config.timeout_ms })

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
    if (ownSession) {
      await session.close()
    }
  }
}
