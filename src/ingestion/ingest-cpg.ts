/**
 * ingest-cpg.ts
 *
 * 读取 Joern 导出的 JSON，把 CodeEntity 节点和边写入 Memgraph。
 * 运行：npm run ingest:cpg -- --file /path/to/bite.json
 */

import fs from 'fs'
import path from 'path'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { Session } from 'neo4j-driver'

const args = process.argv.slice(2)
const fileArgIndex = args.indexOf('--file')
if (fileArgIndex === -1 || !args[fileArgIndex + 1]) {
  console.error('用法: npm run ingest:cpg -- --file /path/to/output.json')
  process.exit(1)
}
const jsonFile = path.resolve(args[fileArgIndex + 1])

interface CodeEntityNode {
  id: string
  entity_type: 'service' | 'file' | 'function'
  name: string
  repo: string
  path: string | null
  line_start?: number
  line_end?: number
}

interface CallEdge {
  caller_id: string
  callee_id: string
  callee_name: string
  line: number
}

interface CpgExport {
  repo: string
  nodes: CodeEntityNode[]
  calls: CallEdge[]
}

async function ingest(): Promise<void> {
  console.log(`\n📂 读取: ${jsonFile}`)
  const raw = fs.readFileSync(jsonFile, 'utf-8')
  const data: CpgExport = JSON.parse(raw)

  console.log(`   Repo: ${data.repo}`)
  console.log(`   节点: ${data.nodes.length}`)
  console.log(`   调用关系: ${data.calls.length}`)

  await verifyConnectivity()
  const session = await getSession()

  try {
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

    // 3. CALLS 边
    console.log('\n📞 建 CALLS 边...')
    let callCount = 0

    for (let i = 0; i < data.calls.length; i += BATCH) {
      const batch = data.calls.slice(i, i + BATCH)
      await session.run(
        `UNWIND $batch AS c
         MATCH (caller:CodeEntity {id: c.caller_id})
         MATCH (callee:CodeEntity {id: c.callee_id})
         MERGE (caller)-[r:CALLS]->(callee)
         SET r.line = c.line`,
        { batch }
      )
      callCount += batch.length
      process.stdout.write(`\r   进度: ${Math.min(callCount, data.calls.length)}/${data.calls.length}`)
    }
    console.log(`\n   ✅ CALLS 边完成`)

    await printStats(session, data.repo)

  } finally {
    await session.close()
    await closeDriver()
  }
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
