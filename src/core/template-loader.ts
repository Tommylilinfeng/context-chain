/**
 * core/template-loader.ts
 *
 * 模板加载、继承、合并逻辑。
 *
 * 模板文件在 templates/ 目录下，每个 JSON 文件一个模板。
 * _default.json 是内置默认值，所有模板隐式继承它。
 * 用户模板只需写想 override 的字段。
 *
 * 加载逻辑：deepMerge(_default, parentTemplate, userTemplate, runtimeOverrides)
 */

import fs from 'fs'
import path from 'path'
import { AnalyzeFunctionConfig, AnalysisTemplate } from './types'

const TEMPLATES_DIR = path.resolve(__dirname, '../../templates')

// ── Deep merge ──────────────────────────────────────────

function deepMerge<T extends Record<string, any>>(...sources: Partial<T>[]): T {
  const result: Record<string, any> = {}
  for (const source of sources) {
    if (!source) continue
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        result[key] = [...value]  // arrays: replace, don't concat
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = deepMerge(result[key] ?? {}, value)
      } else {
        result[key] = value
      }
    }
  }
  return result as T
}

// ── Load single template file ───────────────────────────

function loadTemplateFile(name: string): AnalysisTemplate | null {
  const filePath = path.join(TEMPLATES_DIR, `${name}.json`)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (err: any) {
    console.error(`⚠️ Failed to load template "${name}": ${err.message}`)
    return null
  }
}

// ── Resolve inheritance chain ───────────────────────────

function resolveChain(name: string, visited = new Set<string>()): AnalysisTemplate[] {
  if (visited.has(name)) {
    console.error(`⚠️ Circular template inheritance: ${[...visited, name].join(' → ')}`)
    return []
  }
  visited.add(name)

  const template = loadTemplateFile(name)
  if (!template) return []

  const parentName = template.extends ?? (name === '_default' ? undefined : '_default')
  const parentChain = parentName ? resolveChain(parentName, visited) : []

  return [...parentChain, template]
}

// ── Public API ──────────────────────────────────────────

/**
 * 加载并合并模板，返回完整的 AnalyzeFunctionConfig。
 *
 * 合并优先级（后面覆盖前面）：
 *   _default.json → 中间继承链 → 目标模板 → runtimeOverrides
 */
export function loadTemplate(
  templateName: string = '_default',
  runtimeOverrides?: Partial<AnalyzeFunctionConfig>
): { config: AnalyzeFunctionConfig; templateName: string } {
  const chain = resolveChain(templateName)

  if (chain.length === 0) {
    console.error(`⚠️ Template "${templateName}" not found, falling back to _default`)
    const defaultChain = resolveChain('_default')
    if (defaultChain.length === 0) {
      throw new Error('_default.json template not found in templates/ directory')
    }
    return {
      config: deepMerge(...defaultChain, runtimeOverrides ?? {}) as AnalyzeFunctionConfig,
      templateName: '_default',
    }
  }

  const config = deepMerge(...chain, runtimeOverrides ?? {}) as AnalyzeFunctionConfig
  return { config, templateName }
}

/**
 * 列出所有可用模板。
 */
export function listTemplates(): { name: string; description: string; extends?: string }[] {
  if (!fs.existsSync(TEMPLATES_DIR)) return []
  try {
    return fs.readdirSync(TEMPLATES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const name = f.replace('.json', '')
        const template = loadTemplateFile(name)
        return template ? {
          name,
          description: template.description ?? '',
          extends: template.extends,
        } : null
      })
      .filter((t): t is NonNullable<typeof t> => t !== null)
  } catch {
    return []
  }
}

/**
 * 保存用户模板。
 */
export function saveTemplate(name: string, template: AnalysisTemplate): void {
  if (name === '_default') {
    throw new Error('Cannot overwrite _default template')
  }
  const filePath = path.join(TEMPLATES_DIR, `${name}.json`)
  fs.writeFileSync(filePath, JSON.stringify(template, null, 2))
}

/**
 * 删除用户模板。
 */
export function deleteTemplate(name: string): boolean {
  if (name === '_default') return false
  const filePath = path.join(TEMPLATES_DIR, `${name}.json`)
  if (!fs.existsSync(filePath)) return false
  fs.unlinkSync(filePath)
  return true
}

/**
 * 获取 _default 的完整配置（用于 Dashboard 展示全量字段）。
 */
export function getDefaultConfig(): AnalyzeFunctionConfig {
  const { config } = loadTemplate('_default')
  return config
}
