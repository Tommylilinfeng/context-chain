/**
 * MCP Server — Context Knowledge Graph
 *
 * 工具列表：
 * 1. get_code_structure   — 查某个文件/服务下有哪些函数
 * 2. get_callers          — 查谁调用了某个函数
 * 3. get_callees          — 查某个函数调用了谁
 * 4. get_context_for_code — 查某个文件/函数相关的设计决策
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'

const server = new McpServer({
  name: 'context-knowledge-graph',
  version: '0.1.0',
})

// ─────────────────────────────────────────────────────────
// 工具 1：get_code_structure
// ─────────────────────────────────────────────────────────

server.tool(
  'get_code_structure',
  '查询代码结构：某个文件或服务下有哪些函数。输入文件名或服务名，返回函数列表和行号。',
  {
    name: z.string().describe('文件名（如 cartStore.js）或服务名（如 bite-me-website）'),
    entity_type: z.enum(['file', 'service']).optional().describe('节点类型，默认自动推断'),
  },
  async ({ name, entity_type }) => {
    const session = await getSession()
    try {
      const result = await session.run(
        `MATCH (parent:CodeEntity {name: $name})
         MATCH (parent)-[:CONTAINS*1..2]->(fn:CodeEntity {entity_type: 'function'})
         RETURN parent.name AS parent,
                parent.entity_type AS parent_type,
                fn.name AS fn_name,
                fn.path AS path,
                fn.line_start AS line_start,
                fn.line_end AS line_end
         ORDER BY fn.line_start`,
        { name, entity_type: entity_type ?? null }
      )

      if (result.records.length === 0) {
        return { content: [{ type: 'text', text: `未找到 "${name}" 的代码结构。` }] }
      }

      const parent = result.records[0].get('parent')
      const parentType = result.records[0].get('parent_type')
      const functions = result.records.map(r => ({
        name: r.get('fn_name'),
        path: r.get('path'),
        line_start: r.get('line_start'),
        line_end: r.get('line_end'),
      }))

      const text = [
        `📁 ${parentType}: ${parent}`,
        `函数数量: ${functions.length}`,
        '',
        ...functions.map(fn => `  • ${fn.name}()  [行 ${fn.line_start}–${fn.line_end}]  ${fn.path}`),
      ].join('\n')

      return { content: [{ type: 'text', text }] }
    } finally {
      await session.close()
    }
  }
)

// ─────────────────────────────────────────────────────────
// 工具 2：get_callers
// ─────────────────────────────────────────────────────────

server.tool(
  'get_callers',
  '查询谁调用了某个函数。帮助理解修改一个函数会影响哪些地方。',
  {
    function_name: z.string().describe('函数名，如 createOrder'),
    limit: z.number().optional().describe('返回数量上限，默认 20'),
  },
  async ({ function_name, limit = 20 }) => {
    const session = await getSession()
    try {
      const result = await session.run(
        `MATCH (caller:CodeEntity {entity_type: 'function'})-[:CALLS]->(callee:CodeEntity {name: $fn_name})
         RETURN caller.name AS caller_name, caller.path AS caller_path, caller.line_start AS line_start
         ORDER BY caller.path LIMIT $limit`,
        { fn_name: function_name, limit }
      )

      if (result.records.length === 0) {
        return { content: [{ type: 'text', text: `未找到调用 "${function_name}" 的函数。` }] }
      }

      const callers = result.records.map(r => ({
        name: r.get('caller_name'), path: r.get('caller_path'), line: r.get('line_start'),
      }))

      const text = [
        `📞 调用 ${function_name}() 的函数（共 ${callers.length} 个）：`,
        '',
        ...callers.map(c => `  • ${c.name}()  ${c.path}:${c.line}`),
      ].join('\n')

      return { content: [{ type: 'text', text }] }
    } finally {
      await session.close()
    }
  }
)

// ─────────────────────────────────────────────────────────
// 工具 3：get_callees
// ─────────────────────────────────────────────────────────

server.tool(
  'get_callees',
  '查询某个函数调用了哪些其他函数。帮助理解一个函数的依赖链。',
  {
    function_name: z.string().describe('函数名，如 createOrder'),
    limit: z.number().optional().describe('返回数量上限，默认 20'),
  },
  async ({ function_name, limit = 20 }) => {
    const session = await getSession()
    try {
      const result = await session.run(
        `MATCH (caller:CodeEntity {name: $fn_name, entity_type: 'function'})-[:CALLS]->(callee:CodeEntity)
         RETURN callee.name AS callee_name, callee.path AS callee_path, callee.entity_type AS callee_type
         ORDER BY callee.path LIMIT $limit`,
        { fn_name: function_name, limit }
      )

      if (result.records.length === 0) {
        return { content: [{ type: 'text', text: `"${function_name}" 没有调用其他函数，或名称有误。` }] }
      }

      const callees = result.records.map(r => ({
        name: r.get('callee_name'), path: r.get('callee_path'),
      }))

      const text = [
        `🔗 ${function_name}() 调用的函数（共 ${callees.length} 个）：`,
        '',
        ...callees.map(c => `  • ${c.name}()  ${c.path ?? '(外部)'}`),
      ].join('\n')

      return { content: [{ type: 'text', text }] }
    } finally {
      await session.close()
    }
  }
)

// ─────────────────────────────────────────────────────────
// 工具 4：get_context_for_code  ← 新增
// 查某个文件或函数相关的设计决策
// ─────────────────────────────────────────────────────────

server.tool(
  'get_context_for_code',
  '查询某个文件或函数背后的设计决策。回答"为什么这样写"、"当时考虑过哪些方案"、"有什么 trade-off"。',
  {
    name: z.string().describe('文件名（如 orderService.js）或函数名（如 createOrder）'),
    type: z.enum(['file', 'function']).optional().describe('查文件级别还是函数级别的决策，默认两者都查'),
  },
  async ({ name, type }) => {
    const session = await getSession()
    try {
      // 先查精确锚定的决策（ANCHORED_TO）
      const exactResult = await session.run(
        `MATCH (d:DecisionContext)-[:ANCHORED_TO]->(ce:CodeEntity {name: $name})
         WHERE d.staleness = 'active'
         ${type ? 'AND ce.entity_type = $type' : ''}
         RETURN d.summary AS summary, d.content AS content, d.keywords AS keywords,
                d.owner AS owner, d.created_at AS created_at, ce.name AS anchor
         ORDER BY d.created_at DESC
         LIMIT 10`,
        { name, type: type ?? null }
      )

      // 再查模糊锚定的决策（APPROXIMATE_TO）
      const approxResult = await session.run(
        `MATCH (d:DecisionContext)-[:APPROXIMATE_TO]->(ce:CodeEntity {name: $name})
         WHERE d.staleness = 'active'
         RETURN d.summary AS summary, d.content AS content, d.keywords AS keywords,
                d.owner AS owner, d.created_at AS created_at, ce.name AS anchor
         ORDER BY d.created_at DESC
         LIMIT 5`,
        { name }
      )

      const exact = exactResult.records
      const approx = approxResult.records

      if (exact.length === 0 && approx.length === 0) {
        return {
          content: [{ type: 'text', text: `暂无 "${name}" 相关的设计决策记录。` }],
        }
      }

      const lines: string[] = [`💡 "${name}" 相关设计决策\n`]

      if (exact.length > 0) {
        lines.push(`── 精确匹配（${exact.length} 条）──`)
        for (const r of exact) {
          lines.push(`\n▶ ${r.get('summary')}`)
          lines.push(`  ${r.get('content')}`)
          const kw = r.get('keywords')
          if (kw?.length) lines.push(`  关键词: ${kw.join(', ')}`)
        }
      }

      if (approx.length > 0) {
        lines.push(`\n── 相关匹配（${approx.length} 条）──`)
        for (const r of approx) {
          lines.push(`\n▶ ${r.get('summary')}`)
          lines.push(`  ${r.get('content')}`)
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] }
    } finally {
      await session.close()
    }
  }
)

// ─────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────

async function main() {
  await verifyConnectivity()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('✅ CKG MCP Server 已启动\n')
}

main().catch(err => {
  process.stderr.write(`MCP Server 启动失败: ${err.message}\n`)
  closeDriver()
  process.exit(1)
})
