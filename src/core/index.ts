/**
 * core/index.ts
 *
 * 公共 API — 用户可以 import 这些来构建自己的 pipeline。
 */

export { analyzeFunction } from './analyze-function'
export { loadTemplate, listTemplates, saveTemplate, deleteTemplate, getDefaultConfig } from './template-loader'
export { cleanupPipelineSessions } from './session-cleanup'
export type {
  AnalyzeFunctionConfig,
  AnalyzeFunctionInput,
  AnalyzeFunctionResult,
  AnalysisTemplate,
  PendingDecisionOutput,
  ExtractedDecision,
  CodeSnippet,
  FunctionContext,
} from './types'
