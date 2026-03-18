/**
 * Schema 初始化脚本
 *
 * 对应 PRD §8 数据模型
 * 运行：npm run db:schema
 *
 * 这个脚本是幂等的——重复运行不会出错
 *
 * Memgraph 3.6+: text search 是正式功能，不需要 experimental flag
 */

import { getSession, verifyConnectivity, closeDriver } from './client'
import { Session } from 'neo4j-driver'

// ─────────────────────────────────────────────
// 节点约束（保证 id 唯一）
// ─────────────────────────────────────────────

const CONSTRAINTS: string[] = [
  `CREATE CONSTRAINT ON (n:Project) ASSERT n.id IS UNIQUE`,
  `CREATE CONSTRAINT ON (n:CodeEntity) ASSERT n.id IS UNIQUE`,
  `CREATE CONSTRAINT ON (n:DecisionContext) ASSERT n.id IS UNIQUE`,
  `CREATE CONSTRAINT ON (n:AggregatedSummary) ASSERT n.id IS UNIQUE`,
]

// ─────────────────────────────────────────────
// 属性索引
// ─────────────────────────────────────────────

const INDEXES: string[] = [
  // ── CodeEntity ──────────────────────────────
  `CREATE INDEX ON :CodeEntity(repo)`,
  `CREATE INDEX ON :CodeEntity(entity_type)`,
  `CREATE INDEX ON :CodeEntity(name)`,

  // ── DecisionContext ──────────────────────────
  `CREATE INDEX ON :DecisionContext(staleness)`,
  `CREATE INDEX ON :DecisionContext(owner)`,
  `CREATE INDEX ON :DecisionContext(created_at)`,
  `CREATE INDEX ON :DecisionContext(confidence)`,

  // ── AggregatedSummary ─────────────────────────
  `CREATE INDEX ON :AggregatedSummary(scope)`,

  // ── Project ─────────────────────────────────
  `CREATE INDEX ON :Project(name)`,
]

// ─────────────────────────────────────────────
// 全文索引（Memgraph 3.6+ 原生支持）
//
// 查询方式：
//   CALL text_search.search("idx_decision", "data.summary:退款") YIELD node, score
//   CALL text_search.search_all("idx_decision", "退款") YIELD node, score
// ─────────────────────────────────────────────

const TEXT_INDEXES: string[] = [
  // DecisionContext: 索引 summary 和 content，支持全文搜索决策
  `CREATE TEXT INDEX idx_decision ON :DecisionContext(summary, content)`,

  // CodeEntity: 索引 name，支持函数名/文件名模糊搜索
  `CREATE TEXT INDEX idx_code ON :CodeEntity(name)`,
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

    console.log('\n🔍 创建全文索引...')
    for (const cypher of TEXT_INDEXES) {
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
    const label = cypher.slice(0, 70).replace(/\n/g, ' ').trim()
    console.log(`  ✓ ${label}...`)
  } catch (err: any) {
    if (
      err.message?.includes('already exists') ||
      err.message?.includes('index already exists') ||
      err.message?.includes('Unable to create')
    ) {
      const label = cypher.slice(0, 60).replace(/\n/g, ' ').trim()
      console.log(`  ⚠ 已存在，跳过: ${label}...`)
    } else {
      console.error(`  ✗ 失败: ${cypher.slice(0, 70)}`)
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
      const keys = record.keys as unknown as string[]
      const fields = keys.map(k => `${k}=${record.get(k)}`).join(', ')
      console.log(`    - ${fields}`)
    }
  } catch {
    console.log('  (无法读取索引详情，不影响功能)')
  }
}

runSchemaSetup().catch((err) => {
  console.error('Schema 初始化失败:', err)
  process.exit(1)
})
