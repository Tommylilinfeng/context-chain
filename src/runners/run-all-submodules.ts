/**
 * runners/run-all-submodules.ts
 *
 * Run sub-module discovery on ALL modules.
 *
 * Usage:
 *   npx ts-node src/runners/run-all-submodules.ts
 *   npx ts-node src/runners/run-all-submodules.ts --dry-run
 */

import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import { createAIProvider } from '../ai'
import { discoverSubModules } from '../ingestion/submodule-discovery'
import { NOISE_FILTER } from '../ingestion/noise-filter'
import { toNum } from '../ingestion/shared'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

async function main(): Promise<void> {
  const config = loadConfig()
  const repoConfig = config.repos.find((r: any) => r.name === 'claudecode')
  if (!repoConfig) { console.error('Repo "claudecode" not found'); process.exit(1) }

  const ai = createAIProvider(config.ai as any)
  await verifyConnectivity()
  const session = await getSession()

  // Get all modules with signal functions
  const modRes = await session.run(`
    MATCH (sm:SemanticModule {repo: "claudecode"})
    OPTIONAL MATCH (fn:CodeEntity {entity_type: 'function'})-[:BELONGS_TO]->(sm)
    WHERE ${NOISE_FILTER}
    WITH sm.id AS id, sm.name AS name, count(fn) AS cnt
    WHERE cnt > 0
    RETURN id, name, cnt ORDER BY cnt DESC
  `)
  const allModules = modRes.records.map(r => ({
    id: r.get('id') as string,
    name: r.get('name') as string,
    fns: toNum(r.get('cnt')),
  }))

  console.log(`\n🔬 Full Sub-Module Discovery`)
  console.log(`   Modules: ${allModules.length}`)
  console.log(`   AI: ${ai.name}`)
  if (dryRun) console.log(`   ⚠️  DRY RUN`)
  console.log()

  try {
    const results = await discoverSubModules({
      dbSession: session,
      ai,
      repo: 'claudecode',
      repoPath: repoConfig.path,
      moduleIds: allModules.map(m => m.id),
      concurrency: 3,
      dryRun,
      onProgress: (msg) => console.log(msg),
    })

    // Summary
    console.log('\n\n━━━ SUMMARY ━━━\n')
    let totalSubs = 0
    let totalTokens = 0
    let totalDuration = 0
    for (const r of results) {
      totalSubs += r.subModules.length
      totalTokens += r.stats.tokens
      totalDuration += r.stats.durationMs
      const subList = r.subModules.map(s => `${s.name}(${s.fileIndices.length})`).join(', ')
      console.log(`  ${r.moduleName} → ${r.subModules.length} subs: ${subList}`)
    }
    console.log(`\n  Total: ${totalSubs} sub-modules, ${totalTokens.toLocaleString()} tokens, ${(totalDuration / 1000).toFixed(0)}s`)

  } finally {
    ai.cleanup()
    await session.close()
    await closeDriver()
  }
}

main().catch(err => { console.error('❌', err.message); process.exit(1) })
