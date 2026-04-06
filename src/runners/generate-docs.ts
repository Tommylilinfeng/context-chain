/**
 * runners/generate-docs.ts
 *
 * Generate technical documentation from module graph.
 *
 * Usage:
 *   npx ts-node src/runners/generate-docs.ts --repo claudecode --module foundation --module memory_system
 *   npx ts-node src/runners/generate-docs.ts --repo claudecode --module tool_framework
 */

import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { loadConfig } from '../config'
import { createAIProvider } from '../ai'
import { generateDocs } from '../ingestion/doc-generation'

const args = process.argv.slice(2)
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null }

// Collect all --module flags
const moduleIds: string[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--module' && args[i + 1]) moduleIds.push(args[i + 1])
}

const repoName = getArg('--repo')
const concurrency = parseInt(getArg('--concurrency') ?? '3')

if (!repoName || moduleIds.length === 0) {
  console.error('Usage: npx ts-node src/runners/generate-docs.ts --repo <name> --module <id> [--module <id2>] [--concurrency <n>]')
  process.exit(1)
}

async function main(): Promise<void> {
  const config = loadConfig()
  const repoConfig = config.repos.find((r: any) => r.name === repoName)
  if (!repoConfig) { console.error(`Repo "${repoName}" not found`); process.exit(1) }

  const ai = createAIProvider(config.ai as any)
  const outputDir = `data/docs/${repoName}`

  console.log(`\n📝 Documentation Generation (source-level)`)
  console.log(`   Repo: ${repoName}`)
  console.log(`   Modules: ${moduleIds.join(', ')}`)
  console.log(`   Concurrency: ${concurrency}`)
  console.log(`   Output: ${outputDir}/`)
  console.log(`   AI: ${ai.name}`)
  console.log()

  await verifyConnectivity()
  const session = await getSession()

  try {
    const results = await generateDocs({
      dbSession: session,
      ai,
      repo: repoName!,
      repoPath: repoConfig.path,
      outputDir,
      moduleIds,
      concurrency,
      onProgress: (msg) => console.log(msg),
    })

    console.log('\n━━━ Results ━━━')
    for (const r of results) {
      console.log(`  ${r.moduleName}: ${r.subModuleDocs} sub-module docs + synthesis`)
      console.log(`    Tokens: ${r.tokens.toLocaleString()}, Duration: ${(r.durationMs / 1000).toFixed(0)}s`)
    }
    const totalTokens = results.reduce((s, r) => s + r.tokens, 0)
    console.log(`\n  Total: ${totalTokens.toLocaleString()} tokens`)
    console.log(`  Output: ${outputDir}/`)
    console.log()
  } finally {
    ai.cleanup()
    await session.close()
    await closeDriver()
  }
}

main().catch(err => { console.error('❌', err.message); process.exit(1) })
