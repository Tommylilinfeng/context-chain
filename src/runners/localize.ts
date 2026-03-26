/**
 * runners/localize.ts
 *
 * CLI entry point for decision localization.
 * Usage: npm run localize -- --locale zh [--repo name] [--batch-size 20] [--force] [--dry-run]
 */

import { getSession, verifyConnectivity } from '../db/client'
import { loadConfig } from '../config'
import { createAIProvider } from '../ai'
import { localizeDecisions } from '../localization/localize-decisions'

async function main() {
  const args = process.argv.slice(2)
  const locale = getArg(args, '--locale') ?? 'zh'
  const repo = getArg(args, '--repo')
  const batchSize = parseInt(getArg(args, '--batch-size') ?? '20')
  const force = args.includes('--force')
  const dryRun = args.includes('--dry-run')

  console.log(`\n🌐 Decision Localization → ${locale}`)
  if (repo) console.log(`   Repo filter: ${repo}`)
  if (force) console.log(`   Force: re-translating all`)
  if (dryRun) console.log(`   Dry run: no DB writes`)
  console.log()

  await verifyConnectivity()
  const config = loadConfig()
  const ai = createAIProvider(config.ai)
  const session = await getSession()

  try {
    const result = await localizeDecisions(session, ai, {
      locale,
      repo: repo ?? undefined,
      batchSize,
      force,
      dryRun,
    }, {
      onBatchStart: (batch, count) => {
        console.log(`  [batch ${batch + 1}] Translating ${count} decisions...`)
      },
      onBatchDone: (batch, translated) => {
        console.log(`  [batch ${batch + 1}] Done — ${translated} translated`)
      },
      onBatchError: (batch, error) => {
        console.error(`  [batch ${batch + 1}] Error: ${error}`)
      },
      onProgress: (translated, total) => {
        console.log(`  Progress: ${translated}/${total}`)
      },
    })

    console.log(`\n✅ Localization complete`)
    console.log(`   Translated: ${result.translated}`)
    console.log(`   Failed: ${result.failed}`)
    console.log(`   Total: ${result.total}`)
    console.log(`   Duration: ${(result.durationMs / 1000).toFixed(1)}s\n`)
  } finally {
    await session.close()
  }
}

function getArg(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return null
  return args[idx + 1]
}

main().catch(err => {
  console.error('Localization failed:', err.message)
  process.exit(1)
})
