/**
 * Test: assign utils/ root files to modules based on who imports them.
 *
 * 1. Scan all TS/TSX files for import statements
 * 2. For each utils/*.ts file, find which directories import it most
 * 3. Map those directories to existing modules (from graph)
 * 4. Show the proposed assignment
 */

import * as fs from 'fs'
import * as path from 'path'

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

// Extract relative import targets from a file
function extractImportTargets(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const targets: string[] = []
  const regex = /from\s+['"](\.[^'"]+)['"]/g
  let m
  while ((m = regex.exec(content)) !== null) {
    const importPath = m[1]
    const dir = path.dirname(filePath)
    let resolved = path.resolve(dir, importPath)
    // Try extensions
    for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (fs.existsSync(resolved + ext)) {
        resolved = resolved + ext
        break
      }
    }
    targets.push(path.relative(repoPath, resolved))
  }
  return targets
}

// Main
const allFiles = walkFiles(repoPath)
console.log(`Scanning ${allFiles.length} files for imports...\n`)

// Find all utils/ root files
const utilsRootFiles = new Set<string>()
for (const f of allFiles) {
  const rel = path.relative(repoPath, f)
  const parts = rel.split('/')
  if (parts[0] === 'utils' && parts.length === 2) {
    utilsRootFiles.add(rel)
  }
}
console.log(`Found ${utilsRootFiles.size} files directly under utils/\n`)

// Build: who imports each utils/ file?
// importedBy[utils/auth.ts] = { 'services/api': 3, 'components/permissions': 2, ... }
const importedBy = new Map<string, Map<string, number>>()

for (const f of allFiles) {
  const rel = path.relative(repoPath, f)
  const importerParts = rel.split('/')
  const importerDir = importerParts.length >= 3
    ? importerParts[0] + '/' + importerParts[1]
    : importerParts.length >= 2 ? importerParts[0] : '.'

  try {
    const targets = extractImportTargets(f)
    for (const target of targets) {
      // Normalize: remove .ts/.tsx, try to match utils root files
      let normalized = target.replace(/\.(ts|tsx)$/, '')
      // Check if this resolves to a utils root file
      for (const ext of ['.ts', '.tsx']) {
        if (utilsRootFiles.has(normalized + ext)) {
          normalized = normalized + ext
          break
        }
      }
      if (!utilsRootFiles.has(normalized)) continue

      if (!importedBy.has(normalized)) importedBy.set(normalized, new Map())
      const dirs = importedBy.get(normalized)!
      dirs.set(importerDir, (dirs.get(importerDir) || 0) + 1)
    }
  } catch {}
}

// Show results: for each utils file, top importing directories
const results: { file: string; topDir: string; topCount: number; totalImporters: number }[] = []

for (const file of [...utilsRootFiles].sort()) {
  const dirs = importedBy.get(file)
  if (!dirs || dirs.size === 0) {
    results.push({ file, topDir: '(none)', topCount: 0, totalImporters: 0 })
    continue
  }
  const sorted = [...dirs.entries()].sort((a, b) => b[1] - a[1])
  results.push({
    file: file.replace('utils/', ''),
    topDir: sorted[0][0],
    topCount: sorted[0][1],
    totalImporters: sorted.reduce((s, [, c]) => s + c, 0),
  })
}

// Group by top importing directory
const byTopDir = new Map<string, string[]>()
for (const r of results) {
  if (!byTopDir.has(r.topDir)) byTopDir.set(r.topDir, [])
  byTopDir.get(r.topDir)!.push(r.file)
}

console.log('=== utils/ files grouped by top importer directory ===\n')
const sortedDirs = [...byTopDir.entries()].sort((a, b) => b[1].length - a[1].length)
for (const [dir, files] of sortedDirs) {
  console.log(`${dir} (${files.length} files):`)
  for (const f of files.sort()) {
    const r = results.find(x => x.file === f)!
    console.log(`  ${f} (${r.topCount}/${r.totalImporters} imports)`)
  }
  console.log()
}

// Stats
const assigned = results.filter(r => r.topDir !== '(none)').length
const unassigned = results.filter(r => r.topDir === '(none)').length
console.log(`\n=== Summary ===`)
console.log(`  Assignable (has importers): ${assigned}`)
console.log(`  No importers: ${unassigned}`)
console.log(`  Top directories: ${sortedDirs.length}`)
