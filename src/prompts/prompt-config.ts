/**
 * prompts/prompt-config.ts
 *
 * 多 pipeline 可定制化 prompt 模板系统。
 *
 * 每条 pipeline 是 data/pipelines/<pipelineId>/ 下的三个文件：
 *   pipeline.json   — round 定义（id, name, variables 等）
 *   templates.json   — 默认模板（{{placeholder}} 文本）
 *   overrides.json   — 用户在 Dashboard 里编辑的模板覆盖
 *
 * cold-start-v2.ts 调用 createCustomPromptBuilders('cold-start') 获取可插拔的 prompt builder。
 */

import fs from 'fs'
import path from 'path'
import {
  PromptBuilders,
  FileEntry, FunctionTriageEntry, CallerCalleeCode, BusinessContext,
  DecisionSummaryForGrouping, DecisionFullContent,
} from './cold-start'

// ── Types ───────────────────────────────────────────────

export interface PromptVariable {
  name: string
  description: string
}

export interface RoundDef {
  id: string
  name: string
  shortName: string
  description: string
  aiCalls: string
  inputDesc: string
  outputDesc: string
  variables: PromptVariable[]
}

export interface PipelineDef {
  id: string
  name: string
  description: string
  status?: string   // "draft" = no execution engine yet
  rounds: RoundDef[]
}

// ── File Paths ──────────────────────────────────────────

const PIPELINES_DIR = path.resolve(__dirname, '../../data/pipelines')

function pipelinePath(pipelineId: string): string {
  return path.join(PIPELINES_DIR, pipelineId)
}

// ── Pipeline Loading ────────────────────────────────────

export function listPipelines(): PipelineDef[] {
  try {
    const dirs = fs.readdirSync(PIPELINES_DIR).filter(d =>
      fs.statSync(path.join(PIPELINES_DIR, d)).isDirectory() &&
      fs.existsSync(path.join(PIPELINES_DIR, d, 'pipeline.json'))
    )
    return dirs.map(d => loadPipeline(d)).filter((p): p is PipelineDef => p !== null)
  } catch {
    return []
  }
}

export function loadPipeline(pipelineId: string): PipelineDef | null {
  try {
    const filePath = path.join(pipelinePath(pipelineId), 'pipeline.json')
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

// ── Template Loading ────────────────────────────────────

function loadTemplates(pipelineId: string): Record<string, string> {
  try {
    const filePath = path.join(pipelinePath(pipelineId), 'templates.json')
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return {}
  }
}

export function loadPromptOverrides(pipelineId: string): Record<string, string> {
  try {
    const filePath = path.join(pipelinePath(pipelineId), 'overrides.json')
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch {}
  return {}
}

export function savePromptOverride(pipelineId: string, roundId: string, template: string): void {
  const overrides = loadPromptOverrides(pipelineId)
  overrides[roundId] = template
  const filePath = path.join(pipelinePath(pipelineId), 'overrides.json')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(overrides, null, 2))
}

export function deletePromptOverride(pipelineId: string, roundId: string): void {
  const overrides = loadPromptOverrides(pipelineId)
  delete overrides[roundId]
  const filePath = path.join(pipelinePath(pipelineId), 'overrides.json')
  fs.writeFileSync(filePath, JSON.stringify(overrides, null, 2))
}

export function getDefaultTemplates(pipelineId: string): Record<string, string> {
  return loadTemplates(pipelineId)
}

export function getTemplate(pipelineId: string, roundId: string): { template: string; isCustom: boolean } {
  const overrides = loadPromptOverrides(pipelineId)
  if (overrides[roundId]) {
    return { template: overrides[roundId], isCustom: true }
  }
  const defaults = loadTemplates(pipelineId)
  return { template: defaults[roundId] ?? '', isCustom: false }
}

// ── Variable Preparation (cold-start specific) ──────────
// 这些函数跟 cold-start pipeline 的 round 绑定。
// 未来 full-analysis 会有自己的 variable prep 函数。

function prepareScopeVars(goal: string, files: FileEntry[]): Record<string, string> {
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

  return { goal, fileList }
}

function prepareTriageVars(
  filePath: string, code: string, functions: FunctionTriageEntry[],
  businessContext: BusinessContext[], goal: string
): Record<string, string> {
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

  return { goal, businessContext: bizSection, filePath, functionList: fnList, code }
}

function prepareDeepAnalysisVars(
  fnName: string, fnCode: string, filePath: string,
  callers: CallerCalleeCode[], callees: CallerCalleeCode[],
  businessContext: BusinessContext[], goal: string
): Record<string, string> {
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

  return {
    goal, businessContext: bizSection, functionName: fnName,
    filePath, functionCode: fnCode, callerSection, calleeSection,
  }
}

function prepareGroupingVars(
  decisions: DecisionSummaryForGrouping[], cpgHints: string[]
): Record<string, string> {
  const decisionList = decisions.map((d, i) =>
    `  ${i + 1}. [${d.id}] ${d.file}::${d.function}\n     ${d.summary}\n     Keywords: ${d.keywords.join(', ')}`
  ).join('\n')

  const cpgSection = cpgHints.length > 0
    ? `\n## Code structure hints (from static analysis):\n${cpgHints.map(h => `  - ${h}`).join('\n')}\n`
    : ''

  return { decisionList, cpgSection }
}

function prepareRelationshipVars(
  decisions: DecisionFullContent[], groupReason: string
): Record<string, string> {
  const decisionList = decisions.map((d, i) =>
    `### ${i + 1}. [${d.id}] ${d.file}::${d.function}\n**Summary:** ${d.summary}\n**Detail:** ${d.content}\n**Keywords:** ${d.keywords.join(', ')}`
  ).join('\n\n')

  return { groupReason, decisionList }
}

function prepareKeywordNormalizationVars(allKeywords: string[]): Record<string, string> {
  const unique = [...new Set(allKeywords)].sort()
  const keywordList = unique.map(k => `  - ${k}`).join('\n')
  return { keywordList }
}

// ── Template Rendering ──────────────────────────────────

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{{${key}}}`).join(value)
  }
  return result
}

// ── Factory ─────────────────────────────────────────────

/**
 * 创建使用模板系统的 PromptBuilders。
 * pipelineId 指定从哪条 pipeline 加载模板。
 */
export function createCustomPromptBuilders(pipelineId: string = 'cold-start'): PromptBuilders {
  const overrides = loadPromptOverrides(pipelineId)
  const defaults = loadTemplates(pipelineId)
  const t = (roundId: string) => overrides[roundId] ?? defaults[roundId] ?? ''

  return {
    scope: (goal, files) =>
      renderTemplate(t('scope'), prepareScopeVars(goal, files)),

    triage: (filePath, code, functions, businessContext, goal) =>
      renderTemplate(t('triage'), prepareTriageVars(filePath, code, functions, businessContext, goal)),

    deepAnalysis: (fnName, fnCode, filePath, callers, callees, businessContext, goal) =>
      renderTemplate(t('deepAnalysis'), prepareDeepAnalysisVars(fnName, fnCode, filePath, callers, callees, businessContext, goal)),

    grouping: (decisions, cpgHints) =>
      renderTemplate(t('grouping'), prepareGroupingVars(decisions, cpgHints)),

    relationship: (decisions, groupReason) =>
      renderTemplate(t('relationship'), prepareRelationshipVars(decisions, groupReason)),

    keywordNormalization: (allKeywords) =>
      renderTemplate(t('keywordNormalization'), prepareKeywordNormalizationVars(allKeywords)),
  }
}
