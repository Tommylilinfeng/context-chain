/**
 * runners/discover-modules.ts
 *
 * CLI runner: Export-based architecture discovery.
 *
 * Usage:
 *   npm run discover-modules -- --repo claudecode
 *   npm run discover-modules -- --repo claudecode --dry-run
 *   npm run discover-modules -- --repo claudecode --chunks 5 --concurrency 5
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
const numChunks = getArg('--chunks') ? parseInt(getArg('--chunks')!) : 5
const concurrency = getArg('--concurrency') ? parseInt(getArg('--concurrency')!) : 5
const dryRun = hasFlag('--dry-run')

if (!repoName) {
  console.error('Usage: npm run discover-modules -- --repo <name> [--chunks <n>] [--concurrency <n>] [--dry-run]')
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

  console.log(`\n🔬 Export-based Architecture Discovery`)
  console.log(`   Repo: ${repoName}`)
  console.log(`   Path: ${repoConfig.path}`)
  console.log(`   Chunks: ${numChunks}, Concurrency: ${concurrency}`)
  console.log(`   AI: ${ai.name}`)
  if (dryRun) console.log(`   ⚠️  DRY RUN — no graph writes`)
  console.log()

  await verifyConnectivity()
  const session = await getSession()

  try {
    const result = await discoverModules({
      dbSession: session,
      ai,
      repo: repoName!,
      repoPath: repoConfig.path,
      numChunks,
      concurrency,
      dryRun,
      onProgress: (msg) => console.log(`  ${msg}`),
    })

    // Print results
    console.log('\n━━━ Discovered Modules ━━━\n')
    for (const mod of result.modules) {
      console.log(`  ■ ${mod.name} [${mod.moduleId}]`)
      console.log(`    ${mod.description}`)
      console.log(`    Dirs: ${mod.directories.join(', ')}`)
      console.log(`    Key: ${mod.keyExports.join(', ')}`)
      console.log()
    }

    console.log('━━━ Stats ━━━')
    console.log(`  Files scanned: ${result.stats.totalFiles}`)
    console.log(`  Exports found: ${result.stats.totalExports}`)
    console.log(`  Directories: ${result.stats.totalDirs}`)
    console.log(`  Modules: ${result.stats.modulesDiscovered}`)
    console.log(`  Tokens: P1=${result.stats.phase1Tokens.toLocaleString()} P2=${result.stats.phase2Tokens.toLocaleString()} Total=${result.stats.totalTokens.toLocaleString()}`)
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
