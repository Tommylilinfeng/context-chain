/**
 * MCP Server — Context Knowledge Graph
 *
 * 唯一工具：get_context_for_code — 五槽位融合检索设计决策
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
  version: '0.2.0',
})

// ─────────────────────────────────────────────────────────
// get_context_for_code
// 五槽位融合检索 + 渐进披露（summary → detail → 单条展开）
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
  'Query design decisions related to a file. Pass a file name to get all decisions anchored to that file and its functions. Returns summary list by default; pass detail=true for full content; pass decision_id to expand a single decision with its relationship chain.',
  {
    name: z.string().describe('File name (e.g. budget.ts, claude-cli.ts)'),
    detail: z.boolean().optional().describe('true = full content, false (default) = summary list'),
    decision_id: z.string().optional().describe('A specific decision ID (dc:... prefix) to expand with full content + relationship chain'),
  },
  async ({ name, detail = false, decision_id }) => {
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
          return { content: [{ type: 'text', text: `Decision "${decision_id}" not found.` }] }
        }
        const d = r.records[0]
        const lines: string[] = [
          `Decision detail\n`,
          `> ${d.get('summary')}`,
          `  ${d.get('content')}`,
        ]
        const kw = d.get('keywords')
        if (kw?.length) lines.push(`  Keywords: ${kw.join(', ')}`)
        const ft = d.get('finding_type')
        if (ft && ft !== 'decision') lines.push(`  Type: ${ft}`)
        lines.push(`  Owner: ${d.get('owner') ?? '-'}  Created: ${d.get('created_at') ?? '-'}`)

        const anchors = d.get('anchors')?.filter((a: any) => a.name) ?? []
        if (anchors.length > 0) {
          lines.push(`\n-- Anchors --`)
          for (const a of anchors) lines.push(`  ${a.type === 'ANCHORED_TO' ? 'exact' : 'approx'}: ${a.name}  ${a.path ?? ''}`)
        }

        // 2-hop relationship chain
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
            lines.push(`\n-- Relationships (${relR.records.length}) --`)
            for (const rr of relR.records) {
              const dist = typeof rr.get('dist') === 'number' ? rr.get('dist') : rr.get('dist')?.toNumber?.() ?? 0
              lines.push(`  ${'  '.repeat(dist - 1)}[${rr.get('rel_type')}] ${rr.get('summary')} (id: ${rr.get('oid')})`)
              const reason = rr.get('reason')
              if (reason) lines.push(`  ${'  '.repeat(dist - 1)}  -> ${reason}`)
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

      // P0 + P1: file-level anchor query (covers both direct file anchors and
      // function-level decisions via the APPROXIMATE_TO edge added at write time)
      const anchorResult = await session.run(
        `MATCH (d:DecisionContext)-[r:ANCHORED_TO|APPROXIMATE_TO]->(ce:CodeEntity {name: $name})
         WHERE d.staleness = 'active'
         RETURN d.id AS id, d.summary AS summary, d.content AS content, d.keywords AS keywords,
                d.finding_type AS finding_type, type(r) AS match_type
         ORDER BY CASE type(r) WHEN 'ANCHORED_TO' THEN 0 ELSE 1 END, d.created_at DESC
         LIMIT 10`,
        { name }
      )
      for (const r of anchorResult.records) {
        const isExact = r.get('match_type') === 'ANCHORED_TO'
        addHit(r.get('id'), r.get('summary'), r.get('content'), r.get('keywords'), r.get('finding_type'),
          isExact ? 'anchor' : 'file', isExact ? 0 : 1)
      }

      // P2: keyword match
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
          addHit(r.get('id'), r.get('summary'), r.get('content'), r.get('keywords'), r.get('finding_type'), 'keyword', 2)
        }
      } catch {}

      // P3: relationship expansion (1-hop from P0-P2 hits)
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
              'related', 3, r.get('rel_type'))
          }
        } catch {}
      }

      // P4: vector search (if available)
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
                'vector', 4, `${(score * 100).toFixed(0)}%`)
            }
          }
        }
      } catch {
        // vector search unavailable, silently skip
      }

      // ── merge output ──
      hits.sort((a, b) => a.priority - b.priority)
      const top = hits.slice(0, 15)

      if (top.length === 0) {
        return { content: [{ type: 'text', text: `No design decisions found for "${name}".` }] }
      }

      const lines: string[] = []

      if (detail) {
        lines.push(`"${name}" — ${top.length} decisions (full)\n`)
        for (const h of top) {
          const tag = h.extra ? `${h.source}:${h.extra}` : h.source
          lines.push(`> [${tag}] ${h.summary}  (id: ${h.id})`)
          lines.push(`  ${h.content}`)
          if (h.keywords.length) lines.push(`  Keywords: ${h.keywords.join(', ')}`)
          if (h.finding_type !== 'decision') lines.push(`  Type: ${h.finding_type}`)
          lines.push('')
        }
      } else {
        lines.push(`"${name}" — ${top.length} decisions\n`)
        for (let i = 0; i < top.length; i++) {
          const h = top[i]
          const tag = h.extra ? `${h.source}:${h.extra}` : h.source
          const kwSnippet = h.keywords.length > 0 ? `  [${h.keywords.slice(0, 3).join(', ')}]` : ''
          lines.push(`  ${i + 1}. [${tag}] ${h.summary}${kwSnippet}`)
        }
        lines.push(`\nPass detail=true for full content, or decision_id to expand one.`)
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
  process.stderr.write('✅ CKG MCP Server started (1 tool: get_context_for_code)\n')
}

function shutdown() {
  closeDriver().finally(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.stdin.on('close', shutdown)

main().catch(err => {
  process.stderr.write(`MCP Server failed to start: ${err.message}\n`)
  closeDriver()
  process.exit(1)
})
