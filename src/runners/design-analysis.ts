/**
 * runners/design-analysis.ts
 *
 * CLI runner: Design analysis pipeline (sub-modules, themes, design choices).
 *
 * Usage:
 *   npm run design-analysis -- --repo claudecode
 *   npm run design-analysis -- --repo claudecode --dry-run
 */

import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import { createAIProvider } from '../ai'
import { runDesignAnalysis, runReassignment, analyzeModuleStats, formatStatsReport, backfillOrphanFunctions } from '../ingestion/design-analysis'

// ── CLI args ────────────────────────────────────────────

const args = process.argv.slice(2)
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null }
const hasFlag = (f: string) => args.includes(f)

const repoName = getArg('--repo')
const concurrency = parseInt(getArg('--concurrency') ?? '5')
const maxLines = parseInt(getArg('--max-lines') ?? '0')
const dryRun = hasFlag('--dry-run')
const statsOnly = hasFlag('--stats')
const backfillOnly = hasFlag('--backfill')
const reassignOnly = hasFlag('--reassign')
const limitModules = getArg('--limit') ? parseInt(getArg('--limit')!) : null

if (!repoName) {
  console.error('Usage: npm run design-analysis -- --repo <name> [--stats] [--reassign] [--concurrency <n>] [--max-lines <n>] [--limit <n>] [--dry-run]')
  process.exit(1)
}

// ── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig()
  const repoConfig = config.repos.find((r: any) => r.name === repoName)

  if (!repoConfig) {
    console.error(`Repo "${repoName}" not found in ckg.config.json`)
    process.exit(1)
  }

  // ── Stats-only mode ──
  if (statsOnly) {
    await verifyConnectivity()
    const session = await getSession()
    try {
      const stats = await analyzeModuleStats(session, repoName!, repoConfig.path, (msg) => console.log(`  ${msg}`))
      console.log(formatStatsReport(stats))
    } finally {
      await session.close()
      await closeDriver()
    }
    return
  }

  // ── Backfill-only mode ──
  if (backfillOnly) {
    await verifyConnectivity()
    const session = await getSession()
    try {
      console.log(`\n🔗 Backfilling orphan functions for ${repoName}${dryRun ? ' (dry run)' : ''}...\n`)
      const result = await backfillOrphanFunctions(session, repoName!, dryRun, (msg) => console.log(msg))
      console.log(`\n✅ Done: +${result.fileLevelAdded} file-level, +${result.dirFunctionsAdded} in ${result.dirModulesCreated} dir-modules, ${result.stillOrphan} still orphan\n`)
    } finally {
      await session.close()
      await closeDriver()
    }
    return
  }

  // ── Reassign-only mode ──
  if (reassignOnly) {
    const ai = createAIProvider(config.ai as any)
    await verifyConnectivity()
    const session = await getSession()
    try {
      console.log(`\n🔄 Reassigning misassigned functions for ${repoName}${dryRun ? ' (dry run)' : ''}...\n`)
      const result = await runReassignment({
        dbSession: session, ai, repo: repoName!,
        concurrency, dryRun,
        onProgress: (msg) => console.log(`  ${msg}`),
      })
      console.log(`\n━━━ Reassignment Results ━━━`)
      console.log(`  Reassigned to sub-modules: ${result.reassigned}`)
      console.log(`  Infrastructure (removed): ${result.infrastructure}`)
      console.log(`  Tokens: ${result.tokens.toLocaleString()}`)
      console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s\n`)
    } finally {
      ai.cleanup()
      await session.close()
      await closeDriver()
    }
    return
  }

  const ai = createAIProvider(config.ai as any)

  console.log(`\n🔬 Design Analysis Pipeline`)
  console.log(`   Repo: ${repoName}`)
  console.log(`   AI: ${ai.name}`)
  console.log(`   Concurrency: ${concurrency}`)
  console.log(`   Max lines/fn: ${maxLines === 0 ? 'off (name only)' : maxLines}`)
  if (limitModules) console.log(`   Limit: ${limitModules} modules`)
  if (dryRun) console.log(`   ⚠️  DRY RUN — no graph writes`)
  console.log()

  await verifyConnectivity()
  const session = await getSession()

  try {
    let aiCallCount = 0
    const result = await runDesignAnalysis({
      dbSession: session,
      ai,
      repo: repoName!,
      repoPath: repoConfig.path,
      concurrency,
      maxLinesPerFunction: maxLines,
      dryRun,
      shouldAbort: limitModules
        ? () => ++aiCallCount > limitModules
        : undefined,
      onProgress: (msg) => console.log(`  ${msg}`),
    })
    if (limitModules && aiCallCount > limitModules) {
      console.log(`\n⚠️ Stopped after --limit ${limitModules} AI calls`)
    }

    // Print results
    console.log('\n━━━ Results ━━━\n')

    console.log('  Layer 2 — Sub-Module Decomposition')
    console.log(`    Sub-modules created: ${result.layer2.subModulesCreated}`)
    console.log(`    Misassigned flagged: ${result.layer2.misassignedCount}`)
    console.log(`    Tokens: ${result.layer2.tokens.toLocaleString()}`)

    console.log('\n  Layer 2.5 — Misassigned Reassignment')
    console.log(`    Reassigned: ${result.layer2_5.reassigned}`)
    console.log(`    Infrastructure: ${result.layer2_5.infrastructure}`)
    console.log(`    Tokens: ${result.layer2_5.tokens.toLocaleString()}`)

    console.log('\n━━━ Totals ━━━')
    console.log(`  Total tokens: ${result.totalTokens.toLocaleString()}`)
    console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`)
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
