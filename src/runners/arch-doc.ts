/**
 * runners/arch-doc.ts
 *
 * CLI runner: Architecture documentation generation.
 *
 * Usage:
 *   npm run arch-doc -- --repo claudecode
 *   npm run arch-doc -- --repo claudecode --dry-run --limit 1
 */

import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import { createAIProvider } from '../ai'
import { generateArchDocs } from '../ingestion/arch-doc-generation'

const args = process.argv.slice(2)
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null }
const hasFlag = (f: string) => args.includes(f)

const repoName = getArg('--repo')
const concurrency = parseInt(getArg('--concurrency') ?? '5')
const limitModules = getArg('--limit') ? parseInt(getArg('--limit')!) : undefined
const dryRun = hasFlag('--dry-run')

if (!repoName) {
  console.error('Usage: npm run arch-doc -- --repo <name> [--concurrency <n>] [--limit <n>] [--dry-run]')
  process.exit(1)
}

async function main(): Promise<void> {
  const config = loadConfig()
  const repoConfig = config.repos.find((r: any) => r.name === repoName)
  if (!repoConfig) {
    console.error(`Repo "${repoName}" not found in ckg.config.json`)
    process.exit(1)
  }

  const ai = createAIProvider(config.ai as any)

  console.log(`\n📖 Architecture Documentation Generator`)
  console.log(`   Repo: ${repoName}`)
  console.log(`   AI: ${ai.name}`)
  console.log(`   Concurrency: ${concurrency}`)
  if (limitModules) console.log(`   Limit: ${limitModules} modules`)
  if (dryRun) console.log(`   DRY RUN`)
  console.log()

  await verifyConnectivity()
  const session = await getSession()

  try {
    const result = await generateArchDocs({
      dbSession: session,
      ai,
      repo: repoName!,
      concurrency,
      limit: limitModules,
      dryRun,
      onProgress: (msg) => console.log(`  ${msg}`),
    })

    console.log('\n━━━ Results ━━━')
    console.log(`  Modules documented: ${result.moduleDocs.filter(d => d.overview).length}`)
    console.log(`  Global overview: ${result.globalOverview ? 'yes' : 'no'}`)
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
  console.error('Error:', err.message)
  process.exit(1)
})
