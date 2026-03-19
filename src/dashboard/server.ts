/**
 * Dashboard API Server
 *
 * 运行：npm run dashboard
 * 访问：http://localhost:3001
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { getSession, verifyConnectivity } from '../db/client'
import { loadConfig } from '../config'
import { spawn, ChildProcess } from 'child_process'
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
        finding_type: d.finding_type || 'decision',
        critique: d.critique || null,
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
           d.updated_at = $now,
           d.created_at = CASE WHEN d.created_at IS NULL THEN $now ELSE d.created_at END`,
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

// ── System Status & Setup ─────────────────────────

app.get('/api/system/status', async (c) => {
  const status: any = {
    memgraph: { connected: false, error: null as string | null },
    repos: [] as any[],
    totals: { codeEntities: 0, decisions: 0, callEdges: 0, anchoredEdges: 0 },
    config: { loaded: false, repos: [] as any[] },
  }

  // Check config
  try {
    const config = loadConfig()
    status.config = {
      loaded: true,
      repos: config.repos.map(r => ({
        name: r.name,
        type: r.type,
        cpgFile: r.cpgFile,
        cpgExists: fs.existsSync(path.resolve(__dirname, '../..', r.cpgFile)),
      })),
    }
  } catch (e: any) {
    status.config = { loaded: false, repos: [], error: e.message }
  }

  // Check Memgraph
  try {
    const session = await getSession()
    try {
      // Per-repo counts
      const repoResult = await session.run(
        `MATCH (svc:CodeEntity {entity_type: 'service'})
         RETURN svc.name AS repo`
      )
      for (const r of repoResult.records) {
        const repo = r.get('repo') as string
        const counts = await session.run(
          `MATCH (ce:CodeEntity {repo: $repo})
           RETURN ce.entity_type AS type, count(ce) AS cnt`,
          { repo }
        )
        const decResult = await session.run(
          `MATCH (d:DecisionContext)-[:ANCHORED_TO|APPROXIMATE_TO]->(ce:CodeEntity {repo: $repo})
           RETURN count(DISTINCT d) AS cnt`
          , { repo }
        )
        const callResult = await session.run(
          `MATCH (a:CodeEntity {repo: $repo})-[r:CALLS]->(b)
           RETURN count(r) AS cnt`,
          { repo }
        )
        const entityCounts: Record<string, number> = {}
        for (const cr of counts.records) {
          entityCounts[cr.get('type') as string] = num(cr.get('cnt'))
        }
        status.repos.push({
          name: repo,
          entities: entityCounts,
          totalEntities: Object.values(entityCounts).reduce((s, n) => s + n, 0),
          decisions: num(decResult.records[0]?.get('cnt')),
          calls: num(callResult.records[0]?.get('cnt')),
        })
      }

      // Totals
      const totalCE = await session.run(`MATCH (ce:CodeEntity) RETURN count(ce) AS cnt`)
      const totalDC = await session.run(`MATCH (d:DecisionContext) RETURN count(d) AS cnt`)
      const totalCalls = await session.run(`MATCH ()-[r:CALLS]->() RETURN count(r) AS cnt`)
      const totalAnchored = await session.run(`MATCH ()-[r:ANCHORED_TO]->() RETURN count(r) AS cnt`)
      status.totals = {
        codeEntities: num(totalCE.records[0]?.get('cnt')),
        decisions: num(totalDC.records[0]?.get('cnt')),
        callEdges: num(totalCalls.records[0]?.get('cnt')),
        anchoredEdges: num(totalAnchored.records[0]?.get('cnt')),
      }

      status.memgraph.connected = true
    } finally {
      await session.close()
    }
  } catch (e: any) {
    status.memgraph = { connected: false, error: e.message }
  }

  return c.json(status)
})

// Setup job runner (same pattern as cold-start)
interface SetupJob {
  process: ChildProcess | null
  status: 'idle' | 'running' | 'done' | 'error'
  command: string
  logs: string[]
  startedAt: number
}

const setupJob: SetupJob = {
  process: null,
  status: 'idle',
  command: '',
  logs: [],
  startedAt: 0,
}

app.post('/api/system/run', async (c) => {
  if (setupJob.status === 'running') {
    return c.json({ error: 'A setup command is already running' }, 409)
  }

  const body = await c.req.json()
  const { command } = body  // 'schema' | 'ingest-all' | 'link-all' | 'full-setup'

  const projectRoot = path.resolve(__dirname, '../..')
  const tsNode = path.resolve(projectRoot, 'node_modules/.bin/ts-node')

  // Build command sequence
  type Step = { label: string; cmd: string; args: string[] }
  const steps: Step[] = []

  if (command === 'schema' || command === 'full-setup') {
    steps.push({ label: 'Schema', cmd: tsNode, args: ['src/db/schema.ts'] })
  }
  if (command === 'ingest-all' || command === 'full-setup') {
    try {
      const config = loadConfig()
      for (const repo of config.repos) {
        const cpgPath = path.resolve(projectRoot, repo.cpgFile)
        if (fs.existsSync(cpgPath)) {
          steps.push({
            label: `Ingest CPG: ${repo.name}`,
            cmd: tsNode,
            args: ['--transpile-only', 'src/ingestion/ingest-cpg.ts', '--file', repo.cpgFile],
          })
        }
      }
    } catch {}
  }
  if (command === 'link-all' || command === 'full-setup') {
    steps.push({ label: 'Link repos', cmd: tsNode, args: ['--transpile-only', 'src/ingestion/link-repos.ts'] })
    steps.push({ label: 'Link services', cmd: tsNode, args: ['--transpile-only', 'src/ingestion/link-services.ts'] })
  }
  if (command === 'clear-decisions') {
    steps.push({
      label: 'Clear all decisions',
      cmd: tsNode,
      args: ['--transpile-only', '-e',
        `const {getSession,verifyConnectivity,closeDriver}=require('./src/db/client');(async()=>{await verifyConnectivity();const s=await getSession();const r=await s.run('MATCH (d:DecisionContext) DETACH DELETE d RETURN count(d) AS cnt');console.log('Deleted '+r.records[0].get('cnt')+' decisions');await s.close();await closeDriver()})()`,
      ],
    })
  }

  if (steps.length === 0) {
    return c.json({ error: `Unknown command: ${command}` }, 400)
  }

  // Reset state
  setupJob.status = 'running'
  setupJob.command = command
  setupJob.logs = []
  setupJob.startedAt = Date.now()

  // Run steps sequentially
  const runStep = (idx: number) => {
    if (idx >= steps.length) {
      setupJob.status = 'done'
      setupJob.logs.push('\n\u2705 All steps complete')
      setupJob.process = null
      return
    }

    const step = steps[idx]
    setupJob.logs.push(`\n\u2501\u2501 [${idx + 1}/${steps.length}] ${step.label} \u2501\u2501`)

    const child = spawn(step.cmd, step.args, {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    setupJob.process = child

    child.stdout?.on('data', (data: Buffer) => {
      data.toString().split('\n').forEach(line => {
        if (line.trim()) setupJob.logs.push(line)
      })
    })
    child.stderr?.on('data', (data: Buffer) => {
      data.toString().split('\n').forEach(line => {
        if (line.trim()) setupJob.logs.push(line)
      })
    })

    child.on('close', (code) => {
      if (code === 0) {
        setupJob.logs.push(`\u2713 ${step.label} done`)
        runStep(idx + 1)
      } else {
        setupJob.status = 'error'
        setupJob.logs.push(`\u274c ${step.label} failed (exit ${code})`)
        setupJob.process = null
      }
    })

    child.on('error', (err) => {
      setupJob.status = 'error'
      setupJob.logs.push(`\u274c ${step.label}: ${err.message}`)
      setupJob.process = null
    })
  }

  runStep(0)
  return c.json({ status: 'started', command, steps: steps.length })
})

app.get('/api/system/run/stream', (c) => {
  return streamSSE(c, async (stream) => {
    let lastIdx = 0
    let done = false
    while (!done) {
      while (lastIdx < setupJob.logs.length) {
        await stream.writeSSE({ data: setupJob.logs[lastIdx], event: 'log' })
        lastIdx++
      }
      if (setupJob.status !== 'running' && lastIdx >= setupJob.logs.length) {
        await stream.writeSSE({ data: setupJob.status, event: 'status' })
        done = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  })
})

app.get('/api/system/run/status', (c) => {
  return c.json({ status: setupJob.status, command: setupJob.command, logCount: setupJob.logs.length })
})

// ── Cold-start v2: Pipeline control ─────────────────────

interface PipelineJob {
  process: ChildProcess | null
  status: 'idle' | 'running' | 'done' | 'error'
  goal: string
  repo: string | null
  logs: string[]
  startedAt: number
}

const job: PipelineJob = {
  process: null,
  status: 'idle',
  goal: '',
  repo: null,
  logs: [],
  startedAt: 0,
}

app.get('/api/cold-start/config', (c) => {
  try {
    const config = loadConfig()
    return c.json({
      repos: config.repos.map(r => ({ name: r.name, type: r.type })),
    })
  } catch {
    return c.json({ repos: [] })
  }
})

app.get('/api/cold-start/status', (c) => {
  return c.json({
    status: job.status,
    goal: job.goal,
    repo: job.repo,
    logCount: job.logs.length,
    startedAt: job.startedAt,
  })
})

app.post('/api/cold-start/start', async (c) => {
  if (job.status === 'running') {
    return c.json({ error: 'Pipeline already running' }, 409)
  }

  const body = await c.req.json()
  const { goal, repo, owner, concurrency, dryRun } = body

  if (!goal) {
    return c.json({ error: 'goal is required' }, 400)
  }

  // Reset job state
  job.status = 'running'
  job.goal = goal
  job.repo = repo || null
  job.logs = []
  job.startedAt = Date.now()

  // Build args
  const args = [
    '--transpile-only',
    path.resolve(__dirname, '../ingestion/cold-start-v2.ts'),
    '--goal', goal,
  ]
  if (repo) args.push('--repo', repo)
  if (owner) args.push('--owner', owner)
  if (concurrency) args.push('--concurrency', String(concurrency))
  if (dryRun) args.push('--dry-run')
  if (body.force) args.push('--force')
  if (body.deepCheck) args.push('--deep-check')

  const tsNode = path.resolve(__dirname, '../../node_modules/.bin/ts-node')

  const child = spawn(tsNode, args, {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  job.process = child

  const addLog = (line: string) => {
    if (line.trim()) {
      job.logs.push(line)
    }
  }

  child.stdout?.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(addLog)
  })
  child.stderr?.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(addLog)
  })

  child.on('close', (code) => {
    job.status = code === 0 ? 'done' : 'error'
    addLog(code === 0 ? '\n✅ Pipeline finished' : `\n❌ Pipeline exited with code ${code}`)
    job.process = null
  })

  child.on('error', (err) => {
    job.status = 'error'
    addLog(`❌ Failed to start: ${err.message}`)
    job.process = null
  })

  return c.json({ status: 'started', goal, repo })
})

app.get('/api/cold-start/stream', (c) => {
  return streamSSE(c, async (stream) => {
    let lastIdx = 0
    let done = false

    while (!done) {
      // Send any new log lines
      while (lastIdx < job.logs.length) {
        await stream.writeSSE({ data: job.logs[lastIdx], event: 'log' })
        lastIdx++
      }

      // Check if pipeline is done
      if (job.status !== 'running' && lastIdx >= job.logs.length) {
        await stream.writeSSE({ data: job.status, event: 'status' })
        done = true
        break
      }

      // Poll interval
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  })
})

app.post('/api/cold-start/stop', (c) => {
  if (job.process) {
    job.process.kill('SIGTERM')
    job.status = 'idle'
    job.logs.push('⏹️ Pipeline stopped by user')
    job.process = null
  }
  return c.json({ status: 'stopped' })
})

app.get('/api/cold-start/logs', (c) => {
  return c.json({ logs: job.logs, status: job.status })
})

// ── Fallback: SPA ───────────────────────────────────────

app.get('/cold-start', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'cold-start.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

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
