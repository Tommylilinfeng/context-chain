/**
 * runners/connect.ts
 *
 * Standalone runner: keyword normalization + decision relationship connection.
 *
 * Processes all PENDING_COMPARISON edges in the graph.
 * Can run standalone or as a final step of any pipeline.
 *
 * 用法：
 *   npm run connect                          → normalize + connect
 *   npm run connect -- --skip-normalize      → connect only
 *   npm run connect -- --budget 200000       → with budget limit
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
const batchSize = parseInt(getArg('--batch-size') ?? '200')
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
    // 先显示Current status
    const status = await getPendingStatus(session)
    console.log(`\n📊 Current status: ${status.totalPendingEdges}  PENDING edges, ${status.decisionsWithPending}  decisions pending connection`)

    if (status.totalPendingEdges === 0 && !skipNormalize) {
      console.log(`   No PENDING edges found.`)
      if (!skipNormalize) {
        console.log(`   Still running keyword normalization...`)
        const normResult = await normalizeKeywords(session, ai)
        if (budget) budget.record(ai.lastUsage)
        console.log(`\n✅ Done`)
      }
      return
    }

    // 1. Keyword normalization (before connecting)
    if (!skipNormalize) {
      const normResult = await normalizeKeywords(session, ai)
      if (budget) budget.record(ai.lastUsage)
    }

    // 2. Process PENDING edges
    const result = await connectDecisions({
      dbSession: session,
      ai,
      budget,
      batchCapacity: batchSize,
      concurrency,
    })

    // 3. Final status
    const finalStatus = await getPendingStatus(session)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

    console.log(`\n✅ Done (${elapsed}s)`)
    console.log(`   ${result.batchesRun}  batches, ${result.edgesCreated}  relationship edges, ${result.pendingProcessed}  PENDING processed`)
    if (finalStatus.totalPendingEdges > 0) {
      console.log(`   ⚠️ Remaining: ${finalStatus.totalPendingEdges}  PENDING edges待处理`)
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
  console.error('❌ Failed:', err.message)
  closeDriver()
  process.exit(1)
})
