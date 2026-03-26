/**
 * ingest-cpg.ts
 *
 * 读取 Joern 导出的 JSON，把 CodeEntity 节点和边写入 Memgraph。
 * 同时识别跨 repo 的外部调用，保存到 data/unresolved-calls.json 供 link-repos 处理。
 *
 * 运行：npm run ingest:cpg -- --file /path/to/bite.json
 */

import fs from 'fs'
import path from 'path'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { Session } from 'neo4j-driver'
import { loadConfig, parseExternalCallee } from '../config'

const args = process.argv.slice(2)
const fileArgIndex = args.indexOf('--file')
if (fileArgIndex === -1 || !args[fileArgIndex + 1]) {
  console.error('用法: npm run ingest:cpg -- --file /path/to/output.json')
  process.exit(1)
}
const jsonFile = path.resolve(args[fileArgIndex + 1])
const UNRESOLVED_FILE = path.resolve(__dirname, '../../data/unresolved-calls.json')

interface CodeEntityNode {
  id: string
  entity_type: 'service' | 'file' | 'function'
  name: string
  repo: string
  path: string | null
  line_start?: number
  line_end?: number
  content_hash?: string
}

interface CallEdge {
  caller_id: string
  callee_id: string
  callee_name: string
  line: number
  edge_type?: string  // 默认 CALLS，也可以是 REFERENCES_TABLE 等（SQL 用）
}

interface CpgExport {
  repo: string
  nodes: CodeEntityNode[]
  calls: CallEdge[]
}

interface UnresolvedCall {
  caller_id: string
  callee_id: string
  callee_name: string
  line: number
  source_repo: string
  target_package: string
  target_function: string
}

/**
 * CPG Diff: compare new CPG with existing graph data.
 * - Functions removed → decisions marked 'code_removed'
 * - Functions with changed content_hash → decisions marked 'code_changed'
 * - Removed CodeEntity nodes get staleness='code_removed' on the node itself
 */
async function diffAndMarkDecisions(session: Session, newData: CpgExport): Promise<void> {
  const repo = newData.repo

  // Get existing function nodes for this repo from Memgraph
  const existingResult = await session.run(
    `MATCH (e:CodeEntity {repo: $repo, entity_type: 'function'})
     RETURN e.id AS id, e.content_hash AS hash`,
    { repo }
  )

  if (existingResult.records.length === 0) {
    console.log('\n📊 CPG Diff: No existing functions in graph (first ingest), skipping diff')
    return
  }

  // Build maps
  const oldFunctions = new Map<string, string>()  // id → content_hash
  for (const r of existingResult.records) {
    oldFunctions.set(r.get('id'), r.get('hash') || '')
  }

  const newFunctions = new Map<string, string>()  // id → content_hash
  for (const node of newData.nodes) {
    if (node.entity_type === 'function') {
      newFunctions.set(node.id, node.content_hash || '')
    }
  }

  // Diff
  const removedIds: string[] = []
  const changedIds: string[] = []

  for (const [id, oldHash] of oldFunctions) {
    if (!newFunctions.has(id)) {
      removedIds.push(id)
    } else {
      const newHash = newFunctions.get(id)!
      // Only compare if both hashes exist (skip if old CPG didn't have hashes)
      if (oldHash && newHash && oldHash !== newHash) {
        changedIds.push(id)
      }
    }
  }

  const addedCount = [...newFunctions.keys()].filter(id => !oldFunctions.has(id)).length

  console.log(`\n📊 CPG Diff: ${oldFunctions.size} old → ${newFunctions.size} new functions`)
  console.log(`   Added: ${addedCount} | Changed: ${changedIds.length} | Removed: ${removedIds.length}`)

  // Mark decisions anchored to removed functions
  if (removedIds.length > 0) {
    const result = await session.run(
      `UNWIND $ids AS fnId
       MATCH (d:DecisionContext)-[:ANCHORED_TO]->(e:CodeEntity {id: fnId})
       WHERE d.staleness <> 'code_removed'
       SET d.staleness = 'code_removed',
           d.staleness_reason = 'Function removed from codebase',
           d.staleness_detected_at = $now
       RETURN count(DISTINCT d) AS cnt`,
      { ids: removedIds, now: new Date().toISOString() }
    )
    const cnt = result.records[0]?.get('cnt')?.toNumber?.() ?? 0
    if (cnt > 0) console.log(`   ⚠️  ${cnt} decisions marked 'code_removed'`)

    // Also mark the CodeEntity nodes themselves
    await session.run(
      `UNWIND $ids AS fnId
       MATCH (e:CodeEntity {id: fnId})
       SET e.staleness = 'code_removed'`,
      { ids: removedIds }
    )
  }

  // Mark decisions anchored to changed functions
  if (changedIds.length > 0) {
    const result = await session.run(
      `UNWIND $ids AS fnId
       MATCH (d:DecisionContext)-[:ANCHORED_TO]->(e:CodeEntity {id: fnId})
       WHERE d.staleness = 'active'
       SET d.staleness = 'code_changed',
           d.staleness_reason = 'Function content changed since decision was extracted',
           d.staleness_detected_at = $now
       RETURN count(DISTINCT d) AS cnt`,
      { ids: changedIds, now: new Date().toISOString() }
    )
    const cnt = result.records[0]?.get('cnt')?.toNumber?.() ?? 0
    if (cnt > 0) console.log(`   ⚠️  ${cnt} decisions marked 'code_changed'`)
  }
}

async function ingest(): Promise<void> {
  console.log(`\n📂 读取: ${jsonFile}`)
  const raw = fs.readFileSync(jsonFile, 'utf-8')
  const data: CpgExport = JSON.parse(raw)

  console.log(`   Repo: ${data.repo}`)
  console.log(`   节点: ${data.nodes.length}`)
  console.log(`   调用关系: ${data.calls.length}`)

  // ── 分离内部调用和外部调用 ──────────────────────
  const internalCalls: CallEdge[] = []
  const externalCalls: UnresolvedCall[] = []

  for (const call of data.calls) {
    const parsed = parseExternalCallee(call.callee_id)
    if (parsed) {
      externalCalls.push({
        ...call,
        source_repo: data.repo,
        target_package: parsed.package,
        target_function: parsed.functionName,
      })
    } else {
      internalCalls.push(call)
    }
  }

  console.log(`   内部调用: ${internalCalls.length}`)
  console.log(`   外部调用: ${externalCalls.length}（保存到 unresolved-calls.json）`)

  await verifyConnectivity()
  const session = await getSession()

  try {
    // 0. Project 节点（如果有配置）
    await ensureProjectNode(session, data.repo)

    // 0.5 CPG Diff — detect removed/changed functions, mark decisions
    await diffAndMarkDecisions(session, data)

    // 1. Clear old code-structure edges for this repo (calls/contains may have changed)
    console.log('\n🧹 Clearing old CALLS/CONTAINS edges for repo...')
    await session.run(
      `MATCH (a:CodeEntity {repo: $repo})-[r:CALLS]->(b) DELETE r`,
      { repo: data.repo }
    )
    await session.run(
      `MATCH (a:CodeEntity {repo: $repo})-[r:CONTAINS]->(b) DELETE r`,
      { repo: data.repo }
    )
    // Also clean up service-level CONTAINS from Project
    await session.run(
      `MATCH (svc:CodeEntity {id: $svcId})<-[r:CONTAINS]-(p:Project) WITH r LIMIT 0 RETURN 1`,
      { svcId: `svc:${data.repo}` }
    ).catch(() => {}) // ignore if no Project node
    console.log('   ✓ Old edges cleared')

    // 1. Filter out built-in/external function nodes (no valid line info)
    const originalCount = data.nodes.length
    data.nodes = data.nodes.filter(n => {
      if (n.entity_type === 'function' && (n.line_start === -1 || n.line_end === -1)) return false
      return true
    })
    const filtered = originalCount - data.nodes.length
    if (filtered > 0) console.log(`\n🧹 Filtered ${filtered} built-in function nodes (no line info)`)

    // 1. 写入节点
    console.log('\n📁 写入 CodeEntity 节点...')
    const BATCH = 200
    let nodeCount = 0

    for (let i = 0; i < data.nodes.length; i += BATCH) {
      const batch = data.nodes.slice(i, i + BATCH)
      await session.run(
        `UNWIND $batch AS n
         MERGE (e:CodeEntity {id: n.id})
         SET e += n`,
        { batch }
      )
      nodeCount += batch.length
      process.stdout.write(`\r   进度: ${nodeCount}/${data.nodes.length}`)
    }
    console.log(`\n   ✅ ${nodeCount} 个节点`)

    // 2. CONTAINS 边
    console.log('\n🔗 建 CONTAINS 边...')
    await buildContainsEdges(session, data.nodes, data.repo)

    // 3. 建关系边（按 edge_type 分组）
    const edgeGroups = new Map<string, CallEdge[]>()
    for (const call of internalCalls) {
      const type = call.edge_type ?? 'CALLS'
      if (!edgeGroups.has(type)) edgeGroups.set(type, [])
      edgeGroups.get(type)!.push(call)
    }

    for (const [edgeType, calls] of edgeGroups) {
      console.log(`\n📞 建 ${edgeType} 边...`)
      let count = 0
      for (let i = 0; i < calls.length; i += BATCH) {
        const batch = calls.slice(i, i + BATCH)
        // Cypher 不支持动态边类型，需要每种类型单独跑
        await session.run(
          `UNWIND $batch AS c
           MATCH (caller:CodeEntity {id: c.caller_id})
           MATCH (callee:CodeEntity {id: c.callee_id})
           MERGE (caller)-[r:${edgeType}]->(callee)
           SET r.line = c.line`,
          { batch }
        )
        count += batch.length
        process.stdout.write(`\r   进度: ${Math.min(count, calls.length)}/${calls.length}`)
      }

      // 验证实际建了多少边（MATCH 找不到节点时会静默跳过）
      const verifyResult = await session.run(
        `MATCH (a:CodeEntity {repo: $repo})-[r:${edgeType}]->(b)
         RETURN count(r) AS actual`,
        { repo: data.repo }
      )
      const actual = verifyResult.records[0]?.get('actual')?.toNumber?.() ?? verifyResult.records[0]?.get('actual') ?? '?'
      const skipped = calls.length - (typeof actual === 'number' ? actual : 0)
      if (skipped > 0 && typeof actual === 'number') {
        console.log(`\n   ✅ ${edgeType}: 尝试 ${calls.length} 条，实际建了 ${actual} 条（${skipped} 条被跳过，callee 节点不存在）`)
      } else {
        console.log(`\n   ✅ ${edgeType}: ${actual} 条`)
      }
    }

    // 4. 保存外部调用
    if (externalCalls.length > 0) {
      saveUnresolvedCalls(externalCalls, data.repo)
    }

    await printStats(session, data.repo)

  } finally {
    await session.close()
    await closeDriver()
  }
}

/**
 * 创建 Project 节点和 Project->Service 边（如果 ckg.config.json 存在）
 */
async function ensureProjectNode(session: Session, repo: string): Promise<void> {
  try {
    const config = loadConfig()
    const projectId = `project:${config.project}`

    await session.run(
      `MERGE (p:Project {id: $id})
       SET p.name = $name`,
      { id: projectId, name: config.project }
    )

    // Project -> Service（repo 的服务节点）
    await session.run(
      `MATCH (p:Project {id: $projectId})
       MATCH (svc:CodeEntity {id: $svcId})
       MERGE (p)-[:CONTAINS]->(svc)`,
      { projectId, svcId: `svc:${repo}` }
    )

    console.log(`\n🏗️  Project: ${config.project} → ${repo}`)
  } catch {
    // 没有配置文件也不阻塞，向后兼容
  }
}

/**
 * 保存外部调用到 JSON 文件。追加模式——多个 repo 的 unresolved calls 合并在一起。
 */
function saveUnresolvedCalls(calls: UnresolvedCall[], repo: string): void {
  let existing: UnresolvedCall[] = []
  try {
    existing = JSON.parse(fs.readFileSync(UNRESOLVED_FILE, 'utf-8'))
  } catch { /* 文件不存在，从空开始 */ }

  // 去掉同一个 repo 的旧数据（重新 ingest 时覆盖）
  existing = existing.filter(c => c.source_repo !== repo)
  const merged = [...existing, ...calls]

  fs.mkdirSync(path.dirname(UNRESOLVED_FILE), { recursive: true })
  fs.writeFileSync(UNRESOLVED_FILE, JSON.stringify(merged, null, 2))
  console.log(`\n💾 ${calls.length} 条外部调用已保存到 unresolved-calls.json（总计 ${merged.length} 条）`)
}

async function buildContainsEdges(session: Session, nodes: CodeEntityNode[], repo: string): Promise<void> {
  const BATCH = 200

  // 服务 → 文件
  const files = nodes.filter(n => n.entity_type === 'file')
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH).map(f => ({ fileId: f.id, svcId: `svc:${repo}` }))
    await session.run(
      `UNWIND $batch AS item
       MATCH (svc:CodeEntity {id: item.svcId})
       MATCH (f:CodeEntity {id: item.fileId})
       MERGE (svc)-[:CONTAINS]->(f)`,
      { batch }
    )
  }
  console.log(`   ✅ 服务 → ${files.length} 个文件`)

  // 文件 → 函数
  const functions = nodes.filter(n => n.entity_type === 'function' && n.path)
  for (let i = 0; i < functions.length; i += BATCH) {
    const batch = functions.slice(i, i + BATCH).map(fn => ({
      fnId: fn.id,
      fileId: `file:${repo}/${fn.path}`
    }))
    await session.run(
      `UNWIND $batch AS item
       MATCH (f:CodeEntity {id: item.fileId})
       MATCH (fn:CodeEntity {id: item.fnId})
       MERGE (f)-[:CONTAINS]->(fn)`,
      { batch }
    )
  }
  console.log(`   ✅ 文件 → ${functions.length} 个函数`)

  // 服务 → SQL 实体（表、存储过程、触发器、枚举类型）
  const sqlTypes = ['table', 'sql_function', 'trigger', 'enum_type']
  const sqlEntities = nodes.filter(n => sqlTypes.includes(n.entity_type))
  if (sqlEntities.length > 0) {
    for (let i = 0; i < sqlEntities.length; i += BATCH) {
      const batch = sqlEntities.slice(i, i + BATCH).map(e => ({ entityId: e.id, svcId: `svc:${repo}` }))
      await session.run(
        `UNWIND $batch AS item
         MATCH (svc:CodeEntity {id: item.svcId})
         MATCH (e:CodeEntity {id: item.entityId})
         MERGE (svc)-[:CONTAINS]->(e)`,
        { batch }
      )
    }
    console.log(`   ✅ 服务 → ${sqlEntities.length} 个 SQL 实体`)
  }
}

async function printStats(session: Session, repo: string): Promise<void> {
  console.log('\n📊 图谱当前状态:')

  const nodeResult = await session.run(
    `MATCH (n:CodeEntity {repo: $repo})
     RETURN n.entity_type AS type, count(n) AS count
     ORDER BY count DESC`,
    { repo }
  )
  for (const r of nodeResult.records) {
    console.log(`   ${r.get('type')}: ${r.get('count')}`)
  }

  const edgeResult = await session.run(
    `MATCH (a:CodeEntity {repo: $repo})-[r]->()
     RETURN type(r) AS rel, count(r) AS count`,
    { repo }
  )
  for (const r of edgeResult.records) {
    console.log(`   [${r.get('rel')}]: ${r.get('count')} 条`)
  }
}

ingest().catch(err => {
  console.error('\n摄入失败:', err.message)
  process.exit(1)
})
