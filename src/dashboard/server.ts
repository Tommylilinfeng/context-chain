/**
 * Dashboard API Server
 *
 * 运行：npm run dashboard
 * 访问：http://localhost:3001
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getSession, verifyConnectivity } from '../db/client'
import fs from 'fs'
import path from 'path'

const app = new Hono()
app.use('*', cors())

// ── Helper: safe number extraction from neo4j Integer ───
function num(val: any): number {
  if (val === null || val === undefined) return 0
  if (typeof val === 'number') return val
  if (typeof val?.toNumber === 'function') return val.toNumber()
  return parseInt(String(val)) || 0
}

// ── API: 全局统计 ───────────────────────────────────────

app.get('/api/stats', async (c) => {
  const session = await getSession()
  try {
    const nodeResult = await session.run(
      `MATCH (n:CodeEntity) RETURN n.entity_type AS type, count(n) AS count ORDER BY count DESC`
    )
    const totalResult = await session.run(
      `MATCH (d:DecisionContext) RETURN count(d) AS total`
    )
    const bizResult = await session.run(
      `MATCH (d:DecisionContext) WHERE d.source = 'manual_business_context' RETURN count(d) AS biz`
    )
    const autoResult = await session.run(
      `MATCH (d:DecisionContext) WHERE d.confidence = 'auto_generated' RETURN count(d) AS auto`
    )
    const edgeResult = await session.run(
      `MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count ORDER BY count DESC`
    )
    const anchoredResult = await session.run(
      `MATCH (d:DecisionContext)-[:ANCHORED_TO]->(ce:CodeEntity) RETURN count(DISTINCT d) AS anchored`
    )

    return c.json({
      entities: nodeResult.records.map(r => ({ type: r.get('type'), count: num(r.get('count')) })),
      edges: edgeResult.records.map(r => ({ type: r.get('type'), count: num(r.get('count')) })),
      decisions: {
        total: num(totalResult.records[0]?.get('total')),
        business: num(bizResult.records[0]?.get('biz')),
        auto_generated: num(autoResult.records[0]?.get('auto')),
        anchored: num(anchoredResult.records[0]?.get('anchored')),
      },
    })
  } catch (err: any) {
    console.error('GET /api/stats error:', err.message)
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

// ── API: Repo 概览 ──────────────────────────────────────

app.get('/api/repos', async (c) => {
  const session = await getSession()
  try {
    // 简化查询，分步做
    const svcResult = await session.run(
      `MATCH (svc:CodeEntity {entity_type: 'service'})
       OPTIONAL MATCH (svc)-[:CONTAINS]->(child:CodeEntity)
       RETURN svc.name AS repo, count(child) AS entity_count
       ORDER BY repo`
    )

    const repos = []
    for (const r of svcResult.records) {
      const repoName = r.get('repo')
      const decResult = await session.run(
        `MATCH (d:DecisionContext)-[:ANCHORED_TO]->(ce:CodeEntity {repo: $repo})
         RETURN count(DISTINCT d) AS cnt`,
        { repo: repoName }
      )
      repos.push({
        repo: repoName,
        entities: num(r.get('entity_count')),
        decisions: num(decResult.records[0]?.get('cnt')),
      })
    }

    return c.json(repos)
  } catch (err: any) {
    console.error('GET /api/repos error:', err.message)
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

// ── API: 覆盖树 ─────────────────────────────────────────

app.get('/api/coverage/:repo', async (c) => {
  const repo = c.req.param('repo')
  const session = await getSession()
  try {
    const fileResult = await session.run(
      `MATCH (f:CodeEntity {repo: $repo, entity_type: 'file'})
       OPTIONAL MATCH (d:DecisionContext)-[:ANCHORED_TO]->(f)
       RETURN f.name AS name, f.path AS path, count(d) AS decisions
       ORDER BY decisions DESC, f.name`,
      { repo }
    )
    const sqlResult = await session.run(
      `MATCH (e:CodeEntity {repo: $repo})
       WHERE e.entity_type IN ['table', 'sql_function', 'trigger']
       OPTIONAL MATCH (d:DecisionContext)-[:ANCHORED_TO]->(e)
       RETURN e.name AS name, e.entity_type AS type, count(d) AS decisions
       ORDER BY decisions DESC, e.name`,
      { repo }
    )

    return c.json({
      files: fileResult.records.map(r => ({
        name: r.get('name'), path: r.get('path'), decisions: num(r.get('decisions')),
      })),
      sql: sqlResult.records.map(r => ({
        name: r.get('name'), type: r.get('type'), decisions: num(r.get('decisions')),
      })),
    })
  } catch (err: any) {
    console.error('GET /api/coverage error:', err.message)
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

// ── API: 决策搜索 ───────────────────────────────────────

app.get('/api/decisions', async (c) => {
  const repo = c.req.query('repo')
  const q = c.req.query('q')
  const limit = parseInt(c.req.query('limit') ?? '50')

  const session = await getSession()
  try {
    // 第一步：查决策节点（用字符串拼接 LIMIT，Memgraph 可能不支持参数化 LIMIT）
    let result
    if (repo && q) {
      result = await session.run(
        `MATCH (d:DecisionContext) WHERE ANY(s IN d.scope WHERE s = $repo) AND (d.summary CONTAINS $q OR d.content CONTAINS $q) RETURN d ORDER BY d.created_at DESC LIMIT ${limit}`,
        { repo, q }
      )
    } else if (repo) {
      result = await session.run(
        `MATCH (d:DecisionContext) WHERE ANY(s IN d.scope WHERE s = $repo) RETURN d ORDER BY d.created_at DESC LIMIT ${limit}`,
        { repo }
      )
    } else if (q) {
      result = await session.run(
        `MATCH (d:DecisionContext) WHERE d.summary CONTAINS $q OR d.content CONTAINS $q RETURN d ORDER BY d.created_at DESC LIMIT ${limit}`,
        { q }
      )
    } else {
      result = await session.run(
        `MATCH (d:DecisionContext) RETURN d ORDER BY d.created_at DESC LIMIT ${limit}`
      )
    }

    // 第二步：对每条决策查锚点
    const decisions = []
    for (const r of result.records) {
      const d = r.get('d').properties
      const anchorResult = await session.run(
        `MATCH (d:DecisionContext {id: $id})-[:ANCHORED_TO]->(ce:CodeEntity) RETURN ce.name AS name`,
        { id: d.id }
      )
      decisions.push({
        id: d.id,
        summary: d.summary,
        content: d.content,
        keywords: d.keywords,
        source: d.source,
        confidence: d.confidence,
        owner: d.owner,
        created_at: d.created_at,
        scope: d.scope,
        anchors: anchorResult.records.map(ar => ar.get('name')),
      })
    }

    return c.json(decisions)
  } catch (err: any) {
    console.error('GET /api/decisions error:', err.message)
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

// ── API: 业务上下文 CRUD ────────────────────────────────

app.get('/api/business-context', async (c) => {
  const session = await getSession()
  try {
    const result = await session.run(
      `MATCH (d:DecisionContext {source: 'manual_business_context'})
       RETURN d ORDER BY d.updated_at DESC`
    )

    const items = []
    for (const r of result.records) {
      const d = r.get('d').properties
      const anchorResult = await session.run(
        `MATCH (dc:DecisionContext {id: $id})-[:ANCHORED_TO]->(ce:CodeEntity) RETURN ce.name AS name`,
        { id: d.id }
      )
      items.push({
        id: d.id, summary: d.summary, content: d.content,
        keywords: d.keywords, scope: d.scope,
        created_at: d.created_at, updated_at: d.updated_at,
        anchors: anchorResult.records.map(ar => ar.get('name')),
      })
    }
    return c.json(items)
  } catch (err: any) {
    console.error('GET /api/business-context error:', err.message)
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

app.post('/api/business-context', async (c) => {
  const body = await c.req.json()
  const { id, summary, content, keywords, scope, anchors } = body

  if (!summary || !content) {
    return c.json({ error: 'summary and content are required' }, 400)
  }

  const session = await getSession()
  const now = new Date().toISOString()
  const nodeId = id && id !== '__new__' ? id : `dc:biz:${Date.now()}-${Math.random().toString(36).slice(2)}`

  try {
    await session.run(
      `MERGE (d:DecisionContext {id: $id})
       SET d.summary = $summary,
           d.content = $content,
           d.keywords = $keywords,
           d.scope = $scope,
           d.source = 'manual_business_context',
           d.confidence = 'owner_confirmed',
           d.staleness = 'active',
           d.owner = 'dashboard',
           d.updated_at = $now
       ON CREATE SET d.created_at = $now`,
      {
        id: nodeId, summary, content,
        keywords: keywords ?? [],
        scope: Array.isArray(scope) ? scope : [scope ?? 'global'],
        now,
      }
    )

    if (anchors && anchors.length > 0) {
      await session.run(
        `MATCH (d:DecisionContext {id: $id})-[r:ANCHORED_TO]->() DELETE r`,
        { id: nodeId }
      )
      for (const anchor of anchors) {
        await session.run(
          `MATCH (d:DecisionContext {id: $id})
           MATCH (ce:CodeEntity {name: $anchor})
           MERGE (d)-[:ANCHORED_TO]->(ce)`,
          { id: nodeId, anchor }
        )
      }
    }

    return c.json({ id: nodeId, status: 'saved' })
  } catch (err: any) {
    console.error('POST /api/business-context error:', err.message)
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

app.delete('/api/business-context/:id', async (c) => {
  const id = c.req.param('id')
  const session = await getSession()
  try {
    await session.run(`MATCH (d:DecisionContext {id: $id}) DETACH DELETE d`, { id })
    return c.json({ status: 'deleted' })
  } catch (err: any) {
    console.error('DELETE /api/business-context error:', err.message)
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

// ── API: 跨服务依赖图 ──────────────────────────────────

app.get('/api/graph', async (c) => {
  const session = await getSession()
  try {
    const nodesResult = await session.run(
      `MATCH (svc:CodeEntity {entity_type: 'service'})
       OPTIONAL MATCH (svc)-[:CONTAINS]->(child)
       RETURN svc.name AS name, svc.repo AS repo, count(child) AS size`
    )
    const crossRepoResult = await session.run(
      `MATCH (a:CodeEntity)-[r:CALLS_CROSS_REPO]->(b:CodeEntity)
       RETURN a.repo AS from_repo, b.repo AS to_repo, count(r) AS weight`
    )
    const apiResult = await session.run(
      `MATCH (a:CodeEntity)-[r:DEPENDS_ON_API]->(b:CodeEntity)
       RETURN a.name AS from_name, b.name AS to_name,
              collect(r.description) AS descriptions`
    )

    return c.json({
      nodes: nodesResult.records.map(r => ({
        id: r.get('name'), repo: r.get('repo'), size: num(r.get('size')),
      })),
      edges: [
        ...crossRepoResult.records.map(r => ({
          from: r.get('from_repo'), to: r.get('to_repo'),
          weight: num(r.get('weight')), type: 'code',
        })),
        ...apiResult.records.map(r => ({
          from: r.get('from_name'), to: r.get('to_name'),
          descriptions: r.get('descriptions'), type: 'api',
        })),
      ],
    })
  } catch (err: any) {
    console.error('GET /api/graph error:', err.message)
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

// ── Fallback: SPA ───────────────────────────────────────

app.get('*', async (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'index.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

// ── 启动 ────────────────────────────────────────────────

const PORT = parseInt(process.env.DASHBOARD_PORT ?? '3001')

async function main() {
  await verifyConnectivity()
  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`\n🖥️  CKG Dashboard: http://localhost:${PORT}\n`)
  })
}

main().catch(err => {
  console.error('Dashboard 启动失败:', err.message)
  process.exit(1)
})
