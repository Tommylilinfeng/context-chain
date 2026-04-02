/**
 * runners/discover-modules.ts
 *
 * CLI runner: Semantic module discovery via AST community detection + LLM reasoning.
 *
 * Usage:
 *   npm run discover-modules -- --repo claudecode
 *   npm run discover-modules -- --repo claudecode --hub-threshold 15
 *   npm run discover-modules -- --repo claudecode --dry-run
 */

import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import { createAIProvider } from '../ai'
import { discoverModules } from '../ingestion/module-discovery'

// ── CLI args ────────────────────────────────────────────

const args = process.argv.slice(2)
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null }
const hasFlag = (f: string) => args.includes(f)

const repoName = getArg('--repo')
const hubThreshold = parseInt(getArg('--hub-threshold') ?? '20')
const dryRun = hasFlag('--dry-run')

if (!repoName) {
  console.error('Usage: npm run discover-modules -- --repo <name> [--hub-threshold <n>] [--dry-run]')
  process.exit(1)
}

// ── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now()
  const config = loadConfig()
  const repoConfig = config.repos.find((r: any) => r.name === repoName)

  if (!repoConfig) {
    console.error(`Repo "${repoName}" not found in ckg.config.json`)
    process.exit(1)
  }

  const ai = createAIProvider(config.ai as any)

  console.log(`\n🔬 Semantic Module Discovery`)
  console.log(`   Repo: ${repoName}`)
  console.log(`   Hub threshold: ${hubThreshold}`)
  console.log(`   AI: ${ai.name}`)
  if (dryRun) console.log(`   ⚠️  DRY RUN — no graph writes`)
  console.log()

  await verifyConnectivity()
  const session = await getSession()

  try {
    const result = await discoverModules({
      dbSession: session,
      ai,
      repo: repoName,
      repoPath: repoConfig.path,
      hubThreshold,
      dryRun,
      onProgress: (msg) => console.log(`  ${msg}`),
    })

    // Print results
    console.log('\n━━━ Discovered Modules ━━━\n')
    for (const mod of result.modules) {
      console.log(`  ${mod.name} (${mod.functionKeys.length} fns, confidence: ${mod.confidence})`)
      console.log(`    ${mod.description}`)
      console.log()
    }

    if (result.boundaryEdits.length > 0) {
      console.log('━━━ Boundary Edits ━━━\n')
      for (const edit of result.boundaryEdits) {
        const adds = edit.addTo.length > 0 ? ` +[${edit.addTo.join(', ')}]` : ''
        const removes = edit.removeFrom.length > 0 ? ` -[${edit.removeFrom.join(', ')}]` : ''
        console.log(`  ${edit.functionKey}${adds}${removes}`)
        if (edit.reasoning) console.log(`    ${edit.reasoning}`)
      }
      console.log()
    }

    console.log('━━━ Stats ━━━')
    console.log(`  Communities detected: ${result.stats.communitiesDetected}`)
    console.log(`  Modules: ${result.stats.finalModules}`)
    console.log(`  Boundary functions reviewed: ${result.stats.boundaryFunctionsReviewed}`)
    console.log(`  Edits applied: ${result.stats.editsApplied}`)
    console.log(`  Tokens: R1=${result.stats.round1Tokens.toLocaleString()} R2=${result.stats.round2Tokens.toLocaleString()} Total=${result.stats.totalTokens.toLocaleString()}`)
    console.log(`  Duration: ${(result.stats.durationMs / 1000).toFixed(1)}s`)
    console.log()

  } finally {
    ai.cleanup()
    await session.close()
    await closeDriver()
  }
}

main().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})
