/**
 * cold-start.ts
 *
 * Pipeline：读代码文件 → (可选) 查图谱调用关系 → 调 claude CLI → 提取决策 → 写入 Memgraph
 *
 * Performance 优化（vs 原版）：
 * - claude 调用从 execSync 串行 → execAsync 并发（--concurrency 控制）
 * - 决策写入从逐条 MERGE → 批量 UNWIND
 * - Memgraph session 复用（一个 session 处理所有写入）
 *
 * 用法：
 *   npm run cold-start -- \
 *     --repo bite-me-website \
 *     --src /Users/zhouyitong/dev/bite/biteme-shared/src \
 *     --owner me \
 *     --concurrency 3
 */

import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { queryGraphContext, formatGraphContext } from '../db/graphContext'
import { Session } from 'neo4j-driver'

const args = process.argv.slice(2)
const getArg = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

const repo        = getArg('--repo')  ?? 'bite-me-website'
const srcDir      = getArg('--src')
const owner       = getArg('--owner') ?? 'unknown'
const dirsArg     = getArg('--dirs')
const concurrency = parseInt(getArg('--concurrency') ?? '3')

if (!srcDir) {
  console.error('用法: npm run cold-start -- --repo <n> --src <path> --owner <n> [--dirs a,b] [--concurrency 3]')
  process.exit(1)
}

const LOGIC_DIRS  = dirsArg ? dirsArg.split(',').map(d => d.trim()) : ['services', 'logic', 'utils', 'store', 'hooks', 'contexts']
const ALLOWED_EXT = ['.ts', '.tsx', '.js', '.jsx']
const MAX_FILE_CHARS = 12000

// ── Prompt ──────────────────────────────────────────────

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

// ── Claude 调用（async）──────────────────────────────────

function callClaudeAsync(code: string, filePath: string, graphSection: string): Promise<any[]> {
  return new Promise((resolve) => {
    const prompt = buildPrompt(code, filePath, graphSection)
    const tmpFile = `/tmp/ckg-${process.pid}-${Math.random().toString(36).slice(2)}.txt`
    fs.writeFileSync(tmpFile, prompt, 'utf-8')

    exec(
      `cat "${tmpFile}" | claude -p --tools "" --output-format json`,
      { encoding: 'utf-8', timeout: 90000 },
      (err, stdout) => {
        try { fs.unlinkSync(tmpFile) } catch {}
        if (err) { resolve([]); return }
        try {
          const wrapper = JSON.parse(stdout.trim())
          const raw: string = wrapper.result ?? ''
          const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
          const parsed = JSON.parse(cleaned)
          resolve(Array.isArray(parsed) ? parsed : [])
        } catch {
          resolve([])
        }
      }
    )
  })
}

// ── 单文件处理（提取，不写入）────────────────────────────

interface PendingDecision {
  id: string
  props: Record<string, any>
  anchorFileName: string
}

async function processFile(file: string, index: number, total: number): Promise<PendingDecision[]> {
  const relPath    = path.relative(path.dirname(srcDir!), file)
  const fileName   = path.basename(file)
  const fileNameJs = fileName.replace(/\.(ts|tsx)$/, '.js')

  const code = (() => {
    const c = fs.readFileSync(file, 'utf-8')
    return c.length > MAX_FILE_CHARS ? c.slice(0, MAX_FILE_CHARS) + '\n// [truncated]' : c
  })()

  if (code.length < 80) {
    console.log(`[${index}/${total}] ${fileName} — 跳过`)
    return []
  }

  const graph        = await queryGraphContext(fileNameJs)
  const graphSection = formatGraphContext(graph)
  const decisions    = await callClaudeAsync(code, relPath, graphSection)

  if (!decisions.length) {
    console.log(`[${index}/${total}] ${fileName} — 无决策`)
    return []
  }

  const graphHint = graph ? ` [↑${graph.calledBy.length} ↓${graph.calls.length}]` : ''
  console.log(`[${index}/${total}] ${fileName}${graphHint} — ${decisions.length} 条决策`)

  const now = new Date().toISOString()
  return decisions.map((dc: any, i: number) => ({
    id: `dc:cold:${path.basename(file, path.extname(file))}:${i}:${Date.now()}-${Math.random().toString(36).slice(2)}`,
    props: {
      summary: String(dc.summary ?? ''),
      content: String(dc.content ?? ''),
      keywords: Array.isArray(dc.keywords) ? dc.keywords : [],
      scope: [repo], owner,
      session_id: `cold-start-${now.slice(0, 10)}`,
      commit_hash: 'cold-start', source: 'cold_start',
      confidence: 'auto_generated', staleness: 'active',
      created_at: now, updated_at: now,
    },
    anchorFileName: fileNameJs,
  }))
}

// ── 并发控制 ────────────────────────────────────────────

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<any>
): Promise<any[]> {
  const results: any[] = []
  let next = 0

  async function worker() {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

// ── 批量写入 ────────────────────────────────────────────

async function batchWriteDecisions(session: Session, allDecisions: PendingDecision[]): Promise<number> {
  if (allDecisions.length === 0) return 0

  const BATCH = 50

  // 1. 批量写入 DecisionContext 节点
  for (let i = 0; i < allDecisions.length; i += BATCH) {
    const batch = allDecisions.slice(i, i + BATCH).map(d => ({ id: d.id, ...d.props }))
    await session.run(
      `UNWIND $batch AS d
       MERGE (n:DecisionContext {id: d.id})
       SET n += d`,
      { batch }
    )
  }

  // 2. 批量建锚定边
  let anchored = 0
  for (let i = 0; i < allDecisions.length; i += BATCH) {
    const batch = allDecisions.slice(i, i + BATCH).map(d => ({
      dcId: d.id,
      fileName: d.anchorFileName,
    }))
    const result = await session.run(
      `UNWIND $batch AS item
       MATCH (d:DecisionContext {id: item.dcId})
       MATCH (f:CodeEntity {entity_type: 'file', name: item.fileName})
       MERGE (d)-[:ANCHORED_TO]->(f)
       RETURN f.id`,
      { batch }
    )
    anchored += result.records.length
  }

  return anchored
}

// ── 主流程 ──────────────────────────────────────────────

async function coldStart(): Promise<void> {
  console.log(`\n🧊 冷启动  repo=${repo}  src=${srcDir}  concurrency=${concurrency}\n`)

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

  // 并发处理文件（LLM 调用）
  const startTime = Date.now()
  let fileIdx = 0
  const allDecisions: PendingDecision[] = []

  const fileResults = await runWithConcurrency(
    files,
    concurrency,
    async (file) => {
      const idx = ++fileIdx
      return processFile(file, idx, files.length)
    }
  )

  for (const decisions of fileResults) {
    allDecisions.push(...decisions)
  }

  const llmTime = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n🤖 LLM 提取完成: ${allDecisions.length} 条决策 (${llmTime}s)`)

  // 批量写入 Memgraph（一个 session）
  if (allDecisions.length > 0) {
    const writeStart = Date.now()
    const session = await getSession()
    try {
      const anchored = await batchWriteDecisions(session, allDecisions)
      const writeTime = ((Date.now() - writeStart) / 1000).toFixed(1)
      console.log(`📝 写入完成: ${allDecisions.length} 条决策, ${anchored} 条锚定 (${writeTime}s)`)
    } finally {
      await session.close()
    }
  }

  await closeDriver()
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n✅ 完成: ${allDecisions.length} 条决策 (总耗时 ${totalTime}s)`)
}

coldStart().catch(err => { console.error('失败:', err.message); process.exit(1) })
