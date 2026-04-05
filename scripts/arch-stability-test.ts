/**
 * Stability test: run the SAME architecture discovery prompt 5 times concurrently,
 * compare results for consistency.
 *
 * Usage: npx tsx scripts/arch-stability-test.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { loadConfig } from '../src/config'
import { createAIProvider } from '../src/ai'

const repoPath = '/Users/zhouyitong/dev/claude-code'

function walkFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', '__tests__', 'test', 'tests'].includes(entry.name)) continue
      walkFiles(full, files)
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(full)
    }
  }
  return files
}

function extractExportNames(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const names: string[] = []
  const regex = /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|abstract\s+class|interface|type|enum)\s+(\w+)/g
  let m
  while ((m = regex.exec(content)) !== null) names.push(m[1])
  return [...new Set(names)]
}

function buildExportMap(): string {
  const files = walkFiles(repoPath)
  const grouped = new Map<string, { name: string; exports: string[] }[]>()

  for (const f of files) {
    const rel = path.relative(repoPath, f)
    const parts = rel.split('/')
    const dir = parts.length >= 3
      ? parts[0] + '/' + parts[1]
      : parts.length >= 2 ? parts[0] : '.'
    const fileName = parts[parts.length - 1]

    try {
      const exports = extractExportNames(f)
      if (exports.length === 0) continue
      if (!grouped.has(dir)) grouped.set(dir, [])
      grouped.get(dir)!.push({ name: fileName, exports })
    } catch {}
  }

  const lines: string[] = []
  const sorted = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [dir, fileList] of sorted) {
    lines.push(`[${dir}/] ${fileList.length} files`)
    for (const { name: file, exports } of fileList) {
      const shown = exports.slice(0, 12)
      const suffix = exports.length > 12 ? ` (+${exports.length - 12} more)` : ''
      lines.push(`  ${file}: ${shown.join(', ')}${suffix}`)
    }
  }
  return lines.join('\n')
}

const PROMPT_TEMPLATE = (exportMap: string) => `You are a software architect analyzing a TypeScript project called "claude-code" — an AI CLI coding assistant (~1,900 files).

Below is every directory with its files and exported symbol names.

Identify 12-20 architectural subsystems. For each:
1. Name (architectural concept, not folder name)
2. One-line description
3. Directories that belong to it
4. 3-5 key exports

Every directory must belong to at least one subsystem.

${exportMap}

Respond ONLY in JSON:
{
  "subsystems": [
    { "name": "...", "description": "...", "directories": ["..."], "keyExports": ["..."] }
  ]
}`

interface Subsystem {
  name: string
  description: string
  directories: string[]
  keyExports: string[]
}

function parseResult(raw: string): Subsystem[] {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return parsed.subsystems || []
    }
  } catch {}
  return []
}

async function main() {
  const exportMap = buildExportMap()
  const prompt = PROMPT_TEMPLATE(exportMap)
  console.log(`Prompt: ${prompt.length} chars (${Math.round(prompt.length / 4)} est. tokens)\n`)

  const config = loadConfig()
  const ai = createAIProvider(config.ai as any)
  const RUNS = 5

  console.log(`Running ${RUNS} identical calls concurrently...\n`)
  const startTime = Date.now()

  const promises = Array.from({ length: RUNS }, (_, i) =>
    ai.call(prompt, { timeoutMs: 600000 }).then(raw => {
      const tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
      console.log(`  ✓ Run ${i + 1} done (${tokens.toLocaleString()} tokens)`)
      fs.writeFileSync(`/tmp/arch-stability-${i + 1}.json`, raw)
      return parseResult(raw)
    })
  )

  const results = await Promise.all(promises)
  const elapsed = (Date.now() - startTime) / 1000
  console.log(`\nAll done in ${elapsed.toFixed(1)}s\n`)

  // ── Compare results ────────────────────────────────────

  // 1. Subsystem count
  console.log('=== Subsystem counts ===')
  for (let i = 0; i < RUNS; i++) {
    console.log(`  Run ${i + 1}: ${results[i].length} subsystems`)
  }

  // 2. Subsystem names (normalized)
  console.log('\n=== Subsystem names ===')
  const allNames: string[][] = results.map(r => r.map(s => s.name).sort())
  for (let i = 0; i < RUNS; i++) {
    console.log(`  Run ${i + 1}: ${allNames[i].join(' | ')}`)
  }

  // 3. Name overlap matrix
  console.log('\n=== Name similarity (Jaccard on lowercased words) ===')
  function nameWords(names: string[]): Set<string> {
    return new Set(names.flatMap(n => n.toLowerCase().split(/[\s&/,]+/)))
  }
  const wordSets = allNames.map(nameWords)
  for (let i = 0; i < RUNS; i++) {
    const row: string[] = []
    for (let j = 0; j < RUNS; j++) {
      const intersection = new Set([...wordSets[i]].filter(w => wordSets[j].has(w)))
      const union = new Set([...wordSets[i], ...wordSets[j]])
      const jaccard = (intersection.size / union.size * 100).toFixed(0)
      row.push(jaccard.padStart(4) + '%')
    }
    console.log(`  Run ${i + 1}: ${row.join(' ')}`)
  }

  // 4. Directory assignment consistency
  console.log('\n=== Directory assignment consistency ===')
  // For each directory, which subsystem was it assigned to in each run?
  const allDirs = new Set<string>()
  for (const r of results) {
    for (const s of r) {
      for (const d of s.directories) allDirs.add(d.replace(/\/$/, ''))
    }
  }

  let consistent = 0
  let inconsistent = 0
  const inconsistentDirs: { dir: string; assignments: string[] }[] = []

  for (const dir of [...allDirs].sort()) {
    const assignments = results.map(r => {
      const match = r.find(s => s.directories.some(d => d.replace(/\/$/, '') === dir))
      return match?.name || '(unassigned)'
    })
    // Check if all same
    const unique = [...new Set(assignments)]
    if (unique.length === 1) {
      consistent++
    } else {
      inconsistent++
      if (inconsistentDirs.length < 15) {
        inconsistentDirs.push({ dir, assignments })
      }
    }
  }

  console.log(`  ${consistent} dirs always in same subsystem`)
  console.log(`  ${inconsistent} dirs varied across runs`)
  console.log(`  Consistency: ${(consistent / (consistent + inconsistent) * 100).toFixed(1)}%`)

  if (inconsistentDirs.length > 0) {
    console.log('\n  Sample inconsistent directories:')
    for (const { dir, assignments } of inconsistentDirs) {
      console.log(`    ${dir}:`)
      for (let i = 0; i < RUNS; i++) {
        console.log(`      Run ${i + 1}: ${assignments[i]}`)
      }
    }
  }

  ai.cleanup()
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
