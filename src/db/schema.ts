/**
 * Schema 初始化脚本
 *
 * 对应 PRD §8 数据模型
 * 运行：npm run db:schema
 *
 * 这个脚本是幂等的——重复运行不会出错
 *
 * 注：全文索引（slot2 关键词检索）暂时跳过。
 * Memgraph 2.18 的 text-search 是 experimental feature，
 * 在 Mac Docker 环境下会导致容器崩溃。
 * 替代方案：keywords 字段用数组存储，查询时用 ANY() 做精确匹配，
 * 后续如果需要模糊搜索再引入 Meilisearch。
 */

import { getSession, verifyConnectivity, closeDriver } from './client'
import { Session } from 'neo4j-driver'

// ─────────────────────────────────────────────
// 节点约束（保证 id 唯一）
// ─────────────────────────────────────────────

const CONSTRAINTS: string[] = [
  `CREATE CONSTRAINT ON (n:CodeEntity) ASSERT n.id IS UNIQUE`,
  `CREATE CONSTRAINT ON (n:DecisionContext) ASSERT n.id IS UNIQUE`,
  `CREATE CONSTRAINT ON (n:AggregatedSummary) ASSERT n.id IS UNIQUE`,
]

// ─────────────────────────────────────────────
// 索引（加速检索）
// ─────────────────────────────────────────────

const INDEXES: string[] = [
  // ── CodeEntity ──────────────────────────────
  `CREATE INDEX ON :CodeEntity(repo)`,
  `CREATE INDEX ON :CodeEntity(entity_type)`,  // function | file | directory | service | api_endpoint
  `CREATE INDEX ON :CodeEntity(name)`,

  // ── DecisionContext ──────────────────────────
  `CREATE INDEX ON :DecisionContext(staleness)`,  // active | stale | archived
  `CREATE INDEX ON :DecisionContext(owner)`,
  `CREATE INDEX ON :DecisionContext(created_at)`,
  `CREATE INDEX ON :DecisionContext(confidence)`, // 内部用：后台精炼管线筛选

  // ── AggregatedSummary ─────────────────────────
  `CREATE INDEX ON :AggregatedSummary(scope)`,
]

// ─────────────────────────────────────────────
// 执行
// ─────────────────────────────────────────────

async function runSchemaSetup(): Promise<void> {
  await verifyConnectivity()
  const session = await getSession()

  try {
    console.log('\n📐 创建节点约束...')
    for (const cypher of CONSTRAINTS) {
      await runSafe(session, cypher)
    }

    console.log('\n📑 创建索引...')
    for (const cypher of INDEXES) {
      await runSafe(session, cypher)
    }

    console.log('\n✅ Schema 初始化完成\n')
    await printSchemaStats(session)
  } finally {
    await session.close()
    await closeDriver()
  }
}

async function runSafe(session: Session, cypher: string): Promise<void> {
  try {
    await session.run(cypher)
    const label = cypher.slice(0, 60).replace(/\n/g, ' ').trim()
    console.log(`  ✓ ${label}...`)
  } catch (err: any) {
    if (
      err.message?.includes('already exists') ||
      err.message?.includes('index already exists') ||
      err.message?.includes('Unable to create')
    ) {
      const label = cypher.slice(0, 50).replace(/\n/g, ' ').trim()
      console.log(`  ⚠ 已存在，跳过: ${label}...`)
    } else {
      console.error(`  ✗ 失败: ${cypher.slice(0, 60)}`)
      console.error(`    ${err.message}`)
    }
  }
}

async function printSchemaStats(session: Session): Promise<void> {
  console.log('📊 当前 Schema 状态:')
  try {
    const result = await session.run('SHOW INDEX INFO')
    console.log(`  索引数量: ${result.records.length}`)
    for (const record of result.records) {
      const label = record.get('label') || record.get('Label') || ''
      const prop = record.get('property') || record.get('Property') || ''
      console.log(`    - :${label}(${prop})`)
    }
  } catch {
    // 不同版本语法可能不同，不影响主流程
  }
}

runSchemaSetup().catch((err) => {
  console.error('Schema 初始化失败:', err)
  process.exit(1)
})
