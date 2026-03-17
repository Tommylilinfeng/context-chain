/**
 * ingest-decisions.ts
 *
 * 把 cold-start-decisions.json 导入 Memgraph。
 * 运行：npm run ingest:decisions
 */

import fs from 'fs'
import path from 'path'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'

const jsonFile = path.resolve(__dirname, '../../data/cold-start-decisions.json')

interface Decision {
  id: string
  summary: string
  content: string
  keywords: string[]
  scope: string[]
  anchor_path: string
}

async function ingestDecisions(): Promise<void> {
  console.log('\n💡 导入 DecisionContext 节点...')
  const raw = fs.readFileSync(jsonFile, 'utf-8')
  const { decisions }: { decisions: Decision[] } = JSON.parse(raw)
  console.log(`   共 ${decisions.length} 条决策`)

  await verifyConnectivity()
  const session = await getSession()
  const now = new Date().toISOString()

  try {
    let written = 0
    let anchored = 0

    for (const dc of decisions) {
      // 写 DecisionContext 节点
      await session.run(
        `MERGE (d:DecisionContext {id: $id})
         SET d += $props`,
        {
          id: dc.id,
          props: {
            summary: dc.summary,
            content: dc.content,
            keywords: dc.keywords,
            scope: dc.scope,
            owner: 'me',
            session_id: 'cold-start-2026-03-17',
            commit_hash: 'cold-start',
            source: 'cold_start',
            confidence: 'auto_generated',
            staleness: 'active',
            created_at: now,
            updated_at: now,
          },
        }
      )
      written++

      // 建 ANCHORED_TO 边 —— 从 anchor_path 推算 CodeEntity id
      // anchor_path 形如 "biteme-shared/src/services/orderService.ts"
      // CodeEntity id 形如 "file:bite-me-website/biteme-shared/src/services/orderService.ts"
      const fileId = `file:bite-me-website/${dc.anchor_path}`
      const result = await session.run(
        `MATCH (d:DecisionContext {id: $dcId})
         MATCH (f:CodeEntity {id: $fileId})
         MERGE (d)-[:ANCHORED_TO]->(f)
         RETURN f.id AS matched`,
        { dcId: dc.id, fileId }
      )

      if (result.records.length > 0) {
        anchored++
        console.log(`  ✅ ${dc.summary.slice(0, 40)}`)
      } else {
        // 尝试用文件名模糊匹配
        const fileName = dc.anchor_path.split('/').pop()!
        const fuzzyResult = await session.run(
          `MATCH (d:DecisionContext {id: $dcId})
           MATCH (f:CodeEntity {entity_type: 'file', name: $name})
           MERGE (d)-[:APPROXIMATE_TO]->(f)
           RETURN f.id AS matched`,
          { dcId: dc.id, name: fileName }
        )
        if (fuzzyResult.records.length > 0) {
          anchored++
          console.log(`  ⚠ 模糊锚定: ${dc.summary.slice(0, 40)} → ${fileName}`)
        } else {
          console.log(`  ✗ 未找到锚点: ${fileId}`)
        }
      }
    }

    console.log(`\n📊 结果:`)
    console.log(`   写入 DecisionContext: ${written} 条`)
    console.log(`   成功锚定: ${anchored} 条`)

    // 验证
    const stats = await session.run(
      `MATCH (d:DecisionContext) RETURN count(d) AS total`
    )
    console.log(`   图谱中 DecisionContext 总数: ${stats.records[0].get('total')}`)

  } finally {
    await session.close()
    await closeDriver()
  }
}

ingestDecisions().catch(err => {
  console.error('导入失败:', err.message)
  process.exit(1)
})
