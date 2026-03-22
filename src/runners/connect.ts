/**
 * runners/connect.ts
 *
 * 独立运行器：关键词归一化 + 决策关系连接。
 *
 * 消化图谱中所有 PENDING_COMPARISON 边。
 * 可独立跑，也可被 cold-start、session ingestion 等 pipeline 在最后一步调用。
 *
 * 用法：
 *   npm run connect                          → 归一化 + 连接
 *   npm run connect -- --skip-normalize      → 只连接
 *   npm run connect -- --budget 200000       → 带预算限制
 *   npm run connect -- --batch-size 40       → 每 batch 40 个决策
 */

import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import { createAIProvider } from '../ai'
import { parseBudget } from '../ai/budget'
import { normalizeKeywords } from '../ingestion/normalize-keywords'
import { connectDecisions, getPendingStatus } from '../ingestion/connect-decisions'

// ── CLI ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null }

const skipNormalize = args.includes('--skip-normalize')
const budgetStr = getArg('--budget')
const batchSize = parseInt(getArg('--batch-size') ?? '50')
const concurrency = parseInt(getArg('--concurrency') ?? '2')

// ── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now()
  const config = loadConfig()
  const ai = createAIProvider(config.ai)
  const budget = parseBudget(budgetStr, ai.rateLimit)

  console.log(`\n🔗 Connect Decisions`)
  console.log(`   AI: ${ai.name}`)
  if (budget) console.log(`   Budget: ${budget.summary()}`)
  console.log(`   Batch size: ${batchSize}`)
  if (skipNormalize) console.log(`   Skipping keyword normalization`)

  await verifyConnectivity()
  const session = await getSession()

  try {
    // 先显示当前状态
    const status = await getPendingStatus(session)
    console.log(`\n📊 当前状态: ${status.totalPendingEdges} 条 PENDING 边, ${status.decisionsWithPending} 个决策待连接`)

    if (status.totalPendingEdges === 0 && !skipNormalize) {
      console.log(`   没有 PENDING 边。`)
      if (!skipNormalize) {
        console.log(`   仍然运行关键词归一化...`)
        const normResult = await normalizeKeywords(session, ai)
        if (budget) budget.record(ai.lastUsage)
        console.log(`\n✅ 完成`)
      }
      return
    }

    // 1. 关键词归一化（在连接之前）
    if (!skipNormalize) {
      const normResult = await normalizeKeywords(session, ai)
      if (budget) budget.record(ai.lastUsage)
    }

    // 2. 消化 PENDING 边
    const result = await connectDecisions({
      dbSession: session,
      ai,
      budget,
      batchCapacity: batchSize,
      concurrency,
    })

    // 3. 最终状态
    const finalStatus = await getPendingStatus(session)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

    console.log(`\n✅ 完成 (${elapsed}s)`)
    console.log(`   ${result.batchesRun} 个批次, ${result.edgesCreated} 条关系边, ${result.pendingProcessed} 条 PENDING 已消化`)
    if (finalStatus.totalPendingEdges > 0) {
      console.log(`   ⚠️ 还剩 ${finalStatus.totalPendingEdges} 条 PENDING 边待处理`)
    }

    const { totalUsage } = ai
    console.log(`   📊 Token: input ${totalUsage.input_tokens.toLocaleString()} + output ${totalUsage.output_tokens.toLocaleString()}`)
    if (budget) console.log(`   📊 预算: ${budget.summary()}`)
    console.log()

  } finally {
    await session.close()
    await closeDriver()
  }
}

main().catch(err => {
  console.error('❌ 失败:', err.message)
  closeDriver()
  process.exit(1)
})
