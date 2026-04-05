/**
 * Extract directory tree + export signatures from a TS/TSX project.
 * Output: compact representation suitable for LLM architectural analysis.
 *
 * Usage: npx tsx scripts/extract-exports.ts /path/to/repo
 */

import * as fs from 'fs'
import * as path from 'path'

const repoPath = process.argv[2] || '/Users/zhouyitong/dev/claude-code'

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

interface FileExports {
  path: string
  exports: string[]  // compact signature strings
}

function extractExports(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const exports: string[] = []

  // Match: export function name(...)
  const funcRegex = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g
  let m
  while ((m = funcRegex.exec(content)) !== null) {
    const name = m[1]
    const params = m[2].trim()
    // Simplify params: just keep names and types, truncate long ones
    const shortParams = params.length > 80 ? params.slice(0, 80) + '...' : params
    exports.push(`fn ${name}(${shortParams})`)
  }

  // Match: export const/let name
  const constRegex = /export\s+(?:const|let)\s+(\w+)(?:\s*:\s*([^=\n]+?))?(?:\s*=)/g
  while ((m = constRegex.exec(content)) !== null) {
    const name = m[1]
    const type = m[2]?.trim()
    if (type && type.length < 60) {
      exports.push(`const ${name}: ${type}`)
    } else {
      exports.push(`const ${name}`)
    }
  }

  // Match: export class/interface/type name
  const classRegex = /export\s+(?:abstract\s+)?(?:class|interface|type)\s+(\w+)/g
  while ((m = classRegex.exec(content)) !== null) {
    exports.push(`type ${m[1]}`)
  }

  // Match: export default function/class
  const defaultFuncRegex = /export\s+default\s+(?:async\s+)?function\s+(\w+)/g
  while ((m = defaultFuncRegex.exec(content)) !== null) {
    exports.push(`default fn ${m[1]}`)
  }

  // Match: export enum
  const enumRegex = /export\s+enum\s+(\w+)/g
  while ((m = enumRegex.exec(content)) !== null) {
    exports.push(`enum ${m[1]}`)
  }

  return exports
}

// Main
const files = walkFiles(repoPath)
const fileExports: FileExports[] = []

for (const f of files) {
  try {
    const exps = extractExports(f)
    if (exps.length > 0) {
      fileExports.push({
        path: path.relative(repoPath, f),
        exports: exps,
      })
    }
  } catch (e) {
    // skip
  }
}

// Sort by path
fileExports.sort((a, b) => a.path.localeCompare(b.path))

// Build directory tree (2-level)
const dirTree = new Map<string, Set<string>>()
for (const f of fileExports) {
  const parts = f.path.split('/')
  if (parts.length >= 2) {
    const l1 = parts[0]
    const l2 = parts.length >= 3 ? parts[0] + '/' + parts[1] : null
    if (!dirTree.has(l1)) dirTree.set(l1, new Set())
    if (l2) dirTree.get(l1)!.add(l2)
  }
}

// Output
console.log(`# Project Export Map`)
console.log(`# ${fileExports.length} files with exports, ${files.length} total files\n`)

// Group by 2-level directory
const grouped = new Map<string, FileExports[]>()
for (const f of fileExports) {
  const parts = f.path.split('/')
  const dir = parts.length >= 3
    ? parts[0] + '/' + parts[1]
    : parts.length >= 2
    ? parts[0]
    : '.'
  if (!grouped.has(dir)) grouped.set(dir, [])
  grouped.get(dir)!.push(f)
}

// Sort dirs by number of exports descending
const sortedDirs = [...grouped.entries()].sort((a, b) => {
  const aExports = a[1].reduce((s, f) => s + f.exports.length, 0)
  const bExports = b[1].reduce((s, f) => s + f.exports.length, 0)
  return bExports - aExports
})

for (const [dir, files] of sortedDirs) {
  const totalExports = files.reduce((s, f) => s + f.exports.length, 0)
  console.log(`\n## ${dir}/ (${files.length} files, ${totalExports} exports)`)
  for (const f of files) {
    const fileName = f.path.split('/').pop()
    console.log(`  ${fileName}: ${f.exports.join(', ')}`)
  }
}
