/**
 * cold-start.ts
 *
 * Pipeline：读代码文件 → (可选) 查图谱调用关系 → 调 claude CLI → 提取决策 → 写入 Memgraph
 *
 * 用法：
 *   npm run cold-start -- \
 *     --repo bite-me-website \
 *     --src /Users/zhouyitong/dev/bite/biteme-shared/src \
 *     --owner me
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { queryGraphContext, formatGraphContext } from '../db/graphContext'

const args = process.argv.slice(2)
const getArg = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

const repo   = getArg('--repo')  ?? 'bite-me-website'
const srcDir = getArg('--src')
const owner  = getArg('--owner') ?? 'unknown'

if (!srcDir) { console.error('用法: npm run cold-start -- --repo <n> --src <path> --owner <n>'); process.exit(1) }

const LOGIC_DIRS  = ['services', 'logic', 'utils', 'store', 'hooks', 'contexts']
const ALLOWED_EXT = ['.ts', '.tsx', '.js', '.jsx']
const MAX_FILE_CHARS = 12000

function buildPrompt(code: string, filePath: string, graphSection: string): string {
  return `Analyze this source file and extract 1-3 important design decisions.

File: ${filePath}
${graphSection}
A "design decision" explains WHY this approach was chosen over alternatives, WHY edge cases are handled specially, WHY a data structure is designed a certain way, and what trade-offs were made.

NOT a design decision: obvious implementation details or simple descriptions of what the code does.

Source code:
${code}

Return ONLY a raw JSON array (no markdown, no backticks, no explanation):
[{"summary":"one line under 15 words","content":"detailed explanation 100-300 chars","keywords":["kw1","kw2","kw3"]}]`
}

function callClaude(code: string, filePath: string, graphSection: string): any[] {
  try {
    const prompt = buildPrompt(code, filePath, graphSection)
    const tmpFile = `/tmp/ckg-${process.pid}-${Math.random().toString(36).slice(2)}.txt`
    fs.writeFileSync(tmpFile, prompt, 'utf-8')

    const output = execSync(
      `cat "${tmpFile}" | claude -p --tools "" --output-format json`,
      { encoding: 'utf-8', timeout: 90000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    fs.unlinkSync(tmpFile)

    const wrapper = JSON.parse(output.trim())
    const raw: string = wrapper.result ?? ''
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function processFile(file: string, index: number, total: number): Promise<{ decisions: number; anchored: number }> {
  const relPath    = path.relative(path.dirname(srcDir!), file)
  const fileName   = path.basename(file)
  const fileNameJs = fileName.replace(/\.(ts|tsx)$/, '.js')

  const code = (() => {
    const c = fs.readFileSync(file, 'utf-8')
    return c.length > MAX_FILE_CHARS ? c.slice(0, MAX_FILE_CHARS) + '\n// [truncated]' : c
  })()

  if (code.length < 80) {
    console.log(`[${index}/${total}] ${fileName} — 跳过`)
    return { decisions: 0, anchored: 0 }
  }

  const graph        = await queryGraphContext(fileNameJs)
  const graphSection = formatGraphContext(graph)
  const decisions    = callClaude(code, relPath, graphSection)

  if (!decisions.length) {
    console.log(`[${index}/${total}] ${fileName} — 无决策`)
    return { decisions: 0, anchored: 0 }
  }

  const session = await getSession()
  const now = new Date().toISOString()
  let anchored = 0

  try {
    for (let i = 0; i < decisions.length; i++) {
      const dc = decisions[i]
      const id = `dc:cold:${path.basename(file, path.extname(file))}:${i}:${Date.now()}-${Math.random().toString(36).slice(2)}`

      await session.run(
        `MERGE (d:DecisionContext {id: $id}) SET d += $props`,
        { id, props: {
          summary: String(dc.summary ?? ''),
          content: String(dc.content ?? ''),
          keywords: Array.isArray(dc.keywords) ? dc.keywords : [],
          scope: [repo], owner,
          session_id: `cold-start-${now.slice(0, 10)}`,
          commit_hash: 'cold-start', source: 'cold_start',
          confidence: 'auto_generated', staleness: 'active',
          created_at: now, updated_at: now,
        }}
      )

      const r = await session.run(
        `MATCH (d:DecisionContext {id: $id})
         MATCH (f:CodeEntity {entity_type: 'file', name: $name})
         MERGE (d)-[:ANCHORED_TO]->(f) RETURN f.id`,
        { id, name: fileNameJs }
      )
      if (r.records.length > 0) anchored++
    }
  } finally {
    await session.close()
  }

  const graphHint = graph ? ` [↑${graph.calledBy.length} ↓${graph.calls.length}]` : ''
  console.log(`[${index}/${total}] ${fileName}${graphHint} — ${decisions.length} 条决策，${anchored} 条锚定`)
  return { decisions: decisions.length, anchored }
}

async function coldStart(): Promise<void> {
  console.log(`\n🧊 冷启动  repo=${repo}  src=${srcDir}\n`)

  const files = (() => {
    const results: string[] = []
    function walk(dir: string) {
      if (!fs.existsSync(dir)) return
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'generated') walk(full)
        else if (e.isFile() && ALLOWED_EXT.includes(path.extname(e.name))) {
          const parts = path.relative(srcDir!, full).split(path.sep)
          if (parts.some(p => LOGIC_DIRS.includes(p))) results.push(full)
        }
      }
    }
    walk(srcDir!)
    return results
  })()

  console.log(`找到 ${files.length} 个文件\n`)
  await verifyConnectivity()

  let totalDecisions = 0, totalAnchored = 0

  for (let i = 0; i < files.length; i++) {
    const r = await processFile(files[i], i + 1, files.length)
    totalDecisions += r.decisions
    totalAnchored  += r.anchored
  }

  await closeDriver()
  console.log(`\n✅ 完成：${totalDecisions} 条决策，${totalAnchored} 条锚定`)
}

coldStart().catch(err => { console.error('失败:', err.message); process.exit(1) })
