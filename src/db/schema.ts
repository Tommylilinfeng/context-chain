/**
 * Schema initialization script
 *
 * Corresponds to PRD §8 数据模型
 * Run:npm run db:schema
 *
 * This script is idempotent — safe to re-run
 *
 * Memgraph 3.6+: text search 是正式功能，不需要 experimental flag
 */

import { getSession, verifyConnectivity, closeDriver } from './client'
import { Session } from 'neo4j-driver'

// ─────────────────────────────────────────────
// Node constraints (ensure unique id)
// ─────────────────────────────────────────────

const CONSTRAINTS: string[] = [
  `CREATE CONSTRAINT ON (n:Project) ASSERT n.id IS UNIQUE`,
  `CREATE CONSTRAINT ON (n:CodeEntity) ASSERT n.id IS UNIQUE`,
  `CREATE CONSTRAINT ON (n:DecisionContext) ASSERT n.id IS UNIQUE`,
  `CREATE CONSTRAINT ON (n:AggregatedSummary) ASSERT n.id IS UNIQUE`,
  `CREATE CONSTRAINT ON (n:SubModule) ASSERT n.id IS UNIQUE`,
  `CREATE CONSTRAINT ON (n:DesignChoice) ASSERT n.id IS UNIQUE`,
  `CREATE CONSTRAINT ON (n:Theme) ASSERT n.id IS UNIQUE`,
]

// ─────────────────────────────────────────────
// Property indexes
// ─────────────────────────────────────────────

const INDEXES: string[] = [
  // ── CodeEntity ──────────────────────────────
  `CREATE INDEX ON :CodeEntity(repo)`,
  `CREATE INDEX ON :CodeEntity(entity_type)`,
  `CREATE INDEX ON :CodeEntity(name)`,
  `CREATE INDEX ON :CodeEntity(path)`,   // P0: path-based lookups (avoids index.ts collision)

  // ── DecisionContext ──────────────────────────
  `CREATE INDEX ON :DecisionContext(staleness)`,
  `CREATE INDEX ON :DecisionContext(owner)`,
  `CREATE INDEX ON :DecisionContext(created_at)`,
  `CREATE INDEX ON :DecisionContext(confidence)`,
  `CREATE INDEX ON :DecisionContext(finding_type)`,

  // ── AggregatedSummary ─────────────────────────
  `CREATE INDEX ON :AggregatedSummary(scope)`,

  // ── Project ─────────────────────────────────
  `CREATE INDEX ON :Project(name)`,

  // ── SubModule ───────────────────────────────
  `CREATE INDEX ON :SubModule(repo)`,
  `CREATE INDEX ON :SubModule(parentModuleId)`,

  // ── DesignChoice ────────────────────────────
  `CREATE INDEX ON :DesignChoice(repo)`,

  // ── Theme ───────────────────────────────────
  `CREATE INDEX ON :Theme(repo)`,
  `CREATE INDEX ON :Theme(scope)`,
]

// ─────────────────────────────────────────────
// Full-text indexes（Memgraph 3.6+ 原生支持）
//
// Query examples：
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
// Execute
// ─────────────────────────────────────────────

async function runSchemaSetup(): Promise<void> {
  await verifyConnectivity()
  const session = await getSession()

  try {
    console.log('\n📐 Creating node constraints...')
    for (const cypher of CONSTRAINTS) {
      await runSafe(session, cypher)
    }

    console.log('\n📑 Creating indexes...')
    for (const cypher of INDEXES) {
      await runSafe(session, cypher)
    }

    console.log('\n🔍 创建Full-text indexes...')
    for (const cypher of TEXT_INDEXES) {
      await runSafe(session, cypher)
    }

    console.log('\n✅ Schema initialization complete\n')
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
      console.log(`  ⚠ Already exists, skipping: ${label}...`)
    } else {
      console.error(`  ✗ 失败: ${cypher.slice(0, 70)}`)
      console.error(`    ${err.message}`)
    }
  }
}

async function printSchemaStats(session: Session): Promise<void> {
  console.log('📊 Current schema status:')
  try {
    const result = await session.run('SHOW INDEX INFO')
    console.log(`  Index count: ${result.records.length}`)
    for (const record of result.records) {
      const keys = record.keys as unknown as string[]
      const fields = keys.map(k => `${k}=${record.get(k)}`).join(', ')
      console.log(`    - ${fields}`)
    }
  } catch {
    console.log('  (Cannot read index details, does not affect functionality)')
  }
}

runSchemaSetup().catch((err) => {
  console.error('Schema 初始化失败:', err)
  process.exit(1)
})
