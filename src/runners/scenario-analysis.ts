/**
 * runners/scenario-analysis.ts
 *
 * CLI runner: Scenario analysis pipeline (submodule edges + scenario discovery).
 *
 * Usage:
 *   npm run scenario-analysis -- --repo claudecode --edges-only
 *   npm run scenario-analysis -- --repo claudecode --dry-run
 *   npm run scenario-analysis -- --repo claudecode
 */

import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import { createAIProvider } from '../ai'
import { runScenarioAnalysis } from '../ingestion/scenario-analysis'

// ── CLI args ────────────────────────────────────────────

const args = process.argv.slice(2)
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null }
const hasFlag = (f: string) => args.includes(f)

const repoName = getArg('--repo')
const edgesOnly = hasFlag('--edges-only')
const dryRun = hasFlag('--dry-run')

if (!repoName) {
  console.error('Usage: npm run scenario-analysis -- --repo <name> [--edges-only] [--dry-run]')
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

  const ai = createAIProvider(config.ai as any)

  console.log(`\n🎬 Scenario Analysis Pipeline`)
  console.log(`   Repo: ${repoName}`)
  if (!edgesOnly) console.log(`   AI: ${ai.name}`)
  if (edgesOnly) console.log(`   Mode: edges-only (no LLM)`)
  if (dryRun) console.log(`   ⚠️  DRY RUN — no graph writes / no LLM call`)
  console.log()

  await verifyConnectivity()
  const session = await getSession()

  try {
    const result = await runScenarioAnalysis({
      dbSession: session,
      ai,
      repo: repoName!,
      edgesOnly,
      dryRun,
      onProgress: (msg) => console.log(`  ${msg}`),
    })

    console.log('\n━━━ Results ━━━\n')
    console.log(`  SUB_CALLS edges: ${result.subModuleEdges}`)
    if (!edgesOnly) {
      console.log(`  Scenarios created: ${result.scenariosCreated}`)
      console.log(`  Total steps: ${result.totalSteps}`)
      console.log(`  Total flow edges: ${result.totalFlowEdges}`)
      console.log(`  Tokens: ${result.tokens.toLocaleString()}`)
    }
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
