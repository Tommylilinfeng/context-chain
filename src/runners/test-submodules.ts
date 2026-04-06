/**
 * runners/test-submodules.ts
 *
 * Test runner: sub-module discovery on Foundation + one other module.
 *
 * Usage:
 *   npx ts-node src/runners/test-submodules.ts
 *   npx ts-node src/runners/test-submodules.ts --dry-run
 */

import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import { createAIProvider } from '../ai'
import { discoverSubModules } from '../ingestion/submodule-discovery'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

async function main(): Promise<void> {
  const config = loadConfig()
  const repoConfig = config.repos.find((r: any) => r.name === 'claudecode')
  if (!repoConfig) { console.error('Repo "claudecode" not found'); process.exit(1) }

  const ai = createAIProvider(config.ai as any)

  console.log(`\n🔬 Sub-Module Discovery Test`)
  console.log(`   Modules: foundation, tool_framework`)
  console.log(`   AI: ${ai.name}`)
  if (dryRun) console.log(`   ⚠️  DRY RUN`)
  console.log()

  await verifyConnectivity()
  const session = await getSession()

  try {
    const results = await discoverSubModules({
      dbSession: session,
      ai,
      repo: 'claudecode',
      repoPath: repoConfig.path,
      moduleIds: ['foundation', 'tool_framework'],
      concurrency: 2,
      dryRun,
      onProgress: (msg) => console.log(msg),
    })

    for (const r of results) {
      console.log(`\n━━━ ${r.moduleName} [${r.moduleId}] ━━━`)
      console.log(`  Files: ${r.stats.totalFiles}, Exports: ${r.stats.totalExports}`)
      console.log(`  Sub-modules: ${r.subModules.length}`)
      console.log(`  Tokens: ${r.stats.tokens.toLocaleString()}`)
      console.log(`  Duration: ${(r.stats.durationMs / 1000).toFixed(1)}s\n`)

      for (const sm of r.subModules) {
        console.log(`  ■ ${sm.name} [${sm.subModuleId}] — ${sm.fileIndices.length} files`)
        console.log(`    ${sm.description}`)
        console.log(`    Key: ${sm.keyExports.join(', ')}`)
      }
    }
  } finally {
    ai.cleanup()
    await session.close()
    await closeDriver()
  }
}

main().catch(err => { console.error('❌', err.message); process.exit(1) })
