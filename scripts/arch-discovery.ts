/**
 * Architecture discovery: split export map into chunks,
 * send to LLM concurrently (5 parallel calls), then merge.
 *
 * Usage: npx tsx scripts/arch-discovery.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { loadConfig } from '../src/config'
import { createAIProvider } from '../src/ai'

const repoPath = '/Users/zhouyitong/dev/claude-code'

// ── Extract exports ──────────────────────────────────────

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

interface DirGroup {
  dir: string
  files: { name: string; exports: string[] }[]
}

function buildDirGroups(): DirGroup[] {
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

  return [...grouped.entries()]
    .map(([dir, files]) => ({ dir, files }))
    .sort((a, b) => a.dir.localeCompare(b.dir))
}

function formatChunk(groups: DirGroup[]): string {
  const lines: string[] = []
  for (const g of groups) {
    lines.push(`[${g.dir}/] ${g.files.length} files`)
    for (const f of g.files) {
      const shown = f.exports.slice(0, 12)
      const suffix = f.exports.length > 12 ? ` (+${f.exports.length - 12} more)` : ''
      lines.push(`  ${f.name}: ${shown.join(', ')}${suffix}`)
    }
  }
  return lines.join('\n')
}

// ── Split into N chunks ──────────────────────────────────

function splitIntoChunks(groups: DirGroup[], n: number): DirGroup[][] {
  // Balance by total export count
  const totalExports = groups.reduce((s, g) => s + g.files.reduce((s2, f) => s2 + f.exports.length, 0), 0)
  const targetPerChunk = Math.ceil(totalExports / n)

  const chunks: DirGroup[][] = []
  let current: DirGroup[] = []
  let currentSize = 0

  for (const g of groups) {
    const gSize = g.files.reduce((s, f) => s + f.exports.length, 0)
    current.push(g)
    currentSize += gSize
    if (currentSize >= targetPerChunk && chunks.length < n - 1) {
      chunks.push(current)
      current = []
      currentSize = 0
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

// ── Prompts ──────────────────────────────────────────────

function buildChunkPrompt(chunk: DirGroup[], chunkIndex: number, totalChunks: number, allDirSummary: string): string {
  return `You are analyzing part ${chunkIndex + 1}/${totalChunks} of a TypeScript project called "claude-code" — an AI CLI coding assistant (~1,900 files).

Here is the FULL directory overview (all parts):
${allDirSummary}

Here are the DETAILED exports for YOUR part:
${formatChunk(chunk)}

Identify architectural subsystems visible in YOUR part. For each:
1. Name (concise, architectural — e.g. "Permission System" not "permissions folder")
2. One-line description of its responsibility
3. Which directories from your part belong to it
4. 3-5 key exports that define this subsystem's public interface
5. If it likely connects to directories in OTHER parts, note which

Respond in JSON:
{
  "subsystems": [
    {
      "name": "...",
      "description": "...",
      "directories": ["..."],
      "keyExports": ["..."],
      "crossReferences": ["likely connects to X/ because ..."]
    }
  ]
}`
}

function buildMergePrompt(chunkResults: string[]): string {
  return `You analyzed a TypeScript project "claude-code" (AI CLI assistant, ~1,900 files) in ${chunkResults.length} parts. Below are the subsystems identified from each part.

Your task: merge these into a final unified architecture. Rules:
- Merge duplicates (same subsystem found in different parts)
- Keep 12-20 final subsystems
- Every directory must belong to at least one subsystem
- Name subsystems by architectural concept, not by folder name

${chunkResults.map((r, i) => `=== Part ${i + 1} ===\n${r}`).join('\n\n')}

Respond in JSON:
{
  "subsystems": [
    {
      "name": "...",
      "description": "...",
      "directories": ["..."],
      "keyExports": ["..."],
      "reasoning": "..."
    }
  ]
}`
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  const groups = buildDirGroups()
  const totalExports = groups.reduce((s, g) => s + g.files.reduce((s2, f) => s2 + f.exports.length, 0), 0)
  console.log(`${groups.length} directories, ${totalExports} total exports\n`)

  // Directory summary for context in each chunk
  const allDirSummary = groups.map(g => {
    const exportCount = g.files.reduce((s, f) => s + f.exports.length, 0)
    return `${g.dir}/ (${g.files.length} files, ${exportCount} exports)`
  }).join('\n')

  const CONCURRENCY = 5
  const chunks = splitIntoChunks(groups, CONCURRENCY)

  console.log(`Split into ${chunks.length} chunks:`)
  for (let i = 0; i < chunks.length; i++) {
    const dirs = chunks[i].length
    const exports = chunks[i].reduce((s, g) => s + g.files.reduce((s2, f) => s2 + f.exports.length, 0), 0)
    const prompt = buildChunkPrompt(chunks[i], i, chunks.length, allDirSummary)
    console.log(`  Chunk ${i + 1}: ${dirs} dirs, ${exports} exports, prompt ${prompt.length} chars`)
  }
  console.log()

  const config = loadConfig()
  const ai = createAIProvider(config.ai as any)

  // Phase 1: Concurrent chunk analysis
  console.log(`Phase 1: Analyzing ${chunks.length} chunks concurrently...`)
  const startTime = Date.now()

  const chunkPromises = chunks.map((chunk, i) => {
    const prompt = buildChunkPrompt(chunk, i, chunks.length, allDirSummary)
    return ai.call(prompt, { timeoutMs: 300000 }).then(result => {
      const tokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
      console.log(`  ✓ Chunk ${i + 1} done (${tokens.toLocaleString()} tokens)`)
      return result
    })
  })

  const chunkResults = await Promise.all(chunkPromises)
  const phase1Time = Date.now() - startTime
  console.log(`Phase 1 done in ${(phase1Time / 1000).toFixed(1)}s\n`)

  // Save chunk results
  for (let i = 0; i < chunkResults.length; i++) {
    fs.writeFileSync(`/tmp/arch-chunk-${i + 1}.json`, chunkResults[i])
  }

  // Phase 2: Merge
  console.log('Phase 2: Merging subsystems...')
  const mergePrompt = buildMergePrompt(chunkResults)
  console.log(`  Merge prompt: ${mergePrompt.length} chars`)
  const mergeResult = await ai.call(mergePrompt, { timeoutMs: 300000 })
  const mergeTokens = (ai.lastUsage?.input_tokens ?? 0) + (ai.lastUsage?.output_tokens ?? 0)
  console.log(`  ✓ Merge done (${mergeTokens.toLocaleString()} tokens)\n`)

  fs.writeFileSync('/tmp/arch-discovery-result.json', mergeResult)

  // Pretty print
  try {
    const jsonMatch = mergeResult.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      console.log(`\n${'='.repeat(60)}`)
      console.log(`ARCHITECTURE: ${parsed.subsystems?.length} subsystems`)
      console.log(`${'='.repeat(60)}\n`)
      for (const s of parsed.subsystems || []) {
        console.log(`■ ${s.name}`)
        console.log(`  ${s.description}`)
        console.log(`  Dirs: ${s.directories?.join(', ')}`)
        console.log(`  Key exports: ${s.keyExports?.join(', ')}`)
        if (s.reasoning) console.log(`  Why: ${s.reasoning}`)
        console.log()
      }
    }
  } catch (e) {
    console.log('Could not parse merged JSON, see /tmp/arch-discovery-result.json')
  }

  const totalTime = Date.now() - startTime
  console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`)
  ai.cleanup()
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
