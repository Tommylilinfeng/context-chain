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
import { loadConfig, clearConfigCache, getAnalysisConfig } from '../config'
import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Session ingestion imports
import {
  listAllSessions, findSession, updateCacheEntry, saveCache,
} from '../ingestion/session-providers'
import {
  loadSessionState, saveSessionState, listSessionStates,
  createInitialState, setPhase0Done, setPhase1Done,
  setPhase2Started, addPhase2SegmentResult, setPhase2Done, setError,
  SessionPipelineState,
} from '../ingestion/session-state'
import {
  parseSession as parseSessionJSONL, formatTurnsForPrompt,
  extractRawTurnsForSegment, Phase0Result,
} from '../ingestion/session-parser'
import {
  buildSegmentationPrompt, buildExtractionPrompt,
  SessionSegment,
} from '../prompts/session'
import {
  buildGroupingPrompt, buildRelationshipPrompt, buildKeywordNormalizationPrompt,
  DecisionSummaryForGrouping, DecisionFullContent, BusinessContext,
} from '../prompts/grouping'
import { createAIProvider } from '../ai'
import {
  PendingDecision,
  parseJsonSafe, runWithConcurrency,
  getFilesFromGraph, getBusinessContext, buildCallerCalleeCodes,
  batchWriteDecisions,
} from '../ingestion/shared'
import { analyzeFunction } from '../core/analyze-function'
import {
  createPendingEdges, connectDecisions, getPendingStatus,
  BatchProgressEvent,
} from '../ingestion/connect-decisions'

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

// ── API: Overview (rich) ─────────────────────────────────

app.get('/api/overview', async (c) => {
  const session = await getSession()
  try {
    // 1. Total counts
    const totalNodes = await session.run(`MATCH (n) RETURN count(n) AS cnt`)
    const totalEdges = await session.run(`MATCH ()-[r]->() RETURN count(r) AS cnt`)
    const totalCE = await session.run(`MATCH (n:CodeEntity) RETURN count(n) AS cnt`)
    const totalDC = await session.run(`MATCH (n:DecisionContext) RETURN count(n) AS cnt`)

    // 2. Entity types breakdown
    const entityTypes = await session.run(
      `MATCH (n:CodeEntity) RETURN n.entity_type AS type, count(n) AS count ORDER BY count DESC`
    )

    // 3. Edge types breakdown
    const edgeTypes = await session.run(
      `MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count ORDER BY count DESC`
    )

    // 4. Per-repo detailed
    const repoResult = await session.run(
      `MATCH (svc:CodeEntity {entity_type: 'service'})
       RETURN svc.name AS repo`
    )
    const repoDetails = []
    for (const r of repoResult.records) {
      const repoName = r.get('repo') as string
      const counts = await session.run(
        `MATCH (ce:CodeEntity {repo: $repo})
         RETURN ce.entity_type AS type, count(ce) AS cnt`, { repo: repoName }
      )
      const decCount = await session.run(
        `MATCH (d:DecisionContext)-[:ANCHORED_TO]->(ce:CodeEntity {repo: $repo})
         RETURN count(DISTINCT d) AS cnt`, { repo: repoName }
      )
      const callCount = await session.run(
        `MATCH (a:CodeEntity {repo: $repo})-[r:CALLS]->(b)
         RETURN count(r) AS cnt`, { repo: repoName }
      )
      // Coverage: separate queries to avoid CASE WHEN issues in Memgraph
      const totalFilesResult = await session.run(
        `MATCH (f:CodeEntity {repo: $repo, entity_type: 'file'}) RETURN count(f) AS cnt`,
        { repo: repoName }
      )
      const coveredFilesResult = await session.run(
        `MATCH (d:DecisionContext)-[:ANCHORED_TO]->(f:CodeEntity {repo: $repo, entity_type: 'file'})
         RETURN count(DISTINCT f) AS cnt`,
        { repo: repoName }
      )
      const entities: Record<string, number> = {}
      for (const cr of counts.records) {
        entities[cr.get('type') as string] = num(cr.get('cnt'))
      }
      repoDetails.push({
        name: repoName,
        entities,
        totalEntities: Object.values(entities).reduce((s, n) => s + (n as number), 0),
        decisions: num(decCount.records[0]?.get('cnt')),
        calls: num(callCount.records[0]?.get('cnt')),
        totalFiles: num(totalFilesResult.records[0]?.get('cnt')),
        coveredFiles: num(coveredFilesResult.records[0]?.get('cnt')),
      })
    }

    // 5. Decision source distribution
    const srcResult = await session.run(
      `MATCH (d:DecisionContext) RETURN d.source AS source, count(d) AS count ORDER BY count DESC`
    )

    // 6. Decision finding_type distribution (avoid coalesce — Memgraph compat)
    const typeResult = await session.run(
      `MATCH (d:DecisionContext) RETURN d.finding_type AS ftype, count(d) AS count ORDER BY count DESC`
    )

    // 7. Top keywords
    const kwResult = await session.run(
      `MATCH (d:DecisionContext)
       WHERE d.keywords IS NOT NULL
       UNWIND d.keywords AS kw
       RETURN kw, count(*) AS count ORDER BY count DESC LIMIT 30`
    )

    // 8. Recent decisions
    const recentResult = await session.run(
      `MATCH (d:DecisionContext)
       RETURN d.id AS id, d.summary AS summary, d.source AS source,
              d.finding_type AS ftype, d.created_at AS created_at, d.scope AS scope
       ORDER BY d.created_at DESC LIMIT 8`
    )

    // 9. Anchoring stats
    const anchoredCount = await session.run(
      `MATCH (d:DecisionContext)-[:ANCHORED_TO]->() RETURN count(DISTINCT d) AS cnt`
    )
    const unanchoredCount = await session.run(
      `MATCH (d:DecisionContext) WHERE NOT (d)-[:ANCHORED_TO]->() RETURN count(d) AS cnt`
    )

    // 10. Health indicators
    const staleCount = await session.run(
      `MATCH (d:DecisionContext) WHERE d.staleness IN ['stale', 'code_changed', 'code_removed'] RETURN count(d) AS cnt`
    )
    const codeChangedCount = await session.run(
      `MATCH (d:DecisionContext) WHERE d.staleness = 'code_changed' RETURN count(d) AS cnt`
    )
    const codeRemovedCount = await session.run(
      `MATCH (d:DecisionContext) WHERE d.staleness = 'code_removed' RETURN count(d) AS cnt`
    )
    let embeddedCnt = 0, relEdgeCnt = 0, gapFnCnt = 0
    try {
      const r = await session.run(`MATCH (d:DecisionContext) WHERE d.has_embedding = true RETURN count(d) AS cnt`)
      embeddedCnt = num(r.records[0]?.get('cnt'))
    } catch {}
    try {
      const r = await session.run(`MATCH ()-[r]->() WHERE type(r) IN ['CAUSED_BY','DEPENDS_ON','CONFLICTS_WITH','CO_DECIDED'] RETURN count(r) AS cnt`)
      relEdgeCnt = num(r.records[0]?.get('cnt'))
    } catch {}
    try {
      const r = await session.run(`MATCH (f:CodeEntity {entity_type: 'function'}) WHERE f.triage_status = 'analyze' AND NOT (f)<-[:ANCHORED_TO]-(:DecisionContext) RETURN count(f) AS cnt`)
      gapFnCnt = num(r.records[0]?.get('cnt'))
    } catch {}

    // 10b. (storage/index/constraint moved to /api/memgraph)

    // 11. Graph sample for mini visualization
    const graphNodes = await session.run(
      `MATCH (svc:CodeEntity {entity_type: 'service'})
       OPTIONAL MATCH (d:DecisionContext)-[:ANCHORED_TO]->(ce:CodeEntity {repo: svc.name})
       RETURN svc.name AS name, count(DISTINCT d) AS decisions`
    )
    const graphEdges = await session.run(
      `MATCH (a:CodeEntity)-[r:CALLS_CROSS_REPO]->(b:CodeEntity)
       RETURN a.repo AS source, b.repo AS target, count(r) AS weight`
    )

    return c.json({
      totals: {
        nodes: num(totalNodes.records[0]?.get('cnt')),
        edges: num(totalEdges.records[0]?.get('cnt')),
        codeEntities: num(totalCE.records[0]?.get('cnt')),
        decisions: num(totalDC.records[0]?.get('cnt')),
        anchored: num(anchoredCount.records[0]?.get('cnt')),
        unanchored: num(unanchoredCount.records[0]?.get('cnt')),
      },
      health: {
        staleDecisions: num(staleCount.records[0]?.get('cnt')),
        codeChangedDecisions: num(codeChangedCount.records[0]?.get('cnt')),
        codeRemovedDecisions: num(codeRemovedCount.records[0]?.get('cnt')),
        embeddedDecisions: embeddedCnt,
        relationshipEdges: relEdgeCnt,
        gapFunctions: gapFnCnt,
        lastPipelineRun: null,
        lastScheduledRun: null,
      },
      entityTypes: entityTypes.records.map(r => ({ type: r.get('type'), count: num(r.get('count')) })),
      edgeTypes: edgeTypes.records.map(r => ({ type: r.get('type'), count: num(r.get('count')) })),
      repos: repoDetails,
      decisionSources: srcResult.records.map(r => ({ source: r.get('source'), count: num(r.get('count')) })),
      decisionTypes: typeResult.records.map(r => ({ type: r.get('ftype') || 'decision', count: num(r.get('count')) })),
      topKeywords: kwResult.records.map(r => ({ keyword: r.get('kw'), count: num(r.get('count')) })),
      recentDecisions: recentResult.records.map(r => ({
        id: r.get('id'), summary: r.get('summary'), source: r.get('source'),
        ftype: r.get('ftype') || 'decision', created_at: r.get('created_at'), scope: r.get('scope'),
      })),
      graph: {
        nodes: graphNodes.records.map(r => ({ id: r.get('name'), decisions: num(r.get('decisions')) })),
        edges: graphEdges.records.map(r => ({ source: r.get('source'), target: r.get('target'), weight: num(r.get('weight')) })),
      },
    })
  } catch (err: any) {
    console.error('GET /api/overview error:', err.message)
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

// ── API: Memgraph system info (dedicated) ───────────────

app.get('/api/memgraph', async (c) => {
  const session = await getSession()
  const info: Record<string, any> = {}

  // Try multiple Memgraph system commands
  const queries: [string, string][] = [
    ['SHOW STORAGE INFO', 'storage'],
    ['SHOW INDEX INFO', 'indexes'],
    ['SHOW CONSTRAINT INFO', 'constraints'],
    ['SHOW CONFIG', 'config'],
  ]

  for (const [query, label] of queries) {
    try {
      const r = await session.run(query)
      if (r.records.length > 0) {
        const keys = r.records[0].keys
        info[label] = r.records.map(rec => {
          const row: any = {}
          for (const k of keys) {
            const v = rec.get(k)
            row[String(k)] = v?.toNumber ? v.toNumber() : v
          }
          return row
        })
      } else {
        info[label] = []
      }
    } catch (e: any) {
      info[label] = { error: e.message }
    }
  }

  await session.close()
  return c.json(info)
})

// ── API: Execute Cypher query ─────────────────────────

app.post('/api/query', async (c) => {
  const body = await c.req.json()
  const query = body.query
  if (!query || typeof query !== 'string') {
    return c.json({ error: 'query is required' }, 400)
  }

  const session = await getSession()
  const startTime = Date.now()
  try {
    const result = await session.run(query)
    const elapsed = Date.now() - startTime

    // Extract columns and rows
    const columns = result.records.length > 0 ? result.records[0].keys : []
    const rows = result.records.map(rec => {
      const row: Record<string, any> = {}
      for (const key of rec.keys) {
        const val = rec.get(key)
        if (val === null || val === undefined) {
          row[key] = null
        } else if (typeof val === 'object' && val.properties) {
          // Node or relationship
          row[key] = { _type: val.labels ? 'node' : 'rel', labels: val.labels, ...val.properties }
        } else if (typeof val?.toNumber === 'function') {
          row[key] = val.toNumber()
        } else {
          row[key] = val
        }
      }
      return row
    })

    // Summary info
    const summary = result.summary
    const counters = summary?.counters?.updates ? summary.counters.updates() : null

    return c.json({
      columns,
      rows,
      rowCount: rows.length,
      elapsed,
      counters,
    })
  } catch (err: any) {
    const elapsed = Date.now() - startTime
    return c.json({ error: err.message, elapsed }, 400)
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

// ── API: Browse filesystem ──────────────────────────────

app.get('/api/browse', async (c) => {
  const dirPath = c.req.query('path') || os.homedir()
  try {
    const absPath = path.resolve(dirPath)
    if (!fs.existsSync(absPath)) {
      return c.json({ error: 'Path does not exist' }, 404)
    }
    const stat = fs.statSync(absPath)
    if (!stat.isDirectory()) {
      return c.json({ error: 'Not a directory' }, 400)
    }
    const entries = fs.readdirSync(absPath, { withFileTypes: true })
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => {
        const fullPath = path.join(absPath, e.name)
        const markers = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', '.git']
        const isRepo = markers.some(m => fs.existsSync(path.join(fullPath, m)))
        return { name: e.name, path: fullPath, isRepo }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    const parent = path.dirname(absPath)
    return c.json({ current: absPath, parent: parent !== absPath ? parent : null, dirs })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── API: Add / Delete repo ──────────────────────────────

app.post('/api/repos', async (c) => {
  try {
    const body = await c.req.json()
    const { name, repoPath, type, cpgFile, packages, skipEdgeFunctions, language, srcDir } = body
    if (!name || !repoPath || !type) {
    return c.json({ error: 'name, repoPath, and type are required' }, 400)
    }

    const configPath = path.resolve(__dirname, '../../ckg.config.json')
    let raw: any
    if (fs.existsSync(configPath)) {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    } else {
      raw = { repos: [] }
    }
    if (!raw.repos) raw.repos = []

    // Check for duplicate name
    if (raw.repos.some((r: any) => r.name === name)) {
    return c.json({ error: `Repo "${name}" already exists` }, 409)
    }

    const newRepo: any = {
    name,
    path: repoPath,
    type,
    cpgFile: cpgFile || `data/${name}.json`,
    packages: packages || [],
      language: language || 'javascript',
      srcDir: srcDir || 'src',
  }
  if (skipEdgeFunctions) newRepo.skipEdgeFunctions = true

    raw.repos.push(newRepo)
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2))

    clearConfigCache()

    return c.json({ status: 'added', repo: newRepo })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.delete('/api/repos/:name', async (c) => {
  try {
    const name = c.req.param('name')
    const configPath = path.resolve(__dirname, '../../ckg.config.json')
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    if (!raw.repos) raw.repos = []

    const idx = raw.repos.findIndex((r: any) => r.name === name)
    if (idx === -1) {
      return c.json({ error: `Repo "${name}" not found` }, 404)
    }

    raw.repos.splice(idx, 1)
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2))
    clearConfigCache()

    return c.json({ status: 'deleted', name })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
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

// ── API: Coverage tree (file → function level) ────────────

app.get('/api/coverage-tree/:repo', async (c) => {
  const repo = c.req.param('repo')
  const session = await getSession()
  try {
    // Get all files with their functions and decision counts
    const result = await session.run(
      `MATCH (f:CodeEntity {repo: $repo, entity_type: 'file'})
       OPTIONAL MATCH (f)-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function'})
       OPTIONAL MATCH (d:DecisionContext)-[:ANCHORED_TO]->(f)
       OPTIONAL MATCH (d2:DecisionContext)-[:ANCHORED_TO]->(fn)
       RETURN f.path AS filePath, f.name AS fileName,
              collect(DISTINCT {name: fn.name, id: fn.id, decisions: 0}) AS functions,
              count(DISTINCT d) AS fileDecisions
       ORDER BY filePath`,
      { repo }
    )

    // For each function, get decision count separately (Memgraph compat)
    const files: any[] = []
    for (const rec of result.records) {
      const filePath = rec.get('filePath') || rec.get('fileName')
      const fns = rec.get('functions').filter((f: any) => f.name)

      // Get per-function decision counts + triage status
      const fnDetails: any[] = []
      for (const fn of fns) {
        if (!fn.id) continue
        const fnDec = await session.run(
          `MATCH (fn:CodeEntity {id: $fnId})
           OPTIONAL MATCH (d:DecisionContext)-[:ANCHORED_TO]->(fn)
           RETURN count(d) AS cnt, fn.triage_status AS triageStatus, fn.analyzed_at AS analyzedAt`,
          { fnId: fn.id }
        )
        const rec = fnDec.records[0]
        fnDetails.push({
          name: fn.name,
          decisions: num(rec?.get('cnt')),
          triageStatus: rec?.get('triageStatus') || null,
          analyzedAt: rec?.get('analyzedAt') || null,
        })
      }

      files.push({
        path: filePath,
        name: rec.get('fileName'),
        decisions: num(rec.get('fileDecisions')),
        functions: fnDetails.sort((a: any, b: any) => b.decisions - a.decisions),
      })
    }

    // Also get SQL entities
    const sqlResult = await session.run(
      `MATCH (e:CodeEntity {repo: $repo})
       WHERE e.entity_type IN ['table', 'sql_function', 'trigger']
       OPTIONAL MATCH (d:DecisionContext)-[:ANCHORED_TO]->(e)
       RETURN e.name AS name, e.entity_type AS type, count(d) AS decisions
       ORDER BY decisions DESC`,
      { repo }
    )

    return c.json({
      files: files.sort((a: any, b: any) => b.decisions - a.decisions),
      sql: sqlResult.records.map(r => ({
        name: r.get('name'), type: r.get('type'), decisions: num(r.get('decisions')),
      })),
    })
  } catch (err: any) {
    console.error('GET /api/coverage-tree error:', err.message)
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

// ── API: Single function analysis (from Coverage page) ──

app.post('/api/coverage/analyze-function', async (c) => {
  const { repo, functionName, filePath, advancedMode, contextModules } = await c.req.json<{
    repo: string; functionName: string; filePath: string
    advancedMode?: boolean
    contextModules?: Record<string, boolean>
  }>()
  if (!repo || !functionName || !filePath) {
    return c.json({ error: 'repo, functionName, filePath required' }, 400)
  }

  const config = loadConfig()
  const repoConfig = config.repos.find((r: any) => r.name === repo)
  if (!repoConfig) return c.json({ error: `Repo "${repo}" not found` }, 400)

  const dbSession = await getSession()
  try {
    // Delete old decisions for this function
    await deleteOldDecisionsForFunction(dbSession, functionName, filePath, repo)

    // Look up line range from graph
    const fnInfo = await dbSession.run(
      `MATCH (f:CodeEntity {entity_type: 'file', path: $filePath, repo: $repo})-[:CONTAINS]->(fn:CodeEntity {entity_type: 'function', name: $fnName})
       RETURN fn.line_start AS ls, fn.line_end AS le`,
      { filePath, repo, fnName: functionName }
    )
    const lineStart = fnInfo.records[0]?.get('ls')?.toNumber?.() ?? undefined
    const lineEnd = fnInfo.records[0]?.get('le')?.toNumber?.() ?? undefined

    const configOverrides: Record<string, any> = {}
    if (advancedMode && contextModules) {
      configOverrides.advanced_modules = contextModules
    }

    const templateName = advancedMode ? '_advanced' : '_default'

    const result = await analyzeFunction({
      functionName, filePath, repo,
      repoPath: repoConfig.path,
      lineStart, lineEnd,
      owner: 'coverage',
      session: dbSession,
    }, configOverrides, templateName)

    const decCount = result.decisions.length
    if (decCount > 0) {
      await batchWriteDecisions(dbSession, result.decisions)
      const newIds = result.decisions.map(d => d.id)
      await createPendingEdges(dbSession, newIds, { verbose: false })
    }

    // Update run state so bulk Run skips this function next time
    const state = loadRunState(repo)
    const key = `${filePath}::${functionName}`
    if (!state.analyzed.includes(key)) {
      state.analyzed.push(key)
      saveRunState(state)
    }



    return c.json({
      status: 'done',
      decisions: decCount,
      duration: result.metadata.duration_ms,
      ...(result.metadata.advanced ? { advanced: result.metadata.advanced } : {}),
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  } finally {
    await dbSession.close()
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
        summary_zh: d.summary_zh || null,
        content_zh: d.content_zh || null,
        localized_at: d.localized_at || null,
        keywords: d.keywords,
        source: d.source,
        confidence: d.confidence,
        finding_type: d.finding_type || 'decision',
        critique: d.critique || null,
        staleness: d.staleness || 'active',
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

// ── API: Decision Export ─────────────────────────────────

app.get('/api/decisions/export', async (c) => {
  const types = c.req.query('types') // comma-separated: decision,bug,suboptimal
  const repo = c.req.query('repo')
  const format = c.req.query('format') ?? 'json'

  const session = await getSession()
  try {
    const typeFilter = types
      ? `WHERE d.finding_type IN [${types.split(',').map(t => `'${t.trim()}'`).join(',')}]`
      : ''
    const repoFilter = repo
      ? (typeFilter ? ` AND ANY(s IN d.scope WHERE s = '${repo}')` : ` WHERE ANY(s IN d.scope WHERE s = '${repo}')`)
      : ''

    const result = await session.run(
      `MATCH (d:DecisionContext) ${typeFilter}${repoFilter}
       OPTIONAL MATCH (d)-[:ANCHORED_TO]->(ce:CodeEntity)
       RETURN d, collect(DISTINCT {name: ce.name, path: ce.path, type: ce.entity_type}) AS anchors
       ORDER BY d.created_at DESC`
    )

    const decisions = result.records.map(r => {
      const d = r.get('d').properties
      const anchors = r.get('anchors').filter((a: any) => a.name)
      return {
        id: d.id,
        summary: d.summary,
        content: d.content,
        finding_type: d.finding_type || 'decision',
        keywords: d.keywords || [],
        source: d.source,
        staleness: d.staleness || 'active',
        owner: d.owner,
        scope: d.scope || [],
        created_at: d.created_at,
        anchors: anchors.map((a: any) => ({ name: a.name, path: a.path, type: a.type })),
        ...(d.critique ? { critique: d.critique } : {}),
        ...(d.summary_zh ? { summary_zh: d.summary_zh } : {}),
        ...(d.content_zh ? { content_zh: d.content_zh } : {}),
      }
    })

    if (format === 'csv') {
      const header = 'id,finding_type,summary,content,keywords,anchors,source,staleness,created_at'
      const escape = (s: string) => `"${String(s || '').replace(/"/g, '""')}"`
      const rows = decisions.map(d =>
        [d.id, d.finding_type, escape(d.summary), escape(d.content),
         escape((d.keywords || []).join('; ')), escape(d.anchors.map((a: any) => a.name).join('; ')),
         d.source, d.staleness, d.created_at].join(',')
      )
      const csv = [header, ...rows].join('\n')
      return new Response(csv, {
        headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="decisions.csv"' },
      })
    }

    return new Response(JSON.stringify(decisions, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="decisions.json"' },
    })
  } catch (err: any) {
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

// ── API: Cross-repo edge details ─────────────────────

app.get('/api/graph/edges', async (c) => {
  const source = c.req.query('source')
  const target = c.req.query('target')
  const session = await getSession()
  try {
    // If source & target specified, return detailed edges between them
    if (source && target) {
      const crossRepo = await session.run(
        `MATCH (a:CodeEntity {repo: $source})-[r:CALLS_CROSS_REPO]->(b:CodeEntity {repo: $target})
         RETURN a.name AS sourceFn, a.path AS sourcePath, a.entity_type AS sourceType,
                b.name AS targetFn, b.path AS targetPath, b.entity_type AS targetType
         ORDER BY a.path, a.name`,
        { source, target }
      )
      const apiDeps = await session.run(
        `MATCH (a:CodeEntity {repo: $source})-[r:DEPENDS_ON_API]->(b:CodeEntity {repo: $target})
         RETURN a.name AS sourceFn, a.path AS sourcePath,
                b.name AS targetFn, b.path AS targetPath,
                r.description AS description,
                r.from_file AS fromFile,
                r.to_endpoint AS toEndpoint,
                r.connection_type AS connectionType
         ORDER BY r.from_file, r.to_endpoint`,
        { source, target }
      )
      return c.json({
        source, target,
        crossRepoCalls: crossRepo.records.map(r => {
          const srcName = r.get('sourceFn')
          const srcPath = r.get('sourcePath')
          return {
            // If source is :program (Joern top-level), use file path as display name
            sourceFn: srcName === ':program' ? (srcPath || ':program') : srcName,
            sourcePath: srcPath,
            sourceType: r.get('sourceType'),
            targetFn: r.get('targetFn'),
            targetPath: r.get('targetPath'),
            targetType: r.get('targetType'),
            isTopLevel: srcName === ':program',
          }
        }),
        apiDeps: apiDeps.records.map(r => ({
          sourceFn: r.get('sourceFn'),
          sourcePath: r.get('sourcePath'),
          targetFn: r.get('targetFn'),
          targetPath: r.get('targetPath'),
          description: r.get('description'),
          fromFile: r.get('fromFile'),
          toEndpoint: r.get('toEndpoint'),
          connectionType: r.get('connectionType'),
        })),
      })
    }

    // Otherwise return all repo pairs with counts
    const pairs = await session.run(
      `MATCH (a:CodeEntity)-[r:CALLS_CROSS_REPO]->(b:CodeEntity)
       WHERE a.repo <> b.repo
       RETURN a.repo AS source, b.repo AS target, count(r) AS count
       ORDER BY count DESC`
    )
    const apiPairs = await session.run(
      `MATCH (a:CodeEntity)-[r:DEPENDS_ON_API]->(b:CodeEntity)
       RETURN a.repo AS source, b.repo AS target, count(r) AS count
       ORDER BY count DESC`
    )
    return c.json({
      crossRepoPairs: pairs.records.map(r => ({
        source: r.get('source'), target: r.get('target'), count: num(r.get('count')),
      })),
      apiPairs: apiPairs.records.map(r => ({
        source: r.get('source'), target: r.get('target'), count: num(r.get('count')),
      })),
    })
  } catch (err: any) {
    console.error('GET /api/graph/edges error:', err.message)
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
        language: r.language || 'javascript',
        srcDir: r.srcDir || 'src',
        repoPath: r.path,
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

// Setup job runner (same pattern as scan pipeline)
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

// ── CPG Generation (Joern) ──────────────────────────────

interface CpgJob {
  process: ChildProcess | null
  status: 'idle' | 'running' | 'done' | 'error'
  repo: string
  logs: string[]
  startedAt: number
}

const cpgJob: CpgJob = {
  process: null,
  status: 'idle',
  repo: '',
  logs: [],
  startedAt: 0,
}

app.post('/api/system/generate-cpg', async (c) => {
  if (cpgJob.status === 'running') {
    return c.json({ error: 'CPG generation already running' }, 409)
  }

  const body = await c.req.json()
  const { repo, memoryPct } = body
  if (!repo) return c.json({ error: 'repo is required' }, 400)

  const config = loadConfig()
  const repoConfig = config.repos.find(r => r.name === repo)
  if (!repoConfig) return c.json({ error: `Repo "${repo}" not found in config` }, 404)

  const projectRoot = path.resolve(__dirname, '../..')
  const language = repoConfig.language || 'javascript'
  const srcDir = repoConfig.srcDir || 'src'
  const srcPath = path.resolve(repoConfig.path, srcDir)
  const cpgBinPath = path.resolve(projectRoot, 'data', `${repo}.cpg.bin`)
  const cpgJsonPath = path.resolve(projectRoot, repoConfig.cpgFile)
  const joernScript = path.resolve(projectRoot, 'joern/extract-code-entities.sc')

  // Verify source directory exists
  if (!fs.existsSync(srcPath)) {
    return c.json({ error: `Source directory not found: ${srcPath}` }, 400)
  }

  // Reset state
  cpgJob.status = 'running'
  cpgJob.repo = repo
  cpgJob.logs = []
  cpgJob.startedAt = Date.now()

  const addLog = (line: string) => {
    if (line.trim()) cpgJob.logs.push(line)
  }

  // Count source files for post-parse validation
  const countSourceFiles = (dir: string, exts: string[]): number => {
    let count = 0
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { count += countSourceFiles(full, exts) }
        else if (exts.some(ext => entry.name.endsWith(ext))) { count++ }
      }
    } catch {}
    return count
  }

  const langExts: Record<string, string[]> = {
    javascript: ['.js', '.ts', '.jsx', '.tsx'],
    java: ['.java'],
    python: ['.py'],
    c: ['.c', '.h', '.cpp', '.hpp'],
  }
  const expectedExts = langExts[language] || ['.js', '.ts']
  const expectedFileCount = countSourceFiles(srcPath, expectedExts)
  // Auto-detect system memory, use user-configured % for Joern's Node.js AST parser
  const totalMemMB = Math.floor(os.totalmem() / 1024 / 1024)
  const pct = Math.min(95, Math.max(50, memoryPct || 90)) / 100
  const joernMemMB = Math.max(2048, Math.floor(totalMemMB * pct))
  addLog(`Source directory: ${srcPath} (${expectedFileCount} ${language} files)`)
  addLog(`System memory: ${totalMemMB}MB — allocating ${joernMemMB}MB for Joern AST parser`)

  // Step 1: joern-parse → .cpg.bin
  // Step 2: joern --script → .json
  const steps = [
    {
      label: `joern-parse (${language})`,
      cmd: 'joern-parse',
      args: [srcPath, '--output', cpgBinPath, '--language', language],
    },
    {
      label: 'Extract code entities',
      cmd: 'joern',
      args: [
        '--script', joernScript,
        '--param', `cpgFile=${cpgBinPath}`,
        '--param', `outFile=${cpgJsonPath}`,
        '--param', `repoName=${repo}`,
      ],
    },
  ]

  let oomDetected = false

  const runStep = (idx: number) => {
    if (idx >= steps.length) {
      // Post-generation validation: check CPG completeness
      try {
        const cpg = JSON.parse(fs.readFileSync(cpgJsonPath, 'utf-8'))
        const cpgFileCount = cpg.nodes.filter((n: any) => n.entity_type === 'file').length
        const cpgFnCount = cpg.nodes.filter((n: any) => n.entity_type === 'function').length
        addLog(`\n📊 CPG: ${cpgFileCount} files, ${cpgFnCount} functions`)

        if (expectedFileCount > 0 && cpgFileCount < expectedFileCount * 0.5) {
          cpgJob.status = 'error'
          addLog(`⚠️  Only ${cpgFileCount}/${expectedFileCount} source files were parsed!`)
          addLog(`This usually means Joern ran out of memory during AST generation.`)
          addLog(`Try increasing NODE_OPTIONS max-old-space-size or splitting into smaller srcDir.`)
          cpgJob.process = null
          return
        }
      } catch (err: any) {
        cpgJob.status = 'error'
        addLog(`❌ Failed to validate CPG output: ${err?.message ?? 'unknown error'}`)
        cpgJob.process = null
        return
      }

      cpgJob.status = 'done'
      addLog('\n✅ CPG generation complete')
      addLog(`Output: ${cpgJsonPath}`)
      cpgJob.process = null
      return
    }

    const step = steps[idx]
    addLog(`\n━━ [${idx + 1}/${steps.length}] ${step.label} ━━`)

    const child = spawn(step.cmd, step.args, {
      cwd: projectRoot,
      env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${joernMemMB}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    cpgJob.process = child

    child.stdout?.on('data', (data: Buffer) => {
      data.toString().split('\n').forEach(line => { if (line.trim()) addLog(line) })
    })
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      text.split('\n').forEach(line => { if (line.trim()) addLog(line) })
      // Detect OOM in stderr even if exit code is 0
      if (text.includes('heap out of memory') || text.includes('Allocation failed')) {
        oomDetected = true
        addLog('⚠️  Memory issue detected! Joern AST generator ran out of memory.')
        addLog('Some files may not be parsed. Consider increasing memory or splitting the source.')
      }
    })

    child.on('close', (code) => {
      if (code === 0 && !oomDetected) {
        addLog(`✓ ${step.label} done`)
        runStep(idx + 1)
      } else if (oomDetected) {
        // OOM but exit 0 — warn but continue, validation will catch incomplete CPG
        addLog(`⚠️  ${step.label} completed with memory warnings — continuing to check results`)
        runStep(idx + 1)
      } else {
        cpgJob.status = 'error'
        addLog(`❌ ${step.label} failed (exit ${code})`)
        cpgJob.process = null
      }
    })

    child.on('error', (err) => {
      cpgJob.status = 'error'
      addLog(`❌ ${step.label}: ${err.message}`)
      if (err.message.includes('ENOENT')) {
        addLog('Joern not found. Install: https://docs.joern.io/installation')
      }
      cpgJob.process = null
    })
  }

  runStep(0)
  return c.json({ status: 'started', repo, language, srcDir })
})

app.get('/api/system/cpg/stream', (c) => {
  return streamSSE(c, async (stream) => {
    let lastIdx = 0
    let done = false
    while (!done) {
      while (lastIdx < cpgJob.logs.length) {
        await stream.writeSSE({ data: cpgJob.logs[lastIdx], event: 'log' })
        lastIdx++
      }
      if (cpgJob.status !== 'running' && lastIdx >= cpgJob.logs.length) {
        await stream.writeSSE({ data: cpgJob.status, event: 'status' })
        done = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  })
})

app.get('/api/system/cpg/status', (c) => {
  return c.json({ status: cpgJob.status, repo: cpgJob.repo, logCount: cpgJob.logs.length })
})

// ── AI Configuration API ────────────────────────────────

import { AIConfig } from '../ai/types'

app.get('/api/pipeline/ai-config', (c) => {
  try {
    const config = loadConfig()
    return c.json(config.ai ?? { provider: 'claude-cli' })
  } catch {
    return c.json({ provider: 'claude-cli' })
  }
})

app.put('/api/pipeline/ai-config', async (c) => {
  const body = await c.req.json() as AIConfig
  try {
    const configPath = path.resolve(__dirname, '../../ckg.config.json')
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    raw.ai = {
      provider: body.provider ?? 'claude-cli',
      ...(body.model ? { model: body.model } : {}),
      ...(body.apiKey ? { apiKey: body.apiKey } : {}),
      ...(body.maxTokens ? { maxTokens: body.maxTokens } : {}),
    }
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2))
    return c.json({ status: 'saved', ai: raw.ai })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})


// ══════════════════════════════════════════════════════════
// ── Run Analysis: in-process function-by-function analysis
// ══════════════════════════════════════════════════════════

interface RunFunctionStatus {
  name: string
  file: string
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error'
  decisions: number
}

interface RunJob {
  status: 'idle' | 'running' | 'done' | 'error'
  repo: string | null
  logs: LogBuffer
  functions: RunFunctionStatus[]
  analyzed: number
  decisions: number
  total: number
  skipped: number
  startedAt: number
  abortRequested: boolean
}

const MAX_LOG_ENTRIES = 2000

/**
 * SSE-safe log buffer with monotonic sequence IDs.
 * Readers track `lastSeq` instead of array index, so truncation never causes skips.
 */
class LogBuffer {
  private entries: { seq: number; data: string }[] = []
  private nextSeq = 0

  push(data: string): void {
    this.entries.push({ seq: this.nextSeq++, data })
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES)
    }
  }

  /** Read entries after the given sequence number. Returns [entries, newLastSeq]. */
  readAfter(lastSeq: number): [string[], number] {
    const result: string[] = []
    let newLast = lastSeq
    for (const e of this.entries) {
      if (e.seq > lastSeq) {
        result.push(e.data)
        newLast = e.seq
      }
    }
    return [result, newLast]
  }

  get length(): number { return this.entries.length }

  clear(): void {
    this.entries = []
    // don't reset nextSeq — ensures old readers can't confuse new logs with old
  }
}

/** Legacy helper — pushLog still works but now delegates to LogBuffer */
function pushLog(buf: LogBuffer, entry: string): void {
  buf.push(entry)
}

const runJob: RunJob = {
  status: 'idle', repo: null, logs: new LogBuffer(), functions: [],
  analyzed: 0, decisions: 0, total: 0, skipped: 0,
  startedAt: 0, abortRequested: false,
}

// State persistence for resume
const RUN_STATE_DIR = path.resolve(__dirname, '../../data')
const RUN_STATE_FILE = path.join(RUN_STATE_DIR, 'analyze-state.json')

interface ScanState {
  repo: string
  template: string
  analyzed: string[]
  lastUpdated: string
}

function loadRunState(repo: string): ScanState {
  try {
    if (fs.existsSync(RUN_STATE_FILE)) {
      const state: ScanState = JSON.parse(fs.readFileSync(RUN_STATE_FILE, 'utf-8'))
      if (state.repo === repo) return state
    }
  } catch {}
  return { repo, template: '_default', analyzed: [], lastUpdated: new Date().toISOString() }
}

/** Serialized state writer — prevents concurrent workers from corrupting the file */
let _stateSaveQueued = false
let _stateSavePending: ScanState | null = null

function saveRunState(state: ScanState): void {
  _stateSavePending = state
  if (_stateSaveQueued) return  // a write is already scheduled
  _stateSaveQueued = true
  // Use setImmediate to coalesce rapid concurrent calls into one write
  setImmediate(() => {
    _stateSaveQueued = false
    const toWrite = _stateSavePending
    if (!toWrite) return
    _stateSavePending = null
    try {
      if (!fs.existsSync(RUN_STATE_DIR)) fs.mkdirSync(RUN_STATE_DIR, { recursive: true })
      toWrite.lastUpdated = new Date().toISOString()
      // Atomic write: write to temp file then rename
      const tmpFile = RUN_STATE_FILE + '.tmp'
      fs.writeFileSync(tmpFile, JSON.stringify(toWrite, null, 2))
      fs.renameSync(tmpFile, RUN_STATE_FILE)
    } catch (err: any) {
      console.error('saveRunState error:', err.message)
    }
  })
}

/** Delete old decisions for a function (dedup before re-analysis) */
async function deleteOldDecisionsForFunction(
  session: any, functionName: string, filePath: string, repo: string
): Promise<number> {
  try {
    const result = await session.run(
      `MATCH (d:DecisionContext)-[:ANCHORED_TO]->(fn:CodeEntity {entity_type: 'function', name: $fnName})
       MATCH (f:CodeEntity {entity_type: 'file', path: $filePath, repo: $repo})-[:CONTAINS]->(fn)
       WHERE d.source IN ['analyze_function']
       DETACH DELETE d
       RETURN count(d) AS cnt`,
      { fnName: functionName, filePath, repo }
    )
    const cnt = result.records[0]?.get('cnt')
    return typeof cnt === 'number' ? cnt : cnt?.toNumber?.() ?? 0
  } catch { return 0 }
}

/** Core async analysis loop — runs in server process */
async function runAnalysis(repo: string, concurrency: number, advancedConfig?: { advancedMode?: boolean; contextModules?: Record<string, boolean>; maxRounds?: number }): Promise<void> {
  // Use a dedicated session only for initial queries; workers get their own sessions
  const initSession = await getSession()
  try {
    const config = loadConfig()
    const repoConfig = config.repos.find((r: any) => r.name === repo)
    if (!repoConfig) throw new Error(`Repo "${repo}" not found in config`)

    // Load all functions from graph
    const files = await getFilesFromGraph(initSession, repo)
    const allFunctions: { name: string; filePath: string; lineStart: number; lineEnd: number }[] = []
    for (const file of files) {
      for (const fn of file.functions) {
        allFunctions.push({ name: fn.name, filePath: file.filePath, lineStart: fn.lineStart, lineEnd: fn.lineEnd })
      }
    }

    // Load resume state
    const state = loadRunState(repo)
    const analyzedSet = new Set(state.analyzed)

    // Build function list with status
    runJob.functions = allFunctions.map(fn => ({
      name: fn.name,
      file: fn.filePath,
      status: analyzedSet.has(`${fn.filePath}::${fn.name}`) ? 'skipped' as const : 'pending' as const,
      decisions: 0,
    }))
    runJob.total = allFunctions.length
    runJob.skipped = analyzedSet.size
    runJob.analyzed = 0
    runJob.decisions = 0

    const remaining = allFunctions.filter(fn => !analyzedSet.has(`${fn.filePath}::${fn.name}`))

    pushLog(runJob.logs, `Starting analysis: ${remaining.length} functions (${analyzedSet.size} skipped)`)
    pushLog(runJob.logs, JSON.stringify({ type: 'progress', analyzed: 0, decisions: 0, total: runJob.total, skipped: runJob.skipped }))

    if (remaining.length === 0) {
      pushLog(runJob.logs, 'All functions already analyzed. Use force mode to re-analyze.')
      runJob.status = 'done'
      return
    }

    // Close init session before starting workers (they each get their own)
    await initSession.close()

    // Process functions with concurrency — each worker gets its own Neo4j session
    await runWithConcurrency(remaining, concurrency, async (fn) => {
      if (runJob.abortRequested) return

      const fnIdx = runJob.functions.findIndex(f => f.name === fn.name && f.file === fn.filePath)
      if (fnIdx >= 0) runJob.functions[fnIdx].status = 'running'
      pushLog(runJob.logs, JSON.stringify({ type: 'function-start', name: fn.name, file: fn.filePath, index: fnIdx }))

      // Per-worker session for safe concurrent DB access
      const workerSession = await getSession()
      try {
        await deleteOldDecisionsForFunction(workerSession, fn.name, fn.filePath, repo)

        const configOverrides: Record<string, any> = {}
        if (advancedConfig?.contextModules) configOverrides.advanced_modules = advancedConfig.contextModules
        if (advancedConfig?.maxRounds) configOverrides.advanced_max_rounds = advancedConfig.maxRounds

        const templateName = advancedConfig?.advancedMode ? '_advanced' : '_default'

        const result = await analyzeFunction(
          {
            functionName: fn.name,
            filePath: fn.filePath,
            repo,
            repoPath: repoConfig.path,
            lineStart: fn.lineStart,
            lineEnd: fn.lineEnd,
            owner: 'dashboard',
            session: workerSession,
          },
          configOverrides,
          templateName,
        )

        const decCount = result.decisions.length
        runJob.analyzed++
        runJob.decisions += decCount

        if (decCount > 0) {
          await batchWriteDecisions(workerSession, result.decisions)
          const newIds = result.decisions.map(d => d.id)
          await createPendingEdges(workerSession, newIds, { verbose: false })
        }

        if (fnIdx >= 0) {
          runJob.functions[fnIdx].status = 'done'
          runJob.functions[fnIdx].decisions = decCount
        }

        const durSec = (result.metadata.duration_ms / 1000).toFixed(1)
        pushLog(runJob.logs, JSON.stringify({
          type: 'function-done', name: fn.name, file: fn.filePath,
          decisions: decCount, duration: durSec, index: fnIdx,
        }))
      } catch (err: any) {
        if (fnIdx >= 0) runJob.functions[fnIdx].status = 'error'
        pushLog(runJob.logs, JSON.stringify({
          type: 'function-error', name: fn.name, file: fn.filePath,
          error: err.message, stack: err.stack?.split('\n')[1]?.trim(), index: fnIdx,
        }))
      } finally {
        await workerSession.close()
      }

      // Save state every function for crash resilience
      state.analyzed.push(`${fn.filePath}::${fn.name}`)
      saveRunState(state)

      pushLog(runJob.logs, JSON.stringify({
        type: 'progress', analyzed: runJob.analyzed, decisions: runJob.decisions,
        total: runJob.total, skipped: runJob.skipped,
      }))
    })



    if (runJob.abortRequested) {
      runJob.status = 'idle'
      pushLog(runJob.logs, JSON.stringify({ type: 'stopped', analyzed: runJob.analyzed, decisions: runJob.decisions }))
    } else {
      runJob.status = 'done'
      pushLog(runJob.logs, JSON.stringify({ type: 'done', analyzed: runJob.analyzed, decisions: runJob.decisions }))
    }
  } catch (err: any) {
    runJob.status = 'error'
    pushLog(runJob.logs, JSON.stringify({ type: 'error', error: err.message }))
    // initSession may still be open if error happened before close
    try { await initSession.close() } catch {}
  }
}

app.get('/api/run/status', (c) => {
  return c.json({
    status: runJob.status,
    repo: runJob.repo,
    analyzed: runJob.analyzed,
    decisions: runJob.decisions,
    total: runJob.total,
    skipped: runJob.skipped,
    functions: runJob.functions,
    startedAt: runJob.startedAt,
  })
})

app.post('/api/run/start', async (c) => {
  if (runJob.status === 'running') {
    return c.json({ error: 'Analysis already running' }, 409)
  }

  const body = await c.req.json()
  const { repo, summaryWords, contentWords, concurrency = 2, advancedMode, contextModules, maxRounds } = body

  if (!repo) return c.json({ error: 'repo is required' }, 400)

  // Validate repo exists
  const config = loadConfig()
  if (!config.repos.find((r: any) => r.name === repo)) {
    return c.json({ error: `Repo "${repo}" not found in config` }, 400)
  }

  // Save analysis config if changed
  if (summaryWords || contentWords) {
    try {
      const configPath = path.resolve(__dirname, '../../ckg.config.json')
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      raw.analysis = {
        ...raw.analysis,
        ...(summaryWords ? { summaryWords: parseInt(summaryWords) } : {}),
        ...(contentWords ? { contentWords: parseInt(contentWords) } : {}),
      }
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2))
      clearConfigCache()
    } catch {}
  }

  // Reset job state
  runJob.status = 'running'
  runJob.repo = repo
  runJob.logs.clear()
  runJob.functions = []
  runJob.analyzed = 0
  runJob.decisions = 0
  runJob.total = 0
  runJob.skipped = 0
  runJob.startedAt = Date.now()
  runJob.abortRequested = false

  // Kick off analysis (don't await)
  const advCfg = advancedMode ? { advancedMode, contextModules, maxRounds } : undefined
  runAnalysis(repo, concurrency, advCfg).catch(err => {
    runJob.status = 'error'
    pushLog(runJob.logs,JSON.stringify({ type: 'error', error: err.message }))
  })

  return c.json({ status: 'started', repo })
})

app.post('/api/run/stop', (c) => {
  if (runJob.status === 'running') {
    runJob.abortRequested = true
    pushLog(runJob.logs,JSON.stringify({ type: 'stopping' }))
  }
  return c.json({ status: 'stopping' })
})

app.get('/api/run/stream', (c) => {
  return streamSSE(c, async (stream) => {
    let lastSeq = -1
    let done = false

    while (!done) {
      const [entries, newSeq] = runJob.logs.readAfter(lastSeq)
      for (const line of entries) {
        try {
          const parsed = JSON.parse(line)
          await stream.writeSSE({ data: line, event: parsed.type || 'log' })
        } catch {
          await stream.writeSSE({ data: line, event: 'log' })
        }
      }
      lastSeq = newSeq

      if (runJob.status !== 'running' && runJob.logs.readAfter(lastSeq)[0].length === 0) {
        await stream.writeSSE({ data: runJob.status, event: 'status' })
        done = true
        break
      }

      await new Promise(resolve => setTimeout(resolve, 200))
    }
  })
})

// ══════════════════════════════════════════════════════════
// ── Group Decisions: batch grouping + relationship discovery
// ══════════════════════════════════════════════════════════

interface GroupBatchStatus {
  index: number
  status: 'pending' | 'running' | 'done' | 'error'
  newCount: number
  oldCount: number
  edgesFound: number
  groups: number
}

interface GroupJob {
  status: 'idle' | 'running' | 'done' | 'error'
  logs: LogBuffer
  batches: GroupBatchStatus[]
  batchesDone: number
  edgesFound: number
  startedAt: number
  abortRequested: boolean
}

const groupJob: GroupJob = {
  status: 'idle', logs: new LogBuffer(), batches: [],
  batchesDone: 0, edgesFound: 0,
  startedAt: 0, abortRequested: false,
}

app.get('/api/group/stats', async (c) => {
  const session = await getSession()
  try {
    // PENDING edge stats
    const pendingStatus = await getPendingStatus(session)

    // Total decisions
    const totalResult = await session.run(
      `MATCH (d:DecisionContext) RETURN count(d) AS cnt`
    )
    const total = num(totalResult.records[0]?.get('cnt'))

    // Connected relationship edges
    const connectedResult = await session.run(
      `MATCH ()-[r:CAUSED_BY|DEPENDS_ON|CONFLICTS_WITH|CO_DECIDED]->()
       RETURN count(r) AS cnt`
    )
    const connected = num(connectedResult.records[0]?.get('cnt'))

    return c.json({
      pending: pendingStatus.totalPendingEdges,
      total,
      connected,
      newDecisions: pendingStatus.decisionsWithPending,
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

app.post('/api/group/start', async (c) => {
  if (groupJob.status === 'running') {
    return c.json({ error: 'Grouping already running' }, 409)
  }

  const body = await c.req.json()
  const { mode = 'summary', batchSize = 50 } = body

  // Reset job
  groupJob.status = 'running'
  groupJob.logs.clear()
  groupJob.batches = []
  groupJob.batchesDone = 0
  groupJob.edgesFound = 0
  groupJob.startedAt = Date.now()
  groupJob.abortRequested = false

  // Run grouping in background
  ;(async () => {
    const session = await getSession()
    try {
      const config = loadConfig()
      const ai = createAIProvider(config.ai)

      pushLog(groupJob.logs,JSON.stringify({ type: 'started', mode, batchSize }))

      const abortSignal = { get aborted() { return groupJob.abortRequested } }

      await connectDecisions({
        dbSession: session,
        ai,
        batchCapacity: batchSize,
        concurrency: 2,
        verbose: true,
        mode,
        abortSignal,
        onGroupDone: (info) => {
          pushLog(groupJob.logs, JSON.stringify({
            type: 'group-done',
            batch: info.batchIndex,
            group: info.groupIndex,
            totalGroups: info.totalGroups,
            edges: info.edgesFound,
            reason: info.reason,
          }))
        },
        onBatchProgress: (event: BatchProgressEvent) => {
          const batch: GroupBatchStatus = {
            index: event.batchIndex,
            status: event.status === 'done' ? 'done' : event.status === 'error' ? 'error' : 'running',
            newCount: 0,
            oldCount: event.decisionsInBatch,
            edgesFound: event.edgesCreated,
            groups: event.groupsFound,
          }
          groupJob.batches.push(batch)
          groupJob.batchesDone++
          groupJob.edgesFound += event.edgesCreated

          pushLog(groupJob.logs,JSON.stringify({
            type: 'batch-done',
            batch: event.batchIndex,
            decisions: event.decisionsInBatch,
            groups: event.groupsFound,
            edges: event.edgesCreated,
            pendingRemaining: event.pendingRemaining,
          }))

          // Progress event
          pushLog(groupJob.logs,JSON.stringify({
            type: 'progress',
            batchesDone: groupJob.batchesDone,
            edgesFound: groupJob.edgesFound,
            pendingRemaining: event.pendingRemaining,
          }))
        },
      })

      ai.cleanup()

      if (groupJob.abortRequested) {
        groupJob.status = 'idle'
        pushLog(groupJob.logs,JSON.stringify({ type: 'stopped', batchesDone: groupJob.batchesDone, edgesFound: groupJob.edgesFound }))
      } else {
        groupJob.status = 'done'
        pushLog(groupJob.logs,JSON.stringify({ type: 'done', batchesDone: groupJob.batchesDone, edgesFound: groupJob.edgesFound }))
      }
    } catch (err: any) {
      groupJob.status = 'error'
      pushLog(groupJob.logs,JSON.stringify({ type: 'error', error: err.message }))
    } finally {
      await session.close()
    }
  })()

  return c.json({ status: 'started', mode, batchSize })
})

app.post('/api/group/stop', (c) => {
  if (groupJob.status === 'running') {
    groupJob.abortRequested = true
    pushLog(groupJob.logs,JSON.stringify({ type: 'stopping' }))
  }
  return c.json({ status: 'stopping' })
})

app.get('/api/group/stream', (c) => {
  return streamSSE(c, async (stream) => {
    let lastSeq = -1
    let done = false

    while (!done) {
      const [entries, newSeq] = groupJob.logs.readAfter(lastSeq)
      for (const line of entries) {
        try {
          const parsed = JSON.parse(line)
          await stream.writeSSE({ data: line, event: parsed.type || 'log' })
        } catch {
          await stream.writeSSE({ data: line, event: 'log' })
        }
      }
      lastSeq = newSeq

      if (groupJob.status !== 'running' && groupJob.logs.readAfter(lastSeq)[0].length === 0) {
        await stream.writeSSE({ data: groupJob.status, event: 'status' })
        done = true
        break
      }

      await new Promise(resolve => setTimeout(resolve, 200))
    }
  })
})

// ── Localize Pipeline ────────────────────────────────────

import {
  localizeDecisions, localizeSingleDecision,
  fetchDecisionsToLocalize,
} from '../localization/localize-decisions'

interface LocalizeJob {
  status: 'idle' | 'running' | 'done' | 'error'
  locale: string
  logs: LogBuffer
  translated: number
  failed: number
  total: number
  startedAt: number
  abortRequested: boolean
}

const localizeJob: LocalizeJob = {
  status: 'idle', locale: 'zh', logs: new LogBuffer(),
  translated: 0, failed: 0, total: 0,
  startedAt: 0, abortRequested: false,
}

app.get('/api/localize/stats', async (c) => {
  const locale = c.req.query('locale') ?? 'zh'
  const session = await getSession()
  try {
    const totalResult = await session.run(
      `MATCH (d:DecisionContext)
       WHERE d.summary IS NOT NULL AND d.source <> 'manual_business_context'
       RETURN count(d) AS cnt`
    )
    const total = num(totalResult.records[0]?.get('cnt'))

    const localizedResult = await session.run(
      `MATCH (d:DecisionContext)
       WHERE d.summary_${locale} IS NOT NULL
       RETURN count(d) AS cnt`
    )
    const localized = num(localizedResult.records[0]?.get('cnt'))

    return c.json({ total, localized, pending: total - localized, locale })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

app.post('/api/localize/start', async (c) => {
  if (localizeJob.status === 'running') {
    return c.json({ error: 'Localization already running' }, 409)
  }

  const body = await c.req.json()
  const { locale = 'zh', repo, batchSize = 5, force = false } = body

  // Reset job
  localizeJob.status = 'running'
  localizeJob.locale = locale
  localizeJob.logs.clear()
  localizeJob.translated = 0
  localizeJob.failed = 0
  localizeJob.total = 0
  localizeJob.startedAt = Date.now()
  localizeJob.abortRequested = false

  // Run in background
  ;(async () => {
    const session = await getSession()
    try {
      const config = loadConfig()
      const ai = createAIProvider(config.ai)

      pushLog(localizeJob.logs, JSON.stringify({ type: 'started', locale, repo: repo ?? null, batchSize, force }))

      const result = await localizeDecisions(session, ai, {
        locale, repo, batchSize, force,
      }, {
        onBatchStart: (batch, count) => {
          pushLog(localizeJob.logs, JSON.stringify({ type: 'batch-start', batch, count }))
        },
        onBatchDone: (batch, translated) => {
          localizeJob.translated += translated
          pushLog(localizeJob.logs, JSON.stringify({
            type: 'batch-done', batch, translated,
            totalTranslated: localizeJob.translated,
          }))
        },
        onBatchError: (batch, error) => {
          pushLog(localizeJob.logs, JSON.stringify({ type: 'batch-error', batch, error }))
        },
        onProgress: (translated, total) => {
          localizeJob.total = total
          pushLog(localizeJob.logs, JSON.stringify({
            type: 'progress', translated, total,
          }))
        },
        shouldAbort: () => localizeJob.abortRequested,
      })

      ai.cleanup()

      localizeJob.translated = result.translated
      localizeJob.failed = result.failed
      localizeJob.total = result.total

      if (localizeJob.abortRequested) {
        localizeJob.status = 'idle'
        pushLog(localizeJob.logs, JSON.stringify({ type: 'stopped', translated: result.translated }))
      } else {
        localizeJob.status = 'done'
        pushLog(localizeJob.logs, JSON.stringify({
          type: 'done', translated: result.translated, failed: result.failed,
          total: result.total, durationMs: result.durationMs,
        }))
      }
    } catch (err: any) {
      localizeJob.status = 'error'
      pushLog(localizeJob.logs, JSON.stringify({ type: 'error', error: err.message }))
    } finally {
      await session.close()
    }
  })()

  return c.json({ status: 'started', locale })
})

app.post('/api/localize/stop', (c) => {
  if (localizeJob.status === 'running') {
    localizeJob.abortRequested = true
    pushLog(localizeJob.logs, JSON.stringify({ type: 'stopping' }))
  }
  return c.json({ status: 'stopping' })
})

app.get('/api/localize/status', (c) => {
  return c.json({
    status: localizeJob.status,
    locale: localizeJob.locale,
    translated: localizeJob.translated,
    failed: localizeJob.failed,
    total: localizeJob.total,
    startedAt: localizeJob.startedAt,
  })
})

app.get('/api/localize/stream', (c) => {
  return streamSSE(c, async (stream) => {
    let lastSeq = -1
    let done = false

    while (!done) {
      const [entries, newSeq] = localizeJob.logs.readAfter(lastSeq)
      for (const line of entries) {
        try {
          const parsed = JSON.parse(line)
          await stream.writeSSE({ data: line, event: parsed.type || 'log' })
        } catch {
          await stream.writeSSE({ data: line, event: 'log' })
        }
      }
      lastSeq = newSeq

      if (localizeJob.status !== 'running' && localizeJob.logs.readAfter(lastSeq)[0].length === 0) {
        await stream.writeSSE({ data: localizeJob.status, event: 'status' })
        done = true
        break
      }

      await new Promise(resolve => setTimeout(resolve, 200))
    }
  })
})

// Single decision translation
app.post('/api/localize/decision/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const locale = (body as any).locale ?? 'zh'

  const session = await getSession()
  try {
    const config = loadConfig()
    const ai = createAIProvider(config.ai)
    const ok = await localizeSingleDecision(session, ai, id, locale)
    return ok ? c.json({ status: 'ok' }) : c.json({ error: 'Decision not found' }, 404)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

// ── Scan Pipeline: goal-based analysis ───────────────────

app.get('/api/scan/config', (c) => {
  try {
    const config = loadConfig()
    const analysis = getAnalysisConfig()
    return c.json({
      repos: config.repos.map(r => ({ name: r.name, type: r.type })),
      analysis,
    })
  } catch {
    return c.json({ repos: [] })
  }
})

// ── Session Ingestion API ────────────────────────────────

// in-memory parsed turns cache (re-parsed from JSONL as needed)
const turnsCache = new Map<string, Phase0Result>()

function getOrParsePhase0(sessionId: string, filePath: string, project: string): Phase0Result {
  if (turnsCache.has(sessionId)) return turnsCache.get(sessionId)!
  const result = parseSessionJSONL(filePath, project)
  turnsCache.set(sessionId, result)
  updateCacheEntry(sessionId, result.turns.length, result.estimatedTokens)
  saveCache()
  return result
}

// session ingestion SSE state
const sessionJobs = new Map<string, { logs: string[]; status: string }>()

app.get('/api/sessions', (c) => {
  const project = c.req.query('project') || undefined
  const sessions = listAllSessions(project)
  const states = listSessionStates()
  const stateMap = new Map(states.map(s => [s.sessionId, s]))

  const result = sessions.map(s => ({
    ...s,
    status: stateMap.get(s.id)?.status ?? 'new',
    phase1Segments: stateMap.get(s.id)?.phase1?.segments?.length ?? null,
    phase2Decisions: stateMap.get(s.id)?.phase2?.totalDecisions ?? null,
  }))

  return c.json(result)
})

app.get('/api/sessions/:id/preview', (c) => {
  const id = c.req.param('id')
  const session = findSession(id)
  if (!session) return c.json({ error: 'Session not found' }, 404)

  try {
    const phase0 = getOrParsePhase0(session.id, session.filePath, session.project)

    // save state
    let state = loadSessionState(session.id)
    if (!state) {
      state = createInitialState(session.id, session.tool, session.project, session.filePath)
    }
    setPhase0Done(state, phase0)
    saveSessionState(state)

    // return preview: first 10 turns + summary
    const preview = phase0.turns.slice(0, 10).map((t, i) => ({
      index: i,
      role: t.role,
      content: t.content.slice(0, 300) + (t.content.length > 300 ? '...' : ''),
      filesReferenced: t.filesReferenced,
    }))

    return c.json({
      sessionId: phase0.sessionId,
      project: phase0.projectName,
      turnCount: phase0.turns.length,
      touchedFiles: phase0.touchedFiles,
      estimatedTokens: phase0.estimatedTokens,
      sessionStart: phase0.sessionStart,
      sessionEnd: phase0.sessionEnd,
      preview,
      status: state.status,
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.get('/api/sessions/:id/state', (c) => {
  const id = c.req.param('id')
  const state = loadSessionState(id)
  if (!state) {
    // try to find by prefix
    const session = findSession(id)
    if (session) {
      const full = loadSessionState(session.id)
      if (full) return c.json(full)
    }
    return c.json({ error: 'No state found' }, 404)
  }
  return c.json(state)
})

app.post('/api/sessions/:id/segment', async (c) => {
  const id = c.req.param('id')
  const session = findSession(id)
  if (!session) return c.json({ error: 'Session not found' }, 404)

  let state = loadSessionState(session.id)
  if (!state) return c.json({ error: 'Run preview first' }, 400)

  // if already segmented, return cached result
  if (state.phase1 && state.status !== 'new' && state.status !== 'phase0_done') {
    return c.json({ segments: state.phase1.segments, cached: true })
  }

  state.status = 'phase1_running'
  saveSessionState(state)

  try {
    const config = loadConfig()
    const ai = createAIProvider(config.ai)
    const phase0 = getOrParsePhase0(session.id, session.filePath, session.project)

    const dbSession = await getSession()
    try {
      const bizCtx = await getBusinessContext(dbSession)

      // build code structure
      const repoConfig = config.repos.find(r =>
        session.project.includes(r.name) || r.name.includes(session.project)
      )
      let codeStructure = ''
      if (repoConfig) {
        const files = await getFilesFromGraph(dbSession, repoConfig.name)
        const relevant = files.filter(f =>
          phase0.touchedFiles.some(tf =>
            f.filePath.includes(tf) || tf.includes(f.filePath)
          )
        )
        codeStructure = relevant.map(f =>
          `${f.filePath}: ${f.functions.map(fn => fn.name).join(', ')}`
        ).join('\n')
      }

      const conversationText = formatTurnsForPrompt(phase0.turns)
      const TOKEN_BUDGET = 80000

      let segments: SessionSegment[]
      if (phase0.estimatedTokens <= TOKEN_BUDGET) {
        const prompt = buildSegmentationPrompt(
          phase0.projectName, phase0.sessionStart, phase0.sessionEnd,
          conversationText, codeStructure, bizCtx
        )
        const raw = await ai.call(prompt)
        segments = parseJsonSafe<SessionSegment[]>(raw, [])
        if (!Array.isArray(segments)) segments = []
      } else {
        // chunked fallback — simplified for API (reuse logic from CLI)
        segments = []
        // TODO: implement chunked Phase 1 for API
      }

      setPhase1Done(state, segments, phase0.estimatedTokens <= TOKEN_BUDGET ? 1 : 0)
      saveSessionState(state)

      ai.cleanup()

      return c.json({ segments: state.phase1!.segments, cached: false })
    } finally {
      await dbSession.close()
    }
  } catch (err: any) {
    setError(state, err.message)
    saveSessionState(state)
    return c.json({ error: err.message }, 500)
  }
})

app.post('/api/sessions/:id/analyze', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ approved: number[] }>()
  const session = findSession(id)
  if (!session) return c.json({ error: 'Session not found' }, 404)

  let state = loadSessionState(session.id)
  if (!state?.phase1) return c.json({ error: 'Run segmentation first' }, 400)

  setPhase2Started(state, body.approved)
  saveSessionState(state)

  // setup SSE job
  const jobId = session.id
  sessionJobs.set(jobId, { logs: [], status: 'running' })
  const log = (msg: string) => {
    sessionJobs.get(jobId)?.logs.push(msg)
  }

  // run async — return immediately, client polls via SSE
  ;(async () => {
    try {
      const config = loadConfig()
      const ai = createAIProvider(config.ai)
      const phase0 = getOrParsePhase0(session.id, session.filePath, session.project)
      const dbSession = await getSession()

      try {
        const bizCtx = await getBusinessContext(dbSession)
        const repoConfig = config.repos.find(r =>
          session.project.includes(r.name) || r.name.includes(session.project)
        )
        const allDecisions: PendingDecision[] = []

        for (const segIdx of body.approved) {
          const segment = state!.phase1!.segments[segIdx]
          if (!segment) continue

          log(`Analyzing segment ${segIdx}: ${segment.summary.slice(0, 60)}...`)

          const rawConversation = extractRawTurnsForSegment(
            session.filePath, phase0.turns, segment.startTurn, segment.endTurn
          )

          // build code structure + caller/callee
          let codeStructureSection = ''
          let callerCalleeSection = ''
          if (repoConfig) {
            const allFiles = await getFilesFromGraph(dbSession, repoConfig.name)
            const relevantFiles = allFiles.filter(f =>
              segment.touchedFiles?.some((tf: string) =>
                f.filePath.includes(tf) || tf.includes(f.filePath)
              )
            )
            codeStructureSection = relevantFiles.map(f =>
              `### ${f.filePath}\nFunctions: ${f.functions.map(fn => `${fn.name} (${fn.lineStart}-${fn.lineEnd})`).join(', ')}`
            ).join('\n\n')

            const ccParts: string[] = []
            for (const file of relevantFiles.slice(0, 3)) {
              for (const fn of file.functions.slice(0, 3)) {
                try {
                  const { callerCodes, calleeCodes } = await buildCallerCalleeCodes(
                    dbSession, fn.name, file.filePath, file.repo, repoConfig.path
                  )
                  if (callerCodes.length > 0) ccParts.push(callerCodes.map(c => `${c.filePath}::${c.name}:\n\`\`\`\n${c.code}\n\`\`\``).join('\n'))
                  if (calleeCodes.length > 0) ccParts.push(calleeCodes.map(c => `${c.filePath}::${c.name}:\n\`\`\`\n${c.code}\n\`\`\``).join('\n'))
                } catch {}
              }
            }
            callerCalleeSection = ccParts.join('\n\n')
          }

          const prompt = buildExtractionPrompt(
            phase0.projectName, segment.summary,
            segment.decisionHints || [], rawConversation,
            codeStructureSection, callerCalleeSection, bizCtx,
            getAnalysisConfig()
          )

          try {
            const raw = await ai.call(prompt)
            const decisions = parseJsonSafe<any[]>(raw, [])
            if (!Array.isArray(decisions)) continue

            const now = new Date().toISOString()
            const repo = repoConfig?.name ?? phase0.projectName

            const pending: PendingDecision[] = decisions
              .filter((d: any) => d.summary && d.content)
              .map((d: any, i: number) => {
                const fnName = d.function ?? ''
                const filePath = d.file ?? ''
                const pathSlug = filePath ? filePath.replace(/\//g, '_').replace(/\.[^.]+$/, '') : 'no-file'
                const dcId = `dc:sess:${phase0.sessionId.slice(0, 8)}:${pathSlug}:${i}:${Date.now()}`
                return {
                  id: dcId,
                  props: {
                    summary: String(d.summary), content: String(d.content),
                    keywords: Array.isArray(d.keywords) ? d.keywords : [],
                    scope: [repo], owner: 'me',
                    session_id: phase0.sessionId, commit_hash: 'session-extract',
                    source: 'session_ingestion', confidence: 'auto_generated',
                    staleness: 'active', finding_type: d.finding_type || 'decision',
                    transcript_range: `${phase0.sessionId}:${segment.startTurn}-${segment.endTurn}`,
                    created_at: now, updated_at: now,
                  },
                  functionName: fnName,
                  relatedFunctions: Array.isArray(d.related_functions) ? d.related_functions.map(String) : [],
                  filePath, fileName: filePath ? filePath.split('/').pop()! : '', repo,
                } as PendingDecision
              })

            const { nodes, anchored } = await batchWriteDecisions(dbSession, pending)
            allDecisions.push(...pending)
            addPhase2SegmentResult(state!, segIdx, pending.length, pending.map(p => p.id), anchored)
            saveSessionState(state!)
            log(`  ✓ ${pending.length} decisions, ${anchored} anchored`)
          } catch (err: any) {
            log(`  ✗ ${err.message}`)
          }
        }

        // Round 4: relationships
        let totalEdges = 0
        if (allDecisions.length >= 2) {
          log('Running Round 4: Relationships...')
          try {
            const summaries: DecisionSummaryForGrouping[] = allDecisions.map(d => ({
              id: d.id, function: d.functionName, file: d.filePath,
              summary: d.props.summary, keywords: d.props.keywords,
            }))
            const groupRaw = await ai.call(buildGroupingPrompt(summaries, []))
            const groups = parseJsonSafe<{ group: string[]; reason: string }[]>(groupRaw, [])

            if (Array.isArray(groups)) {
              for (const group of groups) {
                const gd: DecisionFullContent[] = []
                for (const gid of group.group) {
                  const d = allDecisions.find(ad => ad.id === gid)
                  if (d) gd.push({ id: d.id, function: d.functionName, file: d.filePath, summary: d.props.summary, content: d.props.content, keywords: d.props.keywords })
                }
                if (gd.length < 2) continue
                try {
                  const relRaw = await ai.call(buildRelationshipPrompt(gd, group.reason))
                  const result = parseJsonSafe<{ edges: any[] }>(relRaw, { edges: [] })
                  for (const edge of result.edges || []) {
                    const et = String(edge.type).toUpperCase()
                    if (!['CAUSED_BY','DEPENDS_ON','CONFLICTS_WITH','CO_DECIDED'].includes(et)) continue
                    try {
                      await dbSession.run(`MATCH (a:DecisionContext {id: $from}) MATCH (b:DecisionContext {id: $to}) MERGE (a)-[r:${et}]->(b) SET r.reason = $reason`, { from: edge.from, to: edge.to, reason: String(edge.reason ?? '') })
                      totalEdges++
                    } catch {}
                  }
                } catch {}
              }
            }
            log(`  ${totalEdges} relationship edges`)
          } catch (err: any) {
            log(`  Relationships failed: ${err.message}`)
          }

          // keyword normalization
          try {
            const allKw = allDecisions.flatMap(d => d.props.keywords ?? [])
            if (allKw.length > 0) {
              const normRaw = await ai.call(buildKeywordNormalizationPrompt(allKw))
              const norms = parseJsonSafe<{ canonical: string; aliases: string[] }[]>(normRaw, [])
              if (Array.isArray(norms)) {
                for (const n of norms) {
                  if (!n.canonical || !Array.isArray(n.aliases)) continue
                  for (const alias of n.aliases) {
                    try { await dbSession.run(`MATCH (d:DecisionContext) WHERE ANY(k IN d.keywords WHERE k = $alias) AND NOT ANY(k IN d.keywords WHERE k = $canonical) SET d.keywords = d.keywords + [$canonical]`, { alias, canonical: n.canonical }) } catch {}
                  }
                }
              }
            }
          } catch {}
        }

        setPhase2Done(state!, totalEdges)
        saveSessionState(state!)

        ai.cleanup()

        log(`Done: ${allDecisions.length} decisions, ${totalEdges} edges`)
        sessionJobs.get(jobId)!.status = 'done'
      } finally {
        await dbSession.close()
      }
    } catch (err: any) {
      setError(state!, err.message)
      saveSessionState(state!)
      log(`Error: ${err.message}`)
      sessionJobs.get(jobId)!.status = 'error'
    }
  })()

  return c.json({ status: 'started', jobId })
})

app.get('/api/sessions/:id/stream', (c) => {
  const id = c.req.param('id')
  const session = findSession(id)
  const jobId = session?.id ?? id

  return streamSSE(c, async (stream) => {
    let lastIdx = 0
    let done = false
    while (!done) {
      const job = sessionJobs.get(jobId)
      if (!job) {
        await stream.writeSSE({ data: 'No active job', event: 'error' })
        break
      }
      while (lastIdx < job.logs.length) {
        await stream.writeSSE({ data: job.logs[lastIdx], event: 'log' })
        lastIdx++
      }
      if (job.status !== 'running' && lastIdx >= job.logs.length) {
        await stream.writeSSE({ data: job.status, event: 'status' })
        done = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  })
})

// ── API: Semantic search ──────────────────────────────────

import { createEmbeddingProvider, EmbeddingConfig } from '../ai/embeddings'
import { LocalVectorStore } from '../ai/vector-store'
import { readFeedbackLog } from '../ingestion/feedback'

let vectorStore: LocalVectorStore | null = null
let embeddingProvider: any = null

async function getVectorSearch() {
  if (vectorStore && embeddingProvider) return { store: vectorStore, embed: embeddingProvider }
  try {
    const config = loadConfig()
    const embCfg = config.ai?.embedding
    if (!embCfg) return null
    embeddingProvider = createEmbeddingProvider(embCfg as EmbeddingConfig)
    vectorStore = new LocalVectorStore()
    await vectorStore.load()
    return { store: vectorStore, embed: embeddingProvider }
  } catch {
    return null
  }
}

app.post('/api/search/semantic', async (c) => {
  const body = await c.req.json()
  const { query, limit = 10 } = body
  if (!query) return c.json({ error: 'query is required' }, 400)

  const vs = await getVectorSearch()
  if (!vs) return c.json({ error: 'Embedding not configured. Set ai.embedding in ckg.config.json' }, 400)

  try {
    const [queryEmbedding] = await vs.embed.embed([query], 'query')
    const results = vs.store.search(queryEmbedding, limit)

    // Fetch decision details from graph
    const session = await getSession()
    try {
      const decisions = []
      for (const r of results) {
        const res = await session.run(
          `MATCH (d:DecisionContext {id: $id})
           OPTIONAL MATCH (d)-[:ANCHORED_TO]->(ce:CodeEntity)
           RETURN d, collect(ce.name) AS anchors`,
          { id: r.id }
        )
        if (res.records.length > 0) {
          const d = res.records[0].get('d').properties
          decisions.push({
            id: d.id, summary: d.summary, content: d.content,
            keywords: d.keywords, source: d.source,
            finding_type: d.finding_type || 'decision',
            scope: d.scope, score: r.score,
            anchors: res.records[0].get('anchors').filter(Boolean),
          })
        }
      }
      return c.json({ results: decisions, query })
    } finally {
      await session.close()
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── API: Feedback stats ────────────────────────────────

app.get('/api/feedback/stats', async (c) => {
  const entries = readFeedbackLog()
  const useCounts: Record<string, number> = {}
  let totalUsages = 0

  for (const entry of entries) {
    for (const id of entry.used_ids || []) {
      useCounts[id] = (useCounts[id] || 0) + 1
      totalUsages++
    }
  }

  // Get decision details for top used
  const sorted = Object.entries(useCounts).sort((a, b) => b[1] - a[1])
  const topUsed: any[] = []
  const session = await getSession()
  try {
    for (const [id, count] of sorted.slice(0, 30)) {
      const res = await session.run(
        `MATCH (d:DecisionContext {id: $id}) RETURN d.summary AS summary, d.source AS source, d.scope AS scope`,
        { id }
      )
      topUsed.push({
        id, useCount: count,
        summary: res.records[0]?.get('summary') || '(deleted)',
        source: res.records[0]?.get('source') || null,
        scope: res.records[0]?.get('scope') || null,
      })
    }

    // Get never-used decisions
    const allDecisions = await session.run(
      `MATCH (d:DecisionContext) RETURN d.id AS id, d.summary AS summary, d.source AS source, d.created_at AS created_at LIMIT 500`
    )
    const neverUsed = allDecisions.records
      .filter(r => !useCounts[r.get('id')])
      .map(r => ({
        id: r.get('id'), summary: r.get('summary'),
        source: r.get('source'), created_at: r.get('created_at'),
      }))

    return c.json({
      totalEntries: entries.length,
      totalUsages,
      uniqueDecisionsUsed: Object.keys(useCounts).length,
      topUsed,
      neverUsed: neverUsed.slice(0, 50),
      neverUsedTotal: neverUsed.length,
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

// ── API: Decision relationships graph ──────────────────

app.get('/api/decisions/relationships', async (c) => {
  const session = await getSession()
  try {
    const nodesResult = await session.run(
      `MATCH (d:DecisionContext)
       WHERE (d)-[:CAUSED_BY|DEPENDS_ON|CONFLICTS_WITH|CO_DECIDED]-() OR ()-[:CAUSED_BY|DEPENDS_ON|CONFLICTS_WITH|CO_DECIDED]->(d)
       RETURN DISTINCT d.id AS id, d.summary AS summary, d.finding_type AS ftype,
              d.keywords AS keywords, d.scope AS scope`
    )
    const edgesResult = await session.run(
      `MATCH (a:DecisionContext)-[r]->(b:DecisionContext)
       WHERE type(r) IN ['CAUSED_BY','DEPENDS_ON','CONFLICTS_WITH','CO_DECIDED']
       RETURN a.id AS from, b.id AS to, type(r) AS type, r.reason AS reason`
    )

    return c.json({
      nodes: nodesResult.records.map(r => ({
        id: r.get('id'), summary: r.get('summary'),
        ftype: r.get('ftype') || 'decision',
        keywords: r.get('keywords') || [],
        scope: r.get('scope') || [],
      })),
      edges: edgesResult.records.map(r => ({
        from: r.get('from'), to: r.get('to'),
        type: r.get('type'), reason: r.get('reason') || '',
      })),
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

// ── API: Global search ───────────────────────────────────

app.get('/api/search', async (c) => {
  const q = c.req.query('q')
  if (!q || q.length < 2) return c.json({ decisions: [], entities: [], keywords: [] })

  const session = await getSession()
  try {
    // 1. Search decisions by summary/content
    const decResult = await session.run(
      `MATCH (d:DecisionContext)
       WHERE d.summary CONTAINS $q OR d.content CONTAINS $q
       OPTIONAL MATCH (d)-[:ANCHORED_TO]->(ce:CodeEntity)
       RETURN d.id AS id, d.summary AS summary, d.finding_type AS ftype,
              d.source AS source, d.scope AS scope,
              collect(DISTINCT ce.name) AS anchors
       LIMIT 10`,
      { q }
    )

    // 2. Search code entities by name
    const entResult = await session.run(
      `MATCH (ce:CodeEntity)
       WHERE ce.name CONTAINS $q
       RETURN ce.name AS name, ce.entity_type AS type, ce.repo AS repo, ce.path AS path
       LIMIT 10`,
      { q }
    )

    // 3. Search by keyword
    const kwResult = await session.run(
      `MATCH (d:DecisionContext)
       WHERE ANY(k IN d.keywords WHERE k CONTAINS $q)
       RETURN d.id AS id, d.summary AS summary, d.finding_type AS ftype, d.keywords AS keywords
       LIMIT 10`,
      { q }
    )

    return c.json({
      decisions: decResult.records.map(r => ({
        id: r.get('id'), summary: r.get('summary'),
        ftype: r.get('ftype') || 'decision', source: r.get('source'),
        scope: r.get('scope'), anchors: r.get('anchors').filter(Boolean),
      })),
      entities: entResult.records.map(r => ({
        name: r.get('name'), type: r.get('type'),
        repo: r.get('repo'), path: r.get('path'),
      })),
      keywords: kwResult.records.map(r => ({
        id: r.get('id'), summary: r.get('summary'),
        ftype: r.get('ftype') || 'decision', keywords: r.get('keywords'),
      })),
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

// ── API: Session decisions (review + delete) ─────────────

app.get('/api/sessions/:id/decisions', async (c) => {
  const id = c.req.param('id')
  const session = await getSession()
  try {
    // Find decisions linked to this session via transcript_range or session_id
    const result = await session.run(
      `MATCH (d:DecisionContext)
       WHERE d.session_id CONTAINS $id OR d.transcript_range STARTS WITH $id
       OPTIONAL MATCH (d)-[:ANCHORED_TO]->(ce:CodeEntity)
       RETURN d, collect(DISTINCT ce.name) AS anchors
       ORDER BY d.created_at DESC`,
      { id: id.slice(0, 20) } // session IDs are UUIDs, prefix match
    )

    const decisions = result.records.map(r => {
      const d = r.get('d').properties
      return {
        id: d.id, summary: d.summary, content: d.content,
        keywords: d.keywords || [], source: d.source,
        finding_type: d.finding_type || 'decision',
        confidence: d.confidence, scope: d.scope,
        created_at: d.created_at,
        anchors: r.get('anchors').filter(Boolean),
      }
    })

    return c.json(decisions)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

app.delete('/api/decisions/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'))
  const session = await getSession()
  try {
    const result = await session.run(
      `MATCH (d:DecisionContext {id: $id}) DETACH DELETE d RETURN count(d) AS cnt`,
      { id }
    )
    const deleted = num(result.records[0]?.get('cnt'))
    return c.json({ status: deleted > 0 ? 'deleted' : 'not_found', id })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

app.put('/api/decisions/:id/approve', async (c) => {
  const id = decodeURIComponent(c.req.param('id'))
  const session = await getSession()
  try {
    await session.run(
      `MATCH (d:DecisionContext {id: $id}) SET d.confidence = 'human_approved', d.approved_at = $now`,
      { id, now: new Date().toISOString() }
    )
    return c.json({ status: 'approved', id })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  } finally {
    await session.close()
  }
})

// ── Static: sidebar.js ───────────────────────────────────

app.get('/sidebar.js', (c) => {
  const jsPath = path.resolve(__dirname, 'public', 'sidebar.js')
  const js = fs.readFileSync(jsPath, 'utf-8')
  return c.body(js, 200, { 'Content-Type': 'application/javascript; charset=utf-8' })
})

app.get('/shared.css', (c) => {
  const cssPath = path.resolve(__dirname, 'public', 'shared.css')
  const css = fs.readFileSync(cssPath, 'utf-8')
  return c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8' })
})

// ── API: Templates ──────────────────────────────────────

import { loadTemplate, listTemplates, saveTemplate, deleteTemplate, getDefaultConfig } from '../core/template-loader'

app.get('/api/templates', (c) => {
  const templates = listTemplates()
  return c.json({ templates })
})

app.get('/api/templates/default-config', (c) => {
  try {
    const config = getDefaultConfig()
    return c.json({ config })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/templates/:name', async (c) => {
  const name = c.req.param('name')
  try {
    // Load raw template file
    const rawPath = path.resolve(__dirname, '../../templates', `${name}.json`)
    let raw: any = {}
    if (fs.existsSync(rawPath)) {
      raw = JSON.parse(fs.readFileSync(rawPath, 'utf-8'))
    }
    // Load merged config
    const { config } = loadTemplate(name)
    return c.json({ raw, merged: config, name })
  } catch (e: any) {
    return c.json({ error: e.message }, 404)
  }
})

app.put('/api/templates/:name', async (c) => {
  const name = c.req.param('name')
  if (name === '_default') {
    return c.json({ error: 'Cannot overwrite _default template' }, 400)
  }
  try {
    const body = await c.req.json()
    saveTemplate(name, body)
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

app.delete('/api/templates/:name', (c) => {
  const name = c.req.param('name')
  if (name === '_default') {
    return c.json({ error: 'Cannot delete _default template' }, 400)
  }
  const ok = deleteTemplate(name)
  return c.json({ ok })
})

// ── Fallback: SPA ───────────────────────────────────────

app.get('/templates', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'templates.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/decisions', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'decisions.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/query', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'query.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/coverage', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'coverage.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/overview', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'overview.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/dependencies', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'dependencies.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/system', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'system.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/onboarding', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'onboarding.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/run', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'run.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/group', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'group.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/localize', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'localize.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/sessions', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'sessions.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/feedback', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'feedback.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/relationships', (c) => {
  const htmlPath = path.resolve(__dirname, 'public', 'relationships.html')
  const html = fs.readFileSync(htmlPath, 'utf-8')
  return c.html(html)
})

app.get('/', (c) => {
  return c.redirect('/overview')
})

app.get('*', (c) => {
  return c.redirect('/overview')
})

// ── 启动 ────────────────────────────────────────────────

const PREFERRED_PORT = parseInt(process.env.DASHBOARD_PORT ?? '3001')
const MAX_PORT_ATTEMPTS = 10

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = require('net').createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => { server.close(); resolve(true) })
    server.listen(port)
  })
}

async function findAvailablePort(start: number): Promise<number> {
  for (let port = start; port < start + MAX_PORT_ATTEMPTS; port++) {
    if (await isPortAvailable(port)) return port
  }
  throw new Error(`No available port found in range ${start}–${start + MAX_PORT_ATTEMPTS - 1}`)
}

async function main() {
  await verifyConnectivity()

  const port = await findAvailablePort(PREFERRED_PORT)
  if (port !== PREFERRED_PORT) {
    console.log(`⚠️  Port ${PREFERRED_PORT} is in use, using ${port} instead`)
  }

  serve({ fetch: app.fetch, port }, () => {
    console.log(`\n🖥️  CKG Dashboard: http://localhost:${port}\n`)
  })
}

main().catch(err => {
  console.error('Dashboard failed to start:', err.message)
  process.exit(1)
})
