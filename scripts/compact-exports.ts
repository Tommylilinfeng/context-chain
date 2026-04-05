/**
 * Compress export map: just dir → file → export names (no signatures)
 * Target: <30KB for LLM prompt
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

function extractExportNames(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const names: string[] = []

  // export function/const/class/interface/type/enum
  const regex = /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|abstract\s+class|interface|type|enum)\s+(\w+)/g
  let m
  while ((m = regex.exec(content)) !== null) {
    names.push(m[1])
  }
  return [...new Set(names)]
}

const files = walkFiles(repoPath)

// Group by 2-level dir
const grouped = new Map<string, Map<string, string[]>>()
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
    if (!grouped.has(dir)) grouped.set(dir, new Map())
    grouped.get(dir)!.set(fileName, exports)
  } catch {}
}

// Output compact format
const lines: string[] = []
lines.push(`Project: claude-code (${files.length} TS/TSX files)`)
lines.push(``)

// Sort by export count
const sorted = [...grouped.entries()].sort((a, b) => {
  const aCount = [...a[1].values()].reduce((s, v) => s + v.length, 0)
  const bCount = [...b[1].values()].reduce((s, v) => s + v.length, 0)
  return bCount - aCount
})

for (const [dir, fileMap] of sorted) {
  const totalExports = [...fileMap.values()].reduce((s, v) => s + v.length, 0)
  lines.push(`[${dir}/] ${fileMap.size} files, ${totalExports} exports`)
  for (const [file, exports] of fileMap) {
    lines.push(`  ${file}: ${exports.join(', ')}`)
  }
}

const output = lines.join('\n')
fs.writeFileSync('/tmp/claude-code-export-names.txt', output)
console.log(`Output: ${output.length} bytes, ${lines.length} lines`)
