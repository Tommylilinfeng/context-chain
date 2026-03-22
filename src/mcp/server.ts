/**
 * MCP Server — Context Knowledge Graph
 *
 * 工具列表：
 * 1. get_code_structure           — 查某个文件/服务下有哪些函数
 * 2. get_callers                  — 查谁调用了某个函数
 * 3. get_callees                  — 查某个函数调用了谁
 * 4. search_decisions_by_keyword  — 按关键词搜索设计决策（倒排索引）
 * 5. get_context_for_code         — 五槽位融合检索 + 渐进披露（summary/detail/单条展开）
 * 6. search_decisions_semantic    — 语义向量搜索设计决策
 * 7. get_decision_relationships   — 查某个决策的因果/依赖/冲突关系链
 * 8. get_cross_repo_dependencies  — 查跨 repo / 跨服务的依赖关系
 * 9. report_context_usage         — 反馈回路：哪些决策被实际使用
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { EmbeddingProvider, createEmbeddingProvider, EmbeddingConfig } from '../ai/embeddings'
import { LocalVectorStore } from '../ai/vector-store'

// ── 语义搜索懒加载状态 ──
let embeddingProvider: EmbeddingProvider | null = null
let vectorStore: LocalVectorStore | null = null

async function initEmbedding(): Promise<void> {
  // 动态加载 config 避免 MCP server 启动时就要求 config 文件
  const { loadConfig } = await import('../config')
  const config = loadConfig()
  const embCfg = config.ai?.embedding
  if (!embCfg) throw new Error('ai.embedding 未配置')

  embeddingProvider = createEmbeddingProvider(embCfg as EmbeddingConfig)
  vectorStore = new LocalVectorStore()
  await vectorStore.load()
  if (vectorStore.size === 0) {
    throw new Error('向量库为空，请先运行 npm run embed:decisions')
  }
}

const server = new McpServer({
  name: 'context-graph',
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
// 工具 4：search_decisions_by_keyword
// 按关键词搜索设计决策（关键词倒排索引）
// ─────────────────────────────────────────────────────────

server.tool(
  'search_decisions_by_keyword',
  '按关键词搜索设计决策。支持技术术语、中英文混合（如 "事务"、"RPC"、"认证"）。当你知道要找什么概念但不确定在哪个文件时使用。',
  {
    keyword: z.string().describe('关键词，如 "事务"、"RPC"、"认证"'),
    limit: z.number().optional().describe('返回上限，默认 10'),
  },
  async ({ keyword, limit = 10 }) => {
    const session = await getSession()
    try {
      // 1. 精确关键词匹配（走 keywords 数组）
      const kwResult = await session.run(
        `MATCH (d:DecisionContext)
         WHERE d.staleness = 'active'
           AND ANY(k IN d.keywords WHERE toLower(k) CONTAINS toLower($kw))
         OPTIONAL MATCH (d)-[r:ANCHORED_TO|APPROXIMATE_TO]->(ce:CodeEntity)
         RETURN d.id AS id, d.summary AS summary, d.content AS content,
                d.keywords AS keywords, d.finding_type AS finding_type,
                collect(DISTINCT ce.name) AS anchors
         ORDER BY d.created_at DESC
         LIMIT $limit`,
        { kw: keyword, limit }
      )

      const kwIds = new Set(kwResult.records.map(r => r.get('id')))

      // 2. 全文搜索兜底（走 text index on summary + content）
      let textRecords: any[] = []
      const remaining = limit - kwIds.size
      if (remaining > 0) {
        try {
          const textResult = await session.run(
            `CALL text_search.search_all("idx_decision", $kw)
             YIELD node, score
             WHERE node.staleness = 'active' AND NOT node.id IN $existing
             WITH node AS d, score
             OPTIONAL MATCH (d)-[r:ANCHORED_TO|APPROXIMATE_TO]->(ce:CodeEntity)
             RETURN d.id AS id, d.summary AS summary, d.content AS content,
                    d.keywords AS keywords, d.finding_type AS finding_type,
                    collect(DISTINCT ce.name) AS anchors, score
             ORDER BY score DESC
             LIMIT $remaining`,
            { kw: keyword, existing: [...kwIds], remaining }
          )
          textRecords = textResult.records
        } catch {
          // text search 可能不可用，静默降级
        }
      }

      const allRecords = [...kwResult.records, ...textRecords]

      if (allRecords.length === 0) {
        return { content: [{ type: 'text', text: `未找到关键词 "${keyword}" 相关的设计决策。` }] }
      }

      const lines: string[] = [`🔑 关键词 "${keyword}" 相关决策（${allRecords.length} 条）\n`]

      for (const r of allRecords) {
        const anchors = r.get('anchors')?.filter(Boolean) ?? []
        lines.push(`▶ ${r.get('summary')}`)
        lines.push(`  ${r.get('content')}`)
        const kw = r.get('keywords')
        if (kw?.length) lines.push(`  关键词: ${kw.join(', ')}`)
        if (anchors.length > 0) lines.push(`  锚点: ${anchors.join(', ')}`)
        const ft = r.get('finding_type')
        if (ft && ft !== 'decision') lines.push(`  类型: ${ft}`)
        lines.push('')
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] }
    } finally {
      await session.close()
    }
  }
)

// ─────────────────────────────────────────────────────────
// 工具 5：get_context_for_code
// 五槽位融合检索 + 渐进披露（summary → detail）
// ─────────────────────────────────────────────────────────

interface HitDecision {
  id: string
  summary: string
  content: string
  keywords: string[]
  finding_type: string
  source: string   // '锚点' | '文件' | '关键词' | '关联' | '向量'
  priority: number // P0-P4
  extra?: string   // 关系类型、相似度等附加信息
}

server.tool(
  'get_context_for_code',
  '查询某个文件或函数背后的设计决策（五通道融合检索）。默认返回摘要列表，传 detail=true 返回完整内容，传 decision_id 展开单条决策。',
  {
    name: z.string().describe('文件名（如 orderService.js）或函数名（如 createOrder）'),
    type: z.enum(['file', 'function']).optional().describe('查文件级别还是函数级别的决策，默认两者都查'),
    detail: z.boolean().optional().describe('true 返回完整内容，false（默认）只返回摘要列表'),
    decision_id: z.string().optional().describe('指定某条决策 ID（以 dc: 开头），展开完整内容 + 关系链'),
  },
  async ({ name, type, detail = false, decision_id }) => {
    const session = await getSession()
    try {
      // ── 单条展开模式 ──
      if (decision_id) {
        const r = await session.run(
          `MATCH (d:DecisionContext {id: $id})
           OPTIONAL MATCH (d)-[ar:ANCHORED_TO|APPROXIMATE_TO]->(ce:CodeEntity)
           RETURN d.id AS id, d.summary AS summary, d.content AS content,
                  d.keywords AS keywords, d.finding_type AS finding_type,
                  d.owner AS owner, d.created_at AS created_at, d.use_count AS use_count,
                  collect(DISTINCT {name: ce.name, path: ce.path, type: type(ar)}) AS anchors`,
          { id: decision_id }
        )
        if (r.records.length === 0) {
          return { content: [{ type: 'text', text: `未找到决策 "${decision_id}"` }] }
        }
        const d = r.records[0]
        const lines: string[] = [
          `💡 决策详情\n`,
          `▶ ${d.get('summary')}`,
          `  ${d.get('content')}`,
        ]
        const kw = d.get('keywords')
        if (kw?.length) lines.push(`  关键词: ${kw.join(', ')}`)
        const ft = d.get('finding_type')
        if (ft && ft !== 'decision') lines.push(`  类型: ${ft}`)
        lines.push(`  创建者: ${d.get('owner') ?? '-'}  创建时间: ${d.get('created_at') ?? '-'}`)
        const uc = d.get('use_count')
        if (uc && (typeof uc === 'number' ? uc > 0 : uc.toNumber() > 0)) lines.push(`  使用次数: ${uc}`)

        const anchors = d.get('anchors')?.filter((a: any) => a.name) ?? []
        if (anchors.length > 0) {
          lines.push(`\n── 锚点 ──`)
          for (const a of anchors) lines.push(`  ${a.type === 'ANCHORED_TO' ? '精确' : '模糊'}: ${a.name}  ${a.path ?? ''}`)
        }

        // 2 跳关系链
        try {
          const relR = await session.run(
            `MATCH path = (start:DecisionContext {id: $id})-[:CAUSED_BY|DEPENDS_ON|CONFLICTS_WITH|CO_DECIDED*1..2]-(other:DecisionContext)
             WHERE other.staleness = 'active'
             WITH other, relationships(path) AS rels, length(path) AS dist
             RETURN DISTINCT other.id AS oid, other.summary AS summary, dist,
                    type(rels[0]) AS rel_type, (rels[0]).reason AS reason
             ORDER BY dist LIMIT 10`,
            { id: decision_id }
          )
          if (relR.records.length > 0) {
            lines.push(`\n── 关系链（${relR.records.length} 条）──`)
            for (const rr of relR.records) {
              const dist = typeof rr.get('dist') === 'number' ? rr.get('dist') : rr.get('dist')?.toNumber?.() ?? 0
              lines.push(`  ${'  '.repeat(dist - 1)}[${rr.get('rel_type')}] ${rr.get('summary')} (id: ${rr.get('oid')})`)
              const reason = rr.get('reason')
              if (reason) lines.push(`  ${'  '.repeat(dist - 1)}  ↳ ${reason}`)
            }
          }
        } catch {}

        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      // ── 五槽位融合检索 ──
      const seen = new Set<string>()
      const hits: HitDecision[] = []

      function addHit(id: string, summary: string, content: string, keywords: any, finding_type: any, source: string, priority: number, extra?: string) {
        if (!id || seen.has(id)) return
        seen.add(id)
        hits.push({ id, summary, content, keywords: keywords ?? [], finding_type: finding_type ?? 'decision', source, priority, extra })
      }

      // P0 + P1: 锚点查询
      const anchorResult = await session.run(
        `MATCH (d:DecisionContext)-[r:ANCHORED_TO|APPROXIMATE_TO]->(ce:CodeEntity {name: $name})
         WHERE d.staleness = 'active'
         ${type ? 'AND ce.entity_type = $type' : ''}
         RETURN d.id AS id, d.summary AS summary, d.content AS content, d.keywords AS keywords,
                d.finding_type AS finding_type, type(r) AS match_type
         ORDER BY CASE type(r) WHEN 'ANCHORED_TO' THEN 0 ELSE 1 END, d.created_at DESC
         LIMIT 10`,
        { name, type: type ?? null }
      )
      for (const r of anchorResult.records) {
        const isExact = r.get('match_type') === 'ANCHORED_TO'
        addHit(r.get('id'), r.get('summary'), r.get('content'), r.get('keywords'), r.get('finding_type'),
          isExact ? '锚点' : '文件', isExact ? 0 : 1)
      }

      // P2: 关键词匹配
      try {
        const kwResult = await session.run(
          `MATCH (d:DecisionContext)
           WHERE d.staleness = 'active'
             AND ANY(k IN d.keywords WHERE toLower(k) CONTAINS toLower($name))
           RETURN d.id AS id, d.summary AS summary, d.content AS content,
                  d.keywords AS keywords, d.finding_type AS finding_type
           ORDER BY d.created_at DESC LIMIT 5`,
          { name }
        )
        for (const r of kwResult.records) {
          addHit(r.get('id'), r.get('summary'), r.get('content'), r.get('keywords'), r.get('finding_type'), '关键词', 2)
        }
      } catch {}

      // P3: 关系边展开（对 P0-P2 命中的做一跳展开）
      const hitIdsSoFar = [...seen]
      if (hitIdsSoFar.length > 0) {
        try {
          const relResult = await session.run(
            `UNWIND $ids AS did
             MATCH (d:DecisionContext {id: did})-[r:CAUSED_BY|DEPENDS_ON|CONFLICTS_WITH|CO_DECIDED]-(related:DecisionContext)
             WHERE related.staleness = 'active' AND NOT related.id IN $ids
             RETURN DISTINCT related.id AS id, related.summary AS summary, related.content AS content,
                    related.keywords AS keywords, related.finding_type AS finding_type,
                    type(r) AS rel_type
             LIMIT 5`,
            { ids: hitIdsSoFar }
          )
          for (const r of relResult.records) {
            addHit(r.get('id'), r.get('summary'), r.get('content'), r.get('keywords'), r.get('finding_type'),
              '关联', 3, r.get('rel_type'))
          }
        } catch {}
      }

      // P4: 向量搜索（如果可用）
      try {
        if (!embeddingProvider || !vectorStore) await initEmbedding()
        if (embeddingProvider && vectorStore && vectorStore.size > 0) {
          const [qEmb] = await embeddingProvider.embed([name], 'query')
          const vecResults = vectorStore.search(qEmb, 5)
            .filter(v => v.score > 0.3 && !seen.has(v.id))
          if (vecResults.length > 0) {
            const vecIds = vecResults.map(v => v.id)
            const scoreMap = new Map(vecResults.map(v => [v.id, v.score]))
            const vecDetail = await session.run(
              `UNWIND $ids AS did
               MATCH (d:DecisionContext {id: did})
               WHERE d.staleness = 'active'
               RETURN d.id AS id, d.summary AS summary, d.content AS content,
                      d.keywords AS keywords, d.finding_type AS finding_type`,
              { ids: vecIds }
            )
            for (const r of vecDetail.records) {
              const score = scoreMap.get(r.get('id')) ?? 0
              addHit(r.get('id'), r.get('summary'), r.get('content'), r.get('keywords'), r.get('finding_type'),
                '向量', 4, `${(score * 100).toFixed(0)}%`)
            }
          }
        }
      } catch {
        // 向量不可用，静默跳过
      }

      // ── 合并输出 ──
      hits.sort((a, b) => a.priority - b.priority)
      const top = hits.slice(0, 15)

      if (top.length === 0) {
        return { content: [{ type: 'text', text: `暂无 "${name}" 相关的设计决策记录。` }] }
      }

      const lines: string[] = []

      if (detail) {
        // ── Detail 模式：完整内容 ──
        lines.push(`💡 "${name}" 相关决策（${top.length} 条，完整模式）\n`)
        for (const h of top) {
          const tag = h.extra ? `${h.source}·${h.extra}` : h.source
          lines.push(`▶ [${tag}] ${h.summary}  (id: ${h.id})`)
          lines.push(`  ${h.content}`)
          if (h.keywords.length) lines.push(`  关键词: ${h.keywords.join(', ')}`)
          if (h.finding_type !== 'decision') lines.push(`  类型: ${h.finding_type}`)
          lines.push('')
        }
      } else {
        // ── Summary 模式：一行一条 ──
        lines.push(`💡 "${name}" 相关决策（${top.length} 条）\n`)
        for (let i = 0; i < top.length; i++) {
          const h = top[i]
          const tag = h.extra ? `${h.source}·${h.extra}` : h.source
          const kwSnippet = h.keywords.length > 0 ? `  [${h.keywords.slice(0, 3).join(', ')}]` : ''
          lines.push(`  ${i + 1}. [${tag}] ${h.summary}${kwSnippet}`)
        }
        lines.push(`\n需要详情？传 detail=true 或指定 decision_id 展开单条`)
      }

      // 附带 ID 列表，供反馈回路使用
      const idList = top.map(h => h.id)
      lines.push(`\n[返回的决策 ID: ${idList.join(', ')}]`)
      lines.push(`完成任务后请调用 report_context_usage(used_ids=[...]) 反馈实际参考了哪些决策`)

      return { content: [{ type: 'text', text: lines.join('\n') }] }
    } finally {
      await session.close()
    }
  }
)

// ─────────────────────────────────────────────────────────
// 工具 6：search_decisions_semantic
// 语义向量搜索设计决策
// ─────────────────────────────────────────────────────────

server.tool(
  'search_decisions_semantic',
  '语义搜索设计决策。用自然语言描述你要找的上下文（如 "为什么订单创建要用事务"），返回语义最相关的决策。需要先运行 embed:decisions 生成向量。',
  {
    query: z.string().describe('自然语言查询，如 "为什么订单创建要用事务"'),
    limit: z.number().optional().describe('返回上限，默认 5'),
  },
  async ({ query, limit = 5 }) => {
    const session = await getSession()
    try {
      // 懒加载 embedding provider 和 vector store
      if (!embeddingProvider || !vectorStore) {
        try {
          await initEmbedding()
        } catch (err: any) {
          return {
            content: [{
              type: 'text',
              text: `语义搜索未就绪: ${err.message}\n请先配置 ai.embedding 并运行 npm run embed:decisions`,
            }],
          }
        }
      }

      // 1. 生成查询向量
      const [queryEmbedding] = await embeddingProvider!.embed([query], 'query')

      // 2. 向量相似度搜索
      const results = vectorStore!.search(queryEmbedding, limit)

      if (results.length === 0) {
        return { content: [{ type: 'text', text: '向量库为空。请先运行 npm run embed:decisions 生成向量。' }] }
      }

      // 3. 从 Memgraph 加载决策详情
      const ids = results.map(r => r.id)
      const scoreMap = new Map(results.map(r => [r.id, r.score]))

      const detailResult = await session.run(
        `UNWIND $ids AS did
         MATCH (d:DecisionContext {id: did})
         OPTIONAL MATCH (d)-[:ANCHORED_TO|APPROXIMATE_TO]->(ce:CodeEntity)
         RETURN d.id AS id, d.summary AS summary, d.content AS content,
                d.keywords AS keywords, d.finding_type AS finding_type,
                collect(DISTINCT ce.name) AS anchors`,
        { ids }
      )

      const lines: string[] = [`🧠 语义搜索 "${query}" 结果（${detailResult.records.length} 条）\n`]

      for (const r of detailResult.records) {
        const id = r.get('id')
        const score = scoreMap.get(id) ?? 0
        const anchors = r.get('anchors')?.filter(Boolean) ?? []
        lines.push(`▶ ${r.get('summary')}  [相似度: ${(score * 100).toFixed(1)}%]`)
        lines.push(`  ${r.get('content')}`)
        const kw = r.get('keywords')
        if (kw?.length) lines.push(`  关键词: ${kw.join(', ')}`)
        if (anchors.length > 0) lines.push(`  锚点: ${anchors.join(', ')}`)
        lines.push('')
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] }
    } finally {
      await session.close()
    }
  }
)

// ─────────────────────────────────────────────────────────
// 工具 7：get_decision_relationships
// 查某个决策的因果/依赖/冲突关系链
// ─────────────────────────────────────────────────────────

server.tool(
  'get_decision_relationships',
  '查询一个设计决策的因果、依赖、冲突关系链。输入决策关键词（模糊匹配）或决策 ID，返回 N 跳内的关联决策网络。',
  {
    query: z.string().describe('决策摘要关键词（模糊匹配）或决策 ID（以 dc: 开头）'),
    depth: z.number().optional().describe('展开跳数，默认 2，最大 3'),
  },
  async ({ query, depth = 2 }) => {
    const session = await getSession()
    const maxDepth = Math.min(depth, 3)
    try {
      // 1. 找到目标决策
      let targetResult
      if (query.startsWith('dc:')) {
        targetResult = await session.run(
          `MATCH (d:DecisionContext {id: $id})
           RETURN d.id AS id, d.summary AS summary, d.content AS content`,
          { id: query }
        )
      } else {
        // 全文搜索
        try {
          targetResult = await session.run(
            `CALL text_search.search_all("idx_decision", $q)
             YIELD node, score
             RETURN node.id AS id, node.summary AS summary, node.content AS content
             ORDER BY score DESC LIMIT 1`,
            { q: query }
          )
        } catch {
          // text search 不可用，降级到 CONTAINS
          targetResult = await session.run(
            `MATCH (d:DecisionContext)
             WHERE d.summary CONTAINS $q
             RETURN d.id AS id, d.summary AS summary, d.content AS content
             LIMIT 1`,
            { q: query }
          )
        }
      }

      if (targetResult.records.length === 0) {
        return { content: [{ type: 'text', text: `未找到匹配 "${query}" 的决策。` }] }
      }

      const targetId = targetResult.records[0].get('id')
      const targetSummary = targetResult.records[0].get('summary')

      // 2. 沿关系边展开 N 跳
      const relResult = await session.run(
        `MATCH path = (start:DecisionContext {id: $id})-[:CAUSED_BY|DEPENDS_ON|CONFLICTS_WITH|CO_DECIDED*1..${maxDepth}]-(other:DecisionContext)
         WHERE other.staleness = 'active'
         WITH other, relationships(path) AS rels, nodes(path) AS ns, length(path) AS dist
         UNWIND range(0, size(rels)-1) AS i
         WITH other, dist,
              type(rels[i]) AS rel_type,
              (rels[i]).reason AS rel_reason,
              ns[i].summary AS from_summary,
              ns[i+1].summary AS to_summary
         RETURN DISTINCT other.id AS id, other.summary AS summary,
                dist, rel_type, rel_reason, from_summary, to_summary
         ORDER BY dist, rel_type`,
        { id: targetId }
      )

      const lines: string[] = [
        `🔗 "${targetSummary}" 的关系网络\n`,
        `起点: ${targetSummary}`,
        `展开深度: ${maxDepth} 跳`,
        '',
      ]

      if (relResult.records.length === 0) {
        lines.push('该决策暂无关联的因果/依赖/冲突关系。')
      } else {
        let currentDist = -1
        for (const r of relResult.records) {
          const dist = typeof r.get('dist') === 'number' ? r.get('dist') : r.get('dist')?.toNumber?.() ?? 0
          if (dist !== currentDist) {
            currentDist = dist
            lines.push(`── 第 ${dist} 跳 ──`)
          }
          const relType = r.get('rel_type')
          lines.push(`  [${relType}] ${r.get('from_summary')} → ${r.get('to_summary')}`)
          const reason = r.get('rel_reason')
          if (reason) lines.push(`    原因: ${reason}`)
        }
        lines.push(`\n共 ${relResult.records.length} 条关系`)
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] }
    } finally {
      await session.close()
    }
  }
)

// ─────────────────────────────────────────────────────────
// 工具 8：get_cross_repo_dependencies
// 查跨 repo / 跨服务的依赖关系
// ─────────────────────────────────────────────────────────

server.tool(
  'get_cross_repo_dependencies',
  '查询跨 repo 和跨服务的依赖关系。显示哪些 repo 之间有代码调用或 API 调用关系。',
  {
    repo: z.string().optional().describe('指定某个 repo 名，查它的所有跨 repo 依赖。不指定则查全部。'),
  },
  async ({ repo }) => {
    const session = await getSession()
    try {
      const lines: string[] = ['🌐 跨 Repo 依赖关系\n']

      // 1. 代码级别的跨 repo 调用（CALLS_CROSS_REPO）
      const codeResult = await session.run(
        repo
          ? `MATCH (caller:CodeEntity)-[r:CALLS_CROSS_REPO]->(callee:CodeEntity)
             WHERE caller.repo = $repo OR callee.repo = $repo
             RETURN caller.repo AS from_repo, caller.name AS caller_name,
                    callee.repo AS to_repo, callee.name AS callee_name, r.package AS package
             ORDER BY from_repo, to_repo`
          : `MATCH (caller:CodeEntity)-[r:CALLS_CROSS_REPO]->(callee:CodeEntity)
             RETURN caller.repo AS from_repo, caller.name AS caller_name,
                    callee.repo AS to_repo, callee.name AS callee_name, r.package AS package
             ORDER BY from_repo, to_repo`,
        repo ? { repo } : {}
      )

      if (codeResult.records.length > 0) {
        lines.push(`── 代码调用（${codeResult.records.length} 条）──`)
        for (const r of codeResult.records) {
          lines.push(`  ${r.get('from_repo')}::${r.get('caller_name')}() → ${r.get('to_repo')}::${r.get('callee_name')}()`)
        }
      }

      // 2. 服务级别的 API 依赖（DEPENDS_ON_API）
      const apiResult = await session.run(
        repo
          ? `MATCH (from:CodeEntity)-[r:DEPENDS_ON_API]->(to:CodeEntity)
             WHERE from.name = $repo OR to.name = $repo
             RETURN from.name AS from_repo, to.name AS to_repo,
                    r.connection_type AS conn_type, r.description AS description
             ORDER BY from_repo`
          : `MATCH (from:CodeEntity)-[r:DEPENDS_ON_API]->(to:CodeEntity)
             RETURN from.name AS from_repo, to.name AS to_repo,
                    r.connection_type AS conn_type, r.description AS description
             ORDER BY from_repo`,
        repo ? { repo } : {}
      )

      if (apiResult.records.length > 0) {
        lines.push(`\n── API/服务依赖（${apiResult.records.length} 条）──`)
        for (const r of apiResult.records) {
          lines.push(`  ${r.get('from_repo')} → ${r.get('to_repo')} [${r.get('conn_type')}]: ${r.get('description')}`)
        }
      }

      if (codeResult.records.length === 0 && apiResult.records.length === 0) {
        lines.push('暂无跨 repo 依赖记录。请先运行 link:repos 和 link:services。')
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] }
    } finally {
      await session.close()
    }
  }
)

// ─────────────────────────────────────────────────────────
// 工具 9：report_context_usage
// 反馈回路：追踪哪些决策被实际使用
// ─────────────────────────────────────────────────────────

server.tool(
  'report_context_usage',
  '反馈哪些决策上下文被实际使用了。在你完成任务后调用，帮助系统优化未来的检索结果排序。',
  {
    used_ids: z.array(z.string()).describe('实际参考了的决策 ID 列表（从 get_context_for_code 返回结果中获取）'),
    task_summary: z.string().optional().describe('本次任务简述，如 "修复订单创建的并发问题"'),
  },
  async ({ used_ids, task_summary }) => {
    const session = await getSession()
    try {
      const now = new Date().toISOString()
      let updated = 0

      // 1. 对使用过的决策 +1 use_count，更新 last_used_at
      for (const id of used_ids) {
        try {
          const r = await session.run(
            `MATCH (d:DecisionContext {id: $id})
             SET d.use_count = COALESCE(d.use_count, 0) + 1,
                 d.last_used_at = $now
             RETURN d.id`,
            { id, now }
          )
          if (r.records.length > 0) updated++
        } catch {}
      }

      // 2. 写反馈日志
      try {
        const { appendFeedback } = await import('../ingestion/feedback')
        appendFeedback({
          timestamp: now,
          used_ids,
          task_summary,
        })
      } catch {}

      return {
        content: [{
          type: 'text',
          text: `✅ 已记录反馈：${updated}/${used_ids.length} 条决策标记为已使用${task_summary ? `\n任务: ${task_summary}` : ''}`,
        }],
      }
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
