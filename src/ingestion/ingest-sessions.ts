// @deprecated — use ingest-sessions-v2.ts instead
/**
 * ingest-sessions.ts
 *
 * 读取 ~/.claude/projects/ 下的 Claude Code session 记录，
 * 提取设计决策，写入 Memgraph。
 *
 * Performance 优化（vs 原版）：
 * - claude 调用从 execSync → exec 异步
 * - 所有决策收集完后批量写入（一个 session，UNWIND 批量）
 * - 支持 --concurrency 并发处理 session
 *
 * 运行方式：
 *   npm run ingest:sessions                                    # 处理所有新 session
 *   npm run ingest:sessions -- --project bite-me-website       # 只处理某个项目
 *   npm run ingest:sessions -- --since 2026-03-01              # 只处理某个日期之后的
 *   npm run ingest:sessions -- --concurrency 3                 # 并发数（默认 2）
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { exec } from 'child_process'
import { getSession, verifyConnectivity, closeDriver } from '../db/client'
import { createPendingEdges } from './connect-decisions'
import { queryGraphContext, formatGraphContext } from '../db/graphContext'
import { Session } from 'neo4j-driver'

// ── 常量 ────────────────────────────────────────────────
const CLAUDE_DIR    = path.join(os.homedir(), '.claude', 'projects')
const STATE_FILE    = path.join(__dirname, '../../data/ingested-sessions.json')

// ── CLI 参数 ────────────────────────────────────────────
const args         = process.argv.slice(2)
const getArg       = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null }
const targetProject = getArg('--project')
const sinceDate     = getArg('--since')
const owner         = getArg('--owner') ?? 'me'
const concurrency   = parseInt(getArg('--concurrency') ?? '2')

// ── 状态 ────────────────────────────────────────────────
function loadProcessed(): Set<string> {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')).processed) }
  catch { return new Set() }
}

function saveProcessed(s: Set<string>) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify({ processed: [...s] }, null, 2))
}

// ── 解析 JSONL ──────────────────────────────────────────
interface Turn { role: 'user' | 'assistant'; text: string; timestamp: string }

function parseJsonl(filePath: string): { turns: Turn[]; cwd: string; sessionId: string } {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
  const turns: Turn[] = []
  let cwd = '', sessionId = ''

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.cwd && !cwd)           cwd = obj.cwd
      if (obj.sessionId && !sessionId) sessionId = obj.sessionId
      if (!obj.type || obj.type === 'file-history-snapshot' || obj.type === 'progress') continue
      if (obj.isMeta) continue

      const msg = obj.message
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue

      let text = ''
      if (typeof msg.content === 'string') {
        text = msg.content
      } else if (Array.isArray(msg.content)) {
        text = msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
      }

      text = text.replace(/<[^>]+>/g, '').trim()
      if (text.length < 30) continue
      turns.push({ role: msg.role, text: text.slice(0, 1000), timestamp: obj.timestamp ?? '' })
    } catch { continue }
  }

  return { turns, cwd, sessionId }
}

function projectNameFromDir(dirName: string): string {
  const parts = dirName.split('-').filter(Boolean)
  return parts.slice(-3).join('-')
}

// ── Prompt ──────────────────────────────────────────────

function buildPrompt(turns: Turn[], projectName: string, graphSection: string): string {
  const dialogue = turns
    .slice(-20)
    .map(t => `${t.role === 'user' ? 'User' : 'Claude'}: ${t.text}`)
    .join('\n\n')

  return `Analyze this Claude Code session and extract 0-3 design decisions.

Project: ${projectName}
${graphSection}
Session:
${dialogue}

A design decision is WHY an approach was chosen, trade-offs discussed, or choices made (including decisions NOT to do something).
Skip trivial syntax fixes or test runs with no architectural insight.

Return ONLY raw JSON (empty array [] if no decisions worth recording):
[{"summary":"one line under 15 words","content":"explanation 100-300 chars","keywords":["kw1","kw2"],"file":"filename.js or null"}]`
}

// ── Claude 调用（async）──────────────────────────────────

function extractDecisionsAsync(turns: Turn[], projectName: string, graphSection: string): Promise<any[]> {
  if (turns.length < 3) return Promise.resolve([])

  return new Promise((resolve) => {
    const prompt = buildPrompt(turns, projectName, graphSection)
    const tmp = `/tmp/ckg-sess-${process.pid}-${Math.random().toString(36).slice(2)}.txt`
    fs.writeFileSync(tmp, prompt)

    exec(`cat "${tmp}" | claude -p --tools "" --output-format json`, {
      encoding: 'utf-8', timeout: 90000,
    }, (err, stdout) => {
      try { fs.unlinkSync(tmp) } catch {}
      if (err) { resolve([]); return }
      try {
        const raw = JSON.parse(stdout.trim()).result ?? ''
        const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
        const parsed = JSON.parse(cleaned)
        resolve(Array.isArray(parsed) ? parsed : [])
      } catch { resolve([]) }
    })
  })
}

// ── 批量写入 ────────────────────────────────────────────

interface PendingDecision {
  id: string
  props: Record<string, any>
  anchorFileName: string | null
}

async function batchWriteDecisions(session: Session, decisions: PendingDecision[]): Promise<number> {
  if (decisions.length === 0) return 0
  const BATCH = 50

  // 1. 批量写节点
  for (let i = 0; i < decisions.length; i += BATCH) {
    const batch = decisions.slice(i, i + BATCH).map(d => ({ id: d.id, ...d.props }))
    await session.run(
      `UNWIND $batch AS d
       MERGE (n:DecisionContext {id: d.id})
       SET n += d`,
      { batch }
    )
  }

  // 2. 批量锚定（只处理有文件名的）
  const withAnchor = decisions.filter(d => d.anchorFileName)
  let anchored = 0
  for (let i = 0; i < withAnchor.length; i += BATCH) {
    const batch = withAnchor.slice(i, i + BATCH).map(d => ({
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

// ── 主流程 ──────────────────────────────────────────────
async function main() {
  console.log(`\n📼 Claude Code Session 摄入  concurrency=${concurrency}\n`)

  if (!fs.existsSync(CLAUDE_DIR)) {
    console.error(`找不到 ${CLAUDE_DIR}，请确认 Claude Code 已安装并使用过`)
    process.exit(1)
  }

  await verifyConnectivity()
  const processed = loadProcessed()

  // 收集要处理的文件
  const toProcess: { filePath: string; projectName: string }[] = []
  const since = sinceDate ? new Date(sinceDate) : null

  for (const dir of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true }).filter(e => e.isDirectory())) {
    const projectName = projectNameFromDir(dir.name)
    if (targetProject && !dir.name.includes(targetProject)) continue

    const dirPath = path.join(CLAUDE_DIR, dir.name)
    for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))) {
      const sessionId = file.replace('.jsonl', '')
      if (processed.has(sessionId)) continue

      const filePath = path.join(dirPath, file)
      if (since) {
        const stat = fs.statSync(filePath)
        if (stat.mtime < since) continue
      }

      toProcess.push({ filePath, projectName })
    }
  }

  if (toProcess.length === 0) {
    console.log('没有新的 session 需要处理（所有 session 已处理过）')
    await closeDriver()
    return
  }

  console.log(`找到 ${toProcess.length} 个新 session\n`)

  const startTime = Date.now()
  const allDecisions: PendingDecision[] = []

  // 并发处理 sessions
  await runWithConcurrency(toProcess, concurrency, async ({ filePath, projectName }) => {
    const { turns, sessionId } = parseJsonl(filePath)
    const shortId = sessionId.slice(0, 8)

    if (turns.length < 3) {
      console.log(`[${shortId}] ${projectName} — 跳过（对话太短）`)
      processed.add(sessionId)
      return
    }

    const mentionedFile = turns
      .flatMap(t => t.text.match(/\b[\w-]+\.(js|ts|tsx|jsx)\b/g) ?? [])
      .find(f => !f.startsWith('node_'))
    const graph = mentionedFile ? await queryGraphContext(mentionedFile.replace(/\.(ts|tsx)$/, '.js')) : null
    const graphSection = formatGraphContext(graph)

    const decisions = await extractDecisionsAsync(turns, projectName, graphSection)
    processed.add(sessionId)

    if (decisions.length === 0) {
      console.log(`[${shortId}] ${projectName} (${turns.length} 轮) — 无决策`)
      return
    }

    const now = new Date().toISOString()
    for (let i = 0; i < decisions.length; i++) {
      const dc = decisions[i]
      allDecisions.push({
        id: `dc:sess:${sessionId.slice(0, 8)}:${i}:${Date.now()}`,
        props: {
          summary: String(dc.summary ?? ''),
          content: String(dc.content ?? ''),
          keywords: Array.isArray(dc.keywords) ? dc.keywords : [],
          scope: [projectName], owner,
          session_id: sessionId,
          commit_hash: 'session-extract',
          source: 'claude_code_session',
          confidence: 'auto_generated',
          staleness: 'active',
          created_at: now, updated_at: now,
        },
        anchorFileName: dc.file ? String(dc.file).replace(/\.(ts|tsx)$/, '.js') : null,
      })
    }

    console.log(`[${shortId}] ${projectName} (${turns.length} 轮) — ${decisions.length} 条决策`)
  })

  const llmTime = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n🤖 LLM 提取完成: ${allDecisions.length} 条决策 (${llmTime}s)`)

  // 批量写入
  if (allDecisions.length > 0) {
    const writeStart = Date.now()
    const session = await getSession()
    try {
      const anchored = await batchWriteDecisions(session, allDecisions)
      // Create PENDING edges so grouping pipeline can discover relationships
      const newIds = allDecisions.map(d => d.id)
      await createPendingEdges(session, newIds, { verbose: true })
      const writeTime = ((Date.now() - writeStart) / 1000).toFixed(1)
      console.log(`📝 写入完成: ${allDecisions.length} 条, ${anchored} 条锚定 (${writeTime}s)`)
    } finally {
      await session.close()
    }
  }

  saveProcessed(processed)
  await closeDriver()
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n✅ 完成: ${allDecisions.length} 条决策 (总耗时 ${totalTime}s)`)
}

main().catch(err => { console.error('失败:', err.message); process.exit(1) })
