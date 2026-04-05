/**
 * Quick analysis: extract import relationships from TS/TSX files,
 * compute fan-in (how many files import each export), find anchor functions.
 *
 * Usage: npx tsx scripts/import-fanin.ts /path/to/repo
 */

import * as fs from 'fs'
import * as path from 'path'

const repoPath = process.argv[2] || '/Users/zhouyitong/dev/claude-code'

// Collect all TS/TSX files
function walkFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
      walkFiles(full, files)
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(full)
    }
  }
  return files
}

// Extract import targets from a file
// Returns: [{ fromFile, importPath, symbols[] }]
interface ImportInfo {
  fromFile: string      // relative path of importing file
  importPath: string    // raw import path (e.g. '../utils/cwd')
  resolvedPath: string  // resolved relative path (e.g. 'utils/cwd.ts')
  symbols: string[]     // named imports
  isDefault: boolean
}

function extractImports(filePath: string, repoRoot: string): ImportInfo[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const relFile = path.relative(repoRoot, filePath)
  const results: ImportInfo[] = []

  // Match: import { x, y } from './path'
  // Match: import X from './path'
  // Match: import * as X from './path'
  const importRegex = /import\s+(?:(\{[^}]+\})|(\w+)|(\*\s+as\s+\w+))\s+from\s+['"]([^'"]+)['"]/g
  let match
  while ((match = importRegex.exec(content)) !== null) {
    const namedBlock = match[1]   // { x, y, z }
    const defaultImport = match[2]
    const starImport = match[3]
    const importPath = match[4]

    // Only resolve relative imports (skip node_modules)
    if (!importPath.startsWith('.')) continue

    const symbols: string[] = []
    let isDefault = false

    if (namedBlock) {
      // Parse { x, y as z, type T } → ['x', 'z']
      const inner = namedBlock.slice(1, -1)
      for (const part of inner.split(',')) {
        const trimmed = part.trim()
        if (!trimmed || trimmed.startsWith('type ')) continue
        const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/)
        symbols.push(asMatch ? asMatch[1] : trimmed)
      }
    }
    if (defaultImport) {
      symbols.push(defaultImport)
      isDefault = true
    }
    if (starImport) {
      const name = starImport.replace(/\*\s+as\s+/, '')
      symbols.push(name)
    }

    // Resolve import path relative to repo root
    const dir = path.dirname(filePath)
    let resolved = path.resolve(dir, importPath)
    // Try extensions
    for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
      const candidate = resolved + ext
      if (fs.existsSync(candidate)) {
        resolved = candidate
        break
      }
    }
    const resolvedRel = path.relative(repoRoot, resolved)

    results.push({
      fromFile: relFile,
      importPath,
      resolvedPath: resolvedRel,
      symbols,
      isDefault,
    })
  }
  return results
}

// Main
const files = walkFiles(repoPath)
console.log(`Scanning ${files.length} TS/TSX files...\n`)

// Collect all imports
const allImports: ImportInfo[] = []
for (const f of files) {
  try {
    allImports.push(...extractImports(f, repoPath))
  } catch (e) {
    // skip unreadable files
  }
}

// Compute fan-in: for each (targetFile, symbol), count how many files import it
const fanIn = new Map<string, { file: string; symbol: string; importedBy: Set<string> }>()

for (const imp of allImports) {
  for (const sym of imp.symbols) {
    const key = `${imp.resolvedPath}::${sym}`
    if (!fanIn.has(key)) {
      fanIn.set(key, { file: imp.resolvedPath, symbol: sym, importedBy: new Set() })
    }
    fanIn.get(key)!.importedBy.add(imp.fromFile)
  }
}

// Sort by fan-in descending
const sorted = [...fanIn.values()].sort((a, b) => b.importedBy.size - a.importedBy.size)

// Print top 80
console.log('=== Top 80 by import fan-in ===\n')
console.log(`${'fan-in'.padStart(6)}  ${'symbol'.padEnd(45)}  file`)
console.log('-'.repeat(120))
for (const entry of sorted.slice(0, 80)) {
  console.log(
    `${String(entry.importedBy.size).padStart(6)}  ${entry.symbol.padEnd(45)}  ${entry.file}`
  )
}

// Print distribution
console.log('\n=== Fan-in distribution ===\n')
const buckets = [1, 2, 3, 5, 10, 20, 50, 100, Infinity]
for (let i = 0; i < buckets.length; i++) {
  const lo = i === 0 ? 1 : buckets[i - 1] + 1
  const hi = buckets[i]
  const count = sorted.filter(e => e.importedBy.size >= lo && e.importedBy.size <= hi).length
  if (count > 0) {
    const label = hi === Infinity ? `${lo}+` : lo === hi ? `${lo}` : `${lo}-${hi}`
    console.log(`  ${label.padStart(6)} imports: ${count} symbols`)
  }
}

// Print by directory: which directories have the most high-fan-in exports
console.log('\n=== Top directories by high-fan-in exports (fan-in ≥ 10) ===\n')
const dirMap = new Map<string, number>()
for (const entry of sorted.filter(e => e.importedBy.size >= 10)) {
  const parts = entry.file.split('/')
  const dir = parts.slice(0, Math.min(2, parts.length - 1)).join('/') || '.'
  dirMap.set(dir, (dirMap.get(dir) || 0) + 1)
}
const dirSorted = [...dirMap.entries()].sort((a, b) => b[1] - a[1])
for (const [dir, count] of dirSorted.slice(0, 20)) {
  console.log(`  ${String(count).padStart(4)}  ${dir}`)
}
