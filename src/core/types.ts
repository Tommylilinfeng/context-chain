/**
 * core/types.ts
 *
 * analyze_function 核心模块的类型定义。
 * 这是整个系统最重要的 building block 的接口契约。
 */

// ── 配置 ────────────────────────────────────────────────

export interface AnalyzeFunctionConfig {
  // ── 上下文深度 ──
  /** 向上看几层调用者 (0=不看, 1=直接callers, 2=caller的caller) */
  caller_depth: number
  /** 向下看几层被调用者 */
  callee_depth: number
  /** 每层最多看几个 caller */
  max_callers_per_level: number
  /** 每层最多看几个 callee */
  max_callees_per_level: number
  /** 是否包含跨 repo 的 callers/callees */
  include_cross_repo: boolean
  /** 是否包含数据库表访问信息 */
  include_table_access: boolean

  // ── 代码粒度 ──
  /** 目标函数代码给多少 */
  target_code: 'full' | 'truncated' | 'signature_only'
  /** truncated 模式下截断到多少行 */
  target_max_lines: number
  /** callers 代码给多少 */
  caller_code: 'full' | 'truncated' | 'signature_only' | 'name_only'
  /** callees 代码给多少 */
  callee_code: 'full' | 'truncated' | 'signature_only' | 'name_only'
  /** caller 代码截断行数 */
  caller_max_lines: number
  /** callee 代码截断行数 */
  callee_max_lines: number
  /** 是否给函数所在文件的其他函数签名（帮助理解模块结构） */
  include_file_context: boolean

  // ── 输出控制 ──
  /** 想要提取哪些类型 */
  finding_types: ('decision' | 'suboptimal' | 'bug')[]
  /** 每个函数最多提取几条 */
  max_decisions: number
  /** 摘要详细程度 */
  summary_length: 'short' | 'medium' | 'long'
  /** 是否提取关键词 */
  extract_keywords: boolean
  /** 输出语言 */
  language: 'zh' | 'en' | 'auto'

  // ── Prompt ──
  /** 自定义 prompt 模板（{{variable}} 占位符），不传则用内置默认 */
  prompt_template?: string
  /** 可选 system prompt */
  system_prompt?: string
  /** 用户额外 context（如 "这是一个外卖平台"） */
  custom_context?: string

  // ── Business context ──
  /** 是否从图谱加载 business context */
  include_business_context: boolean

  // ── AI ──
  /** AI provider override（不传则用 ckg.config.json 的默认） */
  ai_provider?: string
  /** 模型 override */
  model?: string
  /** 超时时间 */
  timeout_ms: number
}

// ── 模板文件格式 ────────────────────────────────────────

export interface AnalysisTemplate extends Partial<AnalyzeFunctionConfig> {
  /** 模板名称 */
  name: string
  /** 模板描述 */
  description: string
  /** 继承哪个模板（默认 _default） */
  extends?: string
}

// ── 输入 ────────────────────────────────────────────────

export interface AnalyzeFunctionInput {
  /** 目标函数名 */
  functionName: string
  /** 函数所在文件路径（repo 内相对路径，如 store/orderStore.js） */
  filePath: string
  /** repo 名（如 bite-me-website） */
  repo: string
  /** repo 磁盘绝对路径（用来读源码） */
  repoPath: string
  /** 函数起始行号（可选，不传则从图谱查） */
  lineStart?: number
  /** 函数结束行号 */
  lineEnd?: number
  /** 预读的函数代码（可选，不传则自动从磁盘读） */
  functionCode?: string
  /** Memgraph session（可选，不传则自己建） */
  session?: any  // neo4j Session type，避免强依赖
  /** 分析目标描述（可选，如 "订单流程和支付"） */
  goal?: string
  /** owner 标识 */
  owner?: string
}

// ── 输出 ────────────────────────────────────────────────

export interface ExtractedDecision {
  /** 决策关联的函数名 */
  function: string
  /** 相关函数列表 */
  related_functions: string[]
  /** 摘要 (20-50 words) */
  summary: string
  /** 完整描述 (200-600 chars) */
  content: string
  /** 关键词 */
  keywords: string[]
  /** 发现类型 */
  finding_type: 'decision' | 'suboptimal' | 'bug'
  /** 问题说明（仅 suboptimal/bug） */
  critique?: string
}

export interface AnalyzeFunctionResult {
  /** 目标函数名 */
  functionName: string
  /** 文件路径 */
  filePath: string
  /** repo 名 */
  repo: string
  /** 提取的决策（已格式化为可写入图谱的格式） */
  decisions: PendingDecisionOutput[]
  /** 元数据 */
  metadata: {
    template_used: string
    config_snapshot: Partial<AnalyzeFunctionConfig>
    caller_count: number
    callee_count: number
    token_usage?: { input_tokens: number; output_tokens: number }
    duration_ms: number
  }
}

/** 可直接传给 batchWriteDecisions 的格式 */
export interface PendingDecisionOutput {
  id: string
  props: Record<string, any>
  functionName: string
  relatedFunctions: string[]
  filePath: string
  fileName: string
  repo: string
}

// ── Caller/Callee 信息 ──────────────────────────────────

export interface CodeSnippet {
  name: string
  filePath: string
  code: string
  lineStart?: number
  lineEnd?: number
}

export interface FunctionContext {
  /** 目标函数代码 */
  targetCode: string
  /** 调用者代码片段 */
  callers: CodeSnippet[]
  /** 被调用者代码片段 */
  callees: CodeSnippet[]
  /** 数据库表访问信息 */
  tableAccess?: string[]
  /** 文件内其他函数签名 */
  fileContext?: string[]
  /** Business context */
  businessContext?: { summary: string; content: string }[]
}
